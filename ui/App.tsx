import { useEffect, useMemo, useState } from "react";

type Remote = { name: string; url: string };
type Repo = {
  id: number;
  path: string;
  name: string;
  head_branch: string | null;
  dirty_files: number;
  untracked_files: number;
  stashes: number;
  ahead: number;
  behind: number;
  remotes: Remote[];
  last_commit_at: number | null;
  last_commit_subject: string | null;
  junk_bytes: number;
  risk: "safe" | "attention" | "at-risk";
  risk_reasons: string[];
};
type Status = {
  nodeName: string;
  version: string;
  roots: string[];
  scanning: boolean;
  repos: number | null;
  atRisk: number | null;
  attention: number | null;
  safe: number | null;
  junkBytes: number | null;
  lastScanAt: number | null;
};

const token = () => localStorage.getItem("steward-token") ?? "";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { authorization: `Bearer ${token()}`, ...init?.headers },
  });
  if (res.status === 401) throw new Error("unauthorized");
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

function fmtBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function fmtAgo(ms: number | null): string {
  if (!ms) return "—";
  const d = Date.now() - ms;
  const days = Math.floor(d / 86400000);
  if (days > 365) return `${Math.floor(days / 365)}y ago`;
  if (days > 30) return `${Math.floor(days / 30)}mo ago`;
  if (days > 0) return `${days}d ago`;
  const hours = Math.floor(d / 3600000);
  if (hours > 0) return `${hours}h ago`;
  return "just now";
}

const RISK_STYLES: Record<Repo["risk"], string> = {
  "at-risk": "bg-red-500/15 text-red-400 ring-red-500/30",
  attention: "bg-amber-500/15 text-amber-400 ring-amber-500/30",
  safe: "bg-emerald-500/15 text-emerald-400 ring-emerald-500/30",
};

function RiskBadge({ risk }: { risk: Repo["risk"] }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${RISK_STYLES[risk]}`}>
      {risk === "at-risk" ? "at risk" : risk}
    </span>
  );
}

function StatCard(props: { label: string; value: string; tone?: "red" | "amber" | "green" | "neutral" }) {
  const tones = {
    red: "text-red-400",
    amber: "text-amber-400",
    green: "text-emerald-400",
    neutral: "text-zinc-100",
  };
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 px-5 py-4">
      <div className={`text-2xl font-semibold tabular-nums ${tones[props.tone ?? "neutral"]}`}>{props.value}</div>
      <div className="mt-1 text-xs uppercase tracking-wider text-zinc-500">{props.label}</div>
    </div>
  );
}

function TokenGate() {
  const [value, setValue] = useState("");
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900/60 p-8">
        <div className="text-3xl">🛡️</div>
        <h1 className="mt-3 text-xl font-semibold text-zinc-100">Steward is locked</h1>
        <p className="mt-2 text-sm leading-relaxed text-zinc-400">
          Run <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-200">steward open</code> in a
          terminal to open an authenticated session, or paste the token from{" "}
          <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-200">~/.steward/token</code>.
        </p>
        <form
          className="mt-5 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            localStorage.setItem("steward-token", value.trim());
            location.reload();
          }}
        >
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="access token"
            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-zinc-500"
          />
          <button className="rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white">
            Unlock
          </button>
        </form>
      </div>
    </div>
  );
}

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [locked, setLocked] = useState(false);
  const [filter, setFilter] = useState("");
  const [scanProgress, setScanProgress] = useState<{ done: number; total: number } | null>(null);

  const refresh = async () => {
    try {
      const [s, r] = await Promise.all([api<Status>("/api/status"), api<Repo[]>("/api/repos")]);
      setStatus(s);
      setRepos(r);
      setLocked(false);
    } catch (err) {
      if (String(err).includes("unauthorized")) setLocked(true);
    }
  };

  useEffect(() => {
    refresh();
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/api/events?token=${token()}`);
    ws.onmessage = (msg) => {
      const ev = JSON.parse(msg.data);
      if (ev.kind === "scan:progress") setScanProgress({ done: ev.done, total: ev.total });
      if (ev.kind === "scan:done" || ev.kind === "scan:failed") {
        setScanProgress(null);
        refresh();
      }
    };
    return () => ws.close();
  }, []);

  const filtered = useMemo(() => {
    const q = filter.toLowerCase();
    const order = { "at-risk": 0, attention: 1, safe: 2 };
    return repos
      .filter((r) => !q || r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q))
      .sort((a, b) => order[a.risk] - order[b.risk] || (b.last_commit_at ?? 0) - (a.last_commit_at ?? 0));
  }, [repos, filter]);

  if (locked) return <TokenGate />;

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-2xl">🛡️</span>
          <div>
            <h1 className="text-lg font-semibold text-zinc-100">Steward</h1>
            <p className="text-xs text-zinc-500">
              {status ? `${status.nodeName} · watching ${status.roots.join(", ")}` : "connecting…"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {scanProgress && (
            <span className="text-xs tabular-nums text-zinc-400">
              scanning {scanProgress.done}/{scanProgress.total}
            </span>
          )}
          <button
            onClick={() => api("/api/scan", { method: "POST" })}
            disabled={!!scanProgress || status?.scanning}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
          >
            {scanProgress || status?.scanning ? "Scanning…" : "Rescan"}
          </button>
        </div>
      </header>

      <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <StatCard label="repos" value={String(status?.repos ?? "—")} />
        <StatCard label="at risk" value={String(status?.atRisk ?? "—")} tone={status?.atRisk ? "red" : "green"} />
        <StatCard label="attention" value={String(status?.attention ?? "—")} tone={status?.attention ? "amber" : "green"} />
        <StatCard label="safe" value={String(status?.safe ?? "—")} tone="green" />
        <StatCard label="reclaimable" value={status?.junkBytes ? fmtBytes(status.junkBytes) : "—"} />
      </section>

      <section className="mt-8">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium uppercase tracking-wider text-zinc-500">Repositories</h2>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter…"
            className="w-56 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm outline-none focus:border-zinc-600"
          />
        </div>
        <div className="mt-3 overflow-hidden rounded-xl border border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900/70 text-left text-xs uppercase tracking-wider text-zinc-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">Repo</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Needs</th>
                <th className="px-4 py-2.5 font-medium text-right">Last commit</th>
                <th className="px-4 py-2.5 font-medium text-right">Junk</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/70">
              {filtered.map((r) => (
                <tr key={r.id} className="hover:bg-zinc-900/40">
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-zinc-200">{r.name}</div>
                    <div className="text-xs text-zinc-500">
                      {r.head_branch ?? "no branch"}
                      {r.remotes.length === 0 ? " · no remote" : ""}
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <RiskBadge risk={r.risk} />
                  </td>
                  <td className="max-w-xs px-4 py-2.5 text-xs text-zinc-400">
                    {r.risk_reasons.length ? r.risk_reasons.join(", ") : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right text-xs tabular-nums text-zinc-400">
                    {fmtAgo(r.last_commit_at)}
                  </td>
                  <td className="px-4 py-2.5 text-right text-xs tabular-nums text-zinc-400">
                    {r.junk_bytes ? fmtBytes(r.junk_bytes) : "—"}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-sm text-zinc-500">
                    {repos.length === 0 ? "No repos indexed yet — first scan is running." : "No matches."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
