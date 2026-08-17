import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import { serveStatic } from "hono/bun";
import { readdirSync, statSync, realpathSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { Database } from "bun:sqlite";
import type { StewardConfig } from "./config";
import { bus } from "./events";
import { runScan, isScanRunning } from "./indexer/scan";
import type { RepoRow } from "./db";

const UI_DIST = join(import.meta.dir, "../../dist/ui");
export const VERSION = "0.1.0";

export function createServer(db: Database, cfg: StewardConfig, token: string) {
  const { upgradeWebSocket, websocket } = createBunWebSocket();
  const app = new Hono();

  const authed = (c: { req: { header: (h: string) => string | undefined; query: (k: string) => string | undefined } }) => {
    const header = c.req.header("authorization");
    if (header === `Bearer ${token}`) return true;
    return c.req.query("token") === token;
  };

  app.use("/api/*", async (c, next) => {
    if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  app.get("/api/status", (c) => {
    const counts = db
      .query(
        `SELECT
           COUNT(*) AS repos,
           SUM(risk = 'at-risk') AS atRisk,
           SUM(risk = 'attention') AS attention,
           SUM(risk = 'safe') AS safe,
           SUM(junk_bytes) AS junkBytes,
           MAX(scanned_at) AS lastScanAt
         FROM repos`
      )
      .get() as Record<string, number | null>;
    return c.json({
      nodeName: cfg.nodeName,
      version: VERSION,
      roots: cfg.roots,
      scanning: isScanRunning(),
      ...counts,
    });
  });

  app.get("/api/repos", (c) => {
    const rows = db.query("SELECT * FROM repos ORDER BY path").all() as RepoRow[];
    return c.json(
      rows.map((r) => ({
        ...r,
        remotes: JSON.parse(r.remotes),
        risk_reasons: JSON.parse(r.risk_reasons),
      }))
    );
  });

  app.post("/api/scan", (c) => {
    if (!isScanRunning()) {
      runScan(db, cfg).catch((err) => console.error("scan error:", err));
    }
    return c.json({ started: true });
  });

  app.get("/api/fs", (c) => {
    const requested = c.req.query("path") ?? homedir();
    let path: string;
    try {
      path = realpathSync(requested);
    } catch {
      return c.json({ error: "not found" }, 404);
    }
    if (!path.startsWith(homedir())) {
      return c.json({ error: "outside home directory" }, 403);
    }
    const entries = readdirSync(path, { withFileTypes: true })
      .filter((e) => !e.name.startsWith("."))
      .map((e) => {
        let size = 0;
        let mtime = 0;
        try {
          const s = statSync(join(path, e.name));
          size = s.size;
          mtime = s.mtimeMs;
        } catch {}
        return { name: e.name, dir: e.isDirectory(), size, mtime };
      })
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    return c.json({ path, entries });
  });

  app.get(
    "/api/events",
    upgradeWebSocket((c) => {
      if (!authed(c)) return {}; // no handlers; socket opens but receives nothing
      let unsub = () => {};
      return {
        onOpen(_ev, ws) {
          unsub = bus.subscribe((event) => ws.send(JSON.stringify(event)));
        },
        onClose() {
          unsub();
        },
      };
    })
  );

  app.use("/*", serveStatic({ root: UI_DIST }));
  app.get("*", serveStatic({ path: join(UI_DIST, "index.html") }));

  return { fetch: app.fetch, websocket };
}
