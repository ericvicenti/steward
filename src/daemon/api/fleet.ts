// Fleet v1: pragmatic node pairing + request proxying.
//
// Pairing exchanges each node's API token over a direct HTTP call, gated by a
// short-lived 6-digit code the user carries between the two UIs. This trusts
// the local network during the pairing window; the ed25519 mutual-auth
// handshake from docs/FLEET.md replaces it in a later milestone.
import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { networkInterfaces } from "os";
import { randomBytes, randomInt, timingSafeEqual } from "crypto";
import type { StewardConfig } from "../config";
import { currentCommit, nudgePeer, maybeSelfUpdate } from "../updater";

export type NodeRow = {
  id: string;
  name: string;
  url: string;
  token: string;
  added_at: number;
  last_seen: number | null;
};

const PAIRING_TTL_MS = 5 * 60 * 1000;
let pairing: { code: string; expiresAt: number } | null = null;

function codeMatches(given: string): boolean {
  if (!pairing || Date.now() > pairing.expiresAt) return false;
  const a = Buffer.from(pairing.code);
  const b = Buffer.from(String(given));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function lanUrls(port: number): string[] {
  const urls: string[] = [];
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) urls.push(`http://${iface.address}:${port}`);
    }
  }
  return urls;
}

async function peerFetch(node: NodeRow, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${node.url}${path}`, {
    ...init,
    headers: { ...(init?.headers as Record<string, string>), authorization: `Bearer ${node.token}` },
    signal: init?.signal ?? AbortSignal.timeout(15_000),
  });
}

export function registerFleetRoutes(
  app: Hono,
  db: Database,
  cfg: StewardConfig,
  nodeId: string,
  myToken: string,
  upgradeWebSocket: any
) {
  const getNode = (id: string): NodeRow | null =>
    (db.query("SELECT * FROM nodes WHERE id = ?").get(id) as NodeRow) ?? null;

  app.get("/api/fleet/self", (c) =>
    c.json({ nodeId, name: cfg.nodeName, port: cfg.port, urls: lanUrls(cfg.port) })
  );

  app.post("/api/fleet/pairing/start", (c) => {
    pairing = {
      code: String(randomInt(0, 1_000_000)).padStart(6, "0"),
      expiresAt: Date.now() + PAIRING_TTL_MS,
    };
    return c.json({ code: pairing.code, expiresAt: pairing.expiresAt, urls: lanUrls(cfg.port) });
  });

  // Called BY the other node (unauthenticated; gated by the one-time code).
  app.post("/api/fleet/pairing/complete", async (c) => {
    const body = await c.req.json();
    if (!codeMatches(body.code)) return c.json({ error: "invalid or expired pairing code" }, 403);
    pairing = null; // single use
    if (!body.nodeId || !body.url || !body.token) return c.json({ error: "missing fields" }, 400);
    db.query(
      `INSERT INTO nodes (id, name, url, token, added_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, url=excluded.url, token=excluded.token`
    ).run(body.nodeId, String(body.name ?? "node"), String(body.url), String(body.token), Date.now());
    return c.json({ nodeId, name: cfg.nodeName, token: myToken, urls: lanUrls(cfg.port) });
  });

  // Initiate pairing from this side: we call the peer's /complete.
  app.post("/api/fleet/pair", async (c) => {
    const body = await c.req.json(); // { url, code }
    const peerUrl = String(body.url ?? "").replace(/\/+$/, "");
    if (!/^https?:\/\//.test(peerUrl)) return c.json({ error: "url must start with http://" }, 400);
    // Advertise a URL the peer can reach us at: prefer the LAN address that
    // shares a prefix with the peer's, else first LAN address.
    const myUrls = lanUrls(cfg.port);
    const peerHost = new URL(peerUrl).hostname;
    const myUrl =
      myUrls.find((u) => new URL(u).hostname.split(".").slice(0, 3).join(".") === peerHost.split(".").slice(0, 3).join(".")) ??
      myUrls[0] ??
      `http://127.0.0.1:${cfg.port}`;
    let res: Response;
    try {
      res = await fetch(`${peerUrl}/api/fleet/pairing/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: String(body.code ?? ""), nodeId, name: cfg.nodeName, url: myUrl, token: myToken }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      return c.json({ error: `could not reach ${peerUrl}: ${err instanceof Error ? err.message : err}` }, 502);
    }
    const peer = await res.json();
    if (!res.ok) return c.json({ error: peer.error ?? `pairing failed (${res.status})` }, 502);
    db.query(
      `INSERT INTO nodes (id, name, url, token, added_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, url=excluded.url, token=excluded.token`
    ).run(peer.nodeId, String(peer.name ?? "node"), peerUrl, String(peer.token), Date.now());
    return c.json({ paired: { id: peer.nodeId, name: peer.name, url: peerUrl } });
  });

  app.get("/api/fleet/nodes", async (c) => {
    const rows = db.query("SELECT id, name, url, added_at, last_seen FROM nodes ORDER BY name").all() as Omit<NodeRow, "token">[];
    // Probe reachability + pull summary stats concurrently. The race timer is
    // a HARD bound: AbortSignal cannot cancel a stuck DNS/mDNS lookup (e.g. an
    // offline peer.local hostname), which would otherwise hang this request.
    const nodes = await Promise.all(
      rows.map(async (r) => {
        try {
          const node = getNode(r.id)!;
          const status = await Promise.race([
            (async () => {
              const res = await peerFetch(node, "/api/status", { signal: AbortSignal.timeout(3000) });
              if (!res.ok) throw new Error(String(res.status));
              return res.json();
            })(),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("probe timeout")), 3500)),
          ]);
          db.query("UPDATE nodes SET last_seen = ? WHERE id = ?").run(Date.now(), r.id);
          // Fleet convergence: a peer on a different commit gets nudged to
          // update (it no-ops if it is not behind origin), and we check
          // ourselves too. Both are rate-limited.
          if (cfg.autoUpdate && status.commit && status.commit !== (await currentCommit())) {
            nudgePeer(getNode(r.id)!);
            maybeSelfUpdate(`peer ${r.name} is on ${status.commit}`);
          }
          return { ...r, online: true, status };
        } catch {
          return { ...r, online: false, status: null };
        }
      })
    );
    return c.json({ self: { nodeId, name: cfg.nodeName, urls: lanUrls(cfg.port), commit: await currentCommit() }, nodes });
  });

  app.delete("/api/fleet/nodes/:id", (c) => {
    db.query("DELETE FROM nodes WHERE id = ?").run(c.req.param("id"));
    return c.json({ removed: true });
  });

  // HTTP proxy: /api/nodes/:id/proxy/<rest> -> peer /api/<rest>
  app.all("/api/nodes/:id/proxy/*", async (c) => {
    const node = getNode(c.req.param("id"));
    if (!node) return c.json({ error: "unknown node" }, 404);
    const rest = c.req.path.split("/proxy/")[1] ?? "";
    const qs = new URL(c.req.url).search;
    // Strip our token from forwarded query strings; peer auth is via header.
    const cleanQs = qs ? "?" + new URLSearchParams([...new URLSearchParams(qs.slice(1))].filter(([k]) => k !== "token")).toString() : "";
    try {
      const fwdHeaders: Record<string, string> = {
        "content-type": c.req.header("content-type") ?? "application/json",
      };
      const range = c.req.header("range");
      if (range) fwdHeaders["range"] = range;
      const res = await peerFetch(node, `/api/${rest}${cleanQs}`, {
        method: c.req.method,
        headers: fwdHeaders,
        body: ["GET", "HEAD"].includes(c.req.method) ? undefined : await c.req.arrayBuffer(),
        signal: AbortSignal.timeout(60_000),
      });
      const outHeaders: Record<string, string> = {
        "content-type": res.headers.get("content-type") ?? "application/octet-stream",
      };
      for (const h of ["content-disposition", "content-range", "accept-ranges", "content-length"]) {
        const v = res.headers.get(h);
        if (v) outHeaders[h] = v;
      }
      return new Response(res.body, { status: res.status, headers: outHeaders });
    } catch (err) {
      return c.json({ error: `proxy to ${node.name} failed: ${err instanceof Error ? err.message : err}` }, 502);
    }
  });

  // WebSocket terminal proxy: pipe browser <-> peer /api/term.
  app.get(
    "/api/nodes/:id/term",
    upgradeWebSocket((c: any) => {
      const node = getNode(c.req.param("id"));
      const cwd = c.req.query("cwd");
      let peer: WebSocket | null = null;
      const pending: string[] = [];
      return {
        onOpen(_ev: unknown, ws: { send: (s: string) => void; close: () => void }) {
          if (!node) {
            ws.send(JSON.stringify({ t: "data", data: "\r\nunknown node\r\n" }));
            ws.close();
            return;
          }
          const wsUrl = node.url.replace(/^http/, "ws") + `/api/term?token=${encodeURIComponent(node.token)}${cwd ? `&cwd=${encodeURIComponent(cwd)}` : ""}`;
          peer = new WebSocket(wsUrl);
          peer.onopen = () => {
            for (const msg of pending.splice(0)) peer!.send(msg);
          };
          peer.onmessage = (m) => ws.send(String(m.data));
          peer.onclose = () => ws.close();
          peer.onerror = () => {
            ws.send(JSON.stringify({ t: "data", data: `\r\ncould not reach ${node.name}\r\n` }));
            ws.close();
          };
        },
        onMessage(ev: { data: unknown }) {
          const msg = String(ev.data);
          if (peer && peer.readyState === WebSocket.OPEN) peer.send(msg);
          else pending.push(msg);
        },
        onClose() {
          try {
            peer?.close();
          } catch {}
          peer = null;
        },
      };
    })
  );
}
