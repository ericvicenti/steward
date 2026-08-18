import { useEffect, useState } from "react";
import { parseHash, navigate, api, activeNode, activeNodeName, setActiveNode, type Route } from "./lib/api";
import { ShieldIcon, ServerIcon, FolderIcon, TerminalIcon, GitIcon } from "./lib/icons";
import { Fleet } from "./views/Fleet";
import { Data } from "./views/Data";
import { Files } from "./views/Files";
import { Editor } from "./views/Editor";
import { Term } from "./views/Term";
import { TokenGate } from "./views/TokenGate";

const NAV = [
  { view: "fleet", label: "Fleet", icon: ServerIcon },
  { view: "data", label: "Data", icon: GitIcon },
  { view: "files", label: "Files", icon: FolderIcon },
  { view: "term", label: "Terminal", icon: TerminalIcon },
];

type FleetSummary = { self: { nodeId: string; name: string }; nodes: { id: string; name: string; online: boolean }[] };

export function App() {
  const [route, setRoute] = useState<Route>(parseHash());
  const [locked, setLocked] = useState(false);
  const [fleet, setFleet] = useState<FleetSummary | null>(null);
  const [nodeGen, setNodeGen] = useState(0); // bump to remount views on node switch

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    const onNode = () => setNodeGen((g) => g + 1);
    window.addEventListener("hashchange", onHash);
    window.addEventListener("steward-node-changed", onNode);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("steward-node-changed", onNode);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const f = await api<FleetSummary>("/api/fleet/nodes");
        if (alive) setFleet(f);
      } catch {}
    };
    poll();
    const iv = setInterval(poll, 30_000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [locked]);

  if (locked) return <TokenGate />;
  const lock = () => setLocked(true);
  const isActive = (v: string) => route.view === v || (v === "files" && route.view === "edit");
  const nodeId = activeNode();
  const onlineCount = fleet ? fleet.nodes.filter((n) => n.online).length : 0;

  const switchNode = (value: string) => {
    if (value === "") setActiveNode("", "");
    else {
      const n = fleet?.nodes.find((n) => n.id === value);
      setActiveNode(value, n?.name ?? "node");
    }
  };

  const view = (
    <>
      {route.view === "fleet" && <Fleet onLocked={lock} key={`fleet-${nodeGen}`} />}
      {route.view === "data" && <Data onLocked={lock} key={`data-${nodeGen}-${nodeId}`} />}
      {route.view === "files" && <Files params={route.params} onLocked={lock} key={`files-${nodeGen}-${nodeId}`} />}
      {route.view === "edit" && <Editor params={route.params} onLocked={lock} key={`edit-${nodeGen}-${nodeId}`} />}
      {route.view === "term" && <Term params={route.params} key={`term-${nodeGen}-${nodeId}`} />}
    </>
  );

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-zinc-950 text-zinc-200">
      {/* title bar */}
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-925 px-3" style={{ background: "#101013" }}>
        <ShieldIcon size={15} className="text-emerald-500" />
        <span className="text-[13px] font-semibold tracking-wide text-zinc-200">Steward</span>
        <span className="hidden text-[11px] text-zinc-600 sm:inline">/ {NAV.find((n) => isActive(n.view))?.label ?? route.view}</span>
        <div className="flex-1" />
        <select
          value={nodeId}
          onChange={(e) => switchNode(e.target.value)}
          data-testid="node-switcher"
          className="max-w-[45vw] rounded-md border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-[12px] text-zinc-300 outline-none focus:border-zinc-600"
          title="Which machine you are operating on"
        >
          <option value="">{fleet?.self.name ?? "this machine"} (local)</option>
          {fleet?.nodes.map((n) => (
            <option key={n.id} value={n.id} disabled={!n.online}>
              {n.name} {n.online ? "" : "(offline)"}
            </option>
          ))}
        </select>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* activity bar (desktop) */}
        <aside className="hidden w-12 shrink-0 flex-col items-center gap-1 border-r border-zinc-800 py-2 sm:flex" style={{ background: "#101013" }}>
          {NAV.map((item) => (
            <button
              key={item.view}
              onClick={() => navigate(item.view)}
              title={item.label}
              data-testid={`nav-${item.view}`}
              className={`relative flex h-10 w-10 items-center justify-center rounded-lg transition-colors ${
                isActive(item.view) ? "text-zinc-100" : "text-zinc-600 hover:text-zinc-300"
              }`}
            >
              {isActive(item.view) && <span className="absolute left-0 top-2 h-6 w-0.5 rounded bg-emerald-500" />}
              <item.icon size={20} />
            </button>
          ))}
        </aside>

        <main className="min-w-0 flex-1 overflow-hidden">{view}</main>
      </div>

      {/* status bar (desktop) */}
      <footer className="hidden h-6 shrink-0 items-center gap-4 border-t border-zinc-800 px-3 text-[11px] text-zinc-500 sm:flex" style={{ background: "#101013" }}>
        <button className="flex items-center gap-1.5 hover:text-zinc-300" onClick={() => navigate("fleet")} data-testid="statusbar-node">
          <span className={`h-1.5 w-1.5 rounded-full ${nodeId ? "bg-sky-400" : "bg-emerald-500"}`} />
          {nodeId ? `remote: ${activeNodeName()}` : fleet?.self.name ?? "local"}
        </button>
        <span>
          fleet: {onlineCount}/{fleet?.nodes.length ?? 0} peers online
        </span>
        <div className="flex-1" />
        <span>steward 0.3</span>
      </footer>

      {/* bottom nav (mobile) */}
      <nav className="flex shrink-0 border-t border-zinc-800 pb-[env(safe-area-inset-bottom)] sm:hidden" style={{ background: "#101013" }}>
        {NAV.map((item) => (
          <button
            key={item.view}
            onClick={() => navigate(item.view)}
            data-testid={`mnav-${item.view}`}
            className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] ${
              isActive(item.view) ? "text-emerald-400" : "text-zinc-500"
            }`}
          >
            <item.icon size={20} />
            {item.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
