import { useEffect, useState } from "react";
import { api, post, navigate, setActiveNode, fmtBytes, fmtAgo, ApiError } from "../lib/api";
import { ServerIcon, FolderIcon, TerminalIcon, GitIcon } from "../lib/icons";

type NodeStatus = {
  nodeName: string;
  version: string;
  repos: number | null;
  atRisk: number | null;
  attention: number | null;
  junkBytes: number | null;
  lastScanAt: number | null;
};
type FleetNode = {
  id: string;
  name: string;
  url: string;
  added_at: number;
  last_seen: number | null;
  online: boolean;
  status: NodeStatus | null;
};
type FleetInfo = {
  self: { nodeId: string; name: string; urls: string[] };
  nodes: FleetNode[];
};
type PairingCode = { code: string; expiresAt: number; urls: string[] };

function NodeCard(props: {
  name: string;
  subtitle: string;
  online: boolean;
  status: NodeStatus | null;
  isSelf?: boolean;
  onBrowse?: () => void;
  onTerminal?: () => void;
  onRepos?: () => void;
  onUnpair?: () => void;
}) {
  const s = props.status;
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className={`rounded-lg p-2 ${props.online ? "bg-emerald-500/10 text-emerald-400" : "bg-zinc-800 text-zinc-500"}`}>
            <ServerIcon size={18} />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-zinc-100">
              {props.name}
              {props.isSelf && <span className="ml-2 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">this machine</span>}
            </div>
            <div className="truncate text-[11px] text-zinc-500">{props.subtitle}</div>
          </div>
        </div>
        <span className={`mt-1 flex items-center gap-1.5 text-[11px] ${props.online ? "text-emerald-400" : "text-zinc-500"}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${props.online ? "bg-emerald-400" : "bg-zinc-600"}`} />
          {props.online ? "online" : "offline"}
        </span>
      </div>

      {s && (
        <div className="mt-3 grid grid-cols-4 gap-2 text-center">
          {[
            ["repos", s.repos ?? 0, "text-zinc-200"],
            ["at risk", s.atRisk ?? 0, s.atRisk ? "text-red-400" : "text-emerald-400"],
            ["attention", s.attention ?? 0, s.attention ? "text-amber-400" : "text-emerald-400"],
            ["junk", s.junkBytes ? fmtBytes(s.junkBytes) : "0", "text-zinc-400"],
          ].map(([label, value, cls]) => (
            <div key={String(label)} className="rounded-lg bg-zinc-900/80 px-1 py-2">
              <div className={`text-sm font-semibold tabular-nums ${cls}`}>{String(value)}</div>
              <div className="text-[9px] uppercase tracking-wider text-zinc-600">{String(label)}</div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-1.5">
        {props.onRepos && (
          <button onClick={props.onRepos} disabled={!props.online} className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-40">
            <GitIcon size={13} /> Repos
          </button>
        )}
        {props.onBrowse && (
          <button onClick={props.onBrowse} disabled={!props.online} className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-40">
            <FolderIcon size={13} /> Files
          </button>
        )}
        {props.onTerminal && (
          <button onClick={props.onTerminal} disabled={!props.online} className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-40">
            <TerminalIcon size={13} /> Shell
          </button>
        )}
        {props.onUnpair && (
          <button onClick={props.onUnpair} className="ml-auto rounded-lg px-2.5 py-1.5 text-[11px] text-zinc-600 hover:bg-red-950/40 hover:text-red-400">
            Unpair
          </button>
        )}
      </div>
    </div>
  );
}

export function Fleet({ onLocked }: { onLocked: () => void }) {
  const [info, setInfo] = useState<FleetInfo | null>(null);
  const [selfStatus, setSelfStatus] = useState<NodeStatus | null>(null);
  const [code, setCode] = useState<PairingCode | null>(null);
  const [peerUrl, setPeerUrl] = useState("");
  const [peerCode, setPeerCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const load = async () => {
    try {
      const [f, s] = await Promise.all([api<FleetInfo>("/api/fleet/nodes"), api<NodeStatus>("/api/status")]);
      setInfo(f);
      setSelfStatus(s);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onLocked();
    }
  };

  useEffect(() => {
    load();
    const iv = setInterval(load, 15_000);
    return () => clearInterval(iv);
  }, []);

  const goto = (id: string, name: string, view: string) => {
    setActiveNode(id, name);
    navigate(view);
  };

  const pair = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await post<{ paired: { name: string } }>("/api/fleet/pair", { url: peerUrl.trim(), code: peerCode.trim() });
      setMsg({ kind: "ok", text: `Paired with ${res.paired.name}. It can now be managed from here (and vice versa).` });
      setPeerUrl("");
      setPeerCode("");
      load();
    } catch (err) {
      setMsg({ kind: "err", text: String(err instanceof Error ? err.message : err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
        <h1 className="text-lg font-semibold text-zinc-100">Fleet</h1>
        <p className="mt-0.5 text-xs text-zinc-500">Every machine running Steward. Pair them and manage any node from any other.</p>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <NodeCard
            name={info?.self.name ?? "…"}
            subtitle={info?.self.urls.join("  ·  ") || "no LAN address"}
            online
            isSelf
            status={selfStatus}
            onRepos={() => goto("", "", "data")}
            onBrowse={() => goto("", "", "files")}
            onTerminal={() => goto("", "", "term")}
          />
          {info?.nodes.map((n) => (
            <NodeCard
              key={n.id}
              name={n.name}
              subtitle={`${n.url} · paired ${fmtAgo(n.added_at)}${n.last_seen ? ` · seen ${fmtAgo(n.last_seen)}` : ""}`}
              online={n.online}
              status={n.status}
              onRepos={() => goto(n.id, n.name, "data")}
              onBrowse={() => goto(n.id, n.name, "files")}
              onTerminal={() => goto(n.id, n.name, "term")}
              onUnpair={async () => {
                await api(`/api/fleet/nodes/${n.id}`, { method: "DELETE" });
                load();
              }}
            />
          ))}
        </div>

        {/* pairing */}
        <h2 className="mt-8 text-sm font-semibold text-zinc-200">Add a machine</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
            <div className="text-[13px] font-medium text-zinc-200">On this machine</div>
            <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
              Generate a pairing code, then enter it (with one of the addresses below) on the other machine's Fleet page.
            </p>
            {code ? (
              <div className="mt-3">
                <div className="text-center font-mono text-3xl font-bold tracking-[0.3em] text-emerald-400" data-testid="pairing-code">
                  {code.code}
                </div>
                <div className="mt-2 text-center text-[11px] text-zinc-500">
                  valid 5 min · reach me at{" "}
                  <span className="font-mono text-zinc-300">{code.urls.join("  or  ") || "…"}</span>
                </div>
              </div>
            ) : (
              <button
                onClick={async () => setCode(await post<PairingCode>("/api/fleet/pairing/start", {}))}
                data-testid="show-code-btn"
                className="mt-3 w-full rounded-lg bg-emerald-600 py-2 text-sm font-medium text-white hover:bg-emerald-500"
              >
                Show pairing code
              </button>
            )}
          </div>

          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
            <div className="text-[13px] font-medium text-zinc-200">Pair with another machine</div>
            <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
              Enter the other machine's address and the code shown on its Fleet page.
            </p>
            <form
              className="mt-3 flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                pair();
              }}
            >
              <input
                value={peerUrl}
                onChange={(e) => setPeerUrl(e.target.value)}
                placeholder="http://192.168.1.20:4777"
                data-testid="pair-url"
                className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-100 outline-none focus:border-zinc-500"
              />
              <div className="flex gap-2">
                <input
                  value={peerCode}
                  onChange={(e) => setPeerCode(e.target.value)}
                  placeholder="6-digit code"
                  data-testid="pair-code"
                  className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs tracking-widest text-zinc-100 outline-none focus:border-zinc-500"
                />
                <button
                  disabled={busy || !peerUrl || !peerCode}
                  data-testid="pair-submit"
                  className="rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-40"
                >
                  {busy ? "Pairing…" : "Pair"}
                </button>
              </div>
            </form>
            {msg && (
              <div className={`mt-2 text-[11px] ${msg.kind === "ok" ? "text-emerald-400" : "text-red-400"}`} data-testid="pair-msg">
                {msg.text}
              </div>
            )}
          </div>
        </div>

        <p className="mt-6 text-[10px] leading-relaxed text-zinc-600">
          Pairing exchanges access tokens directly between the two machines over your local network, gated by the one-time
          code. Only pair on networks you trust. Remote machines are reached through this node — no ports are opened to the internet.
        </p>
      </div>
    </div>
  );
}
