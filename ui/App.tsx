import { useEffect, useState } from "react";
import { parseHash, navigate, type Route } from "./lib/api";
import { Dashboard } from "./views/Dashboard";
import { Files } from "./views/Files";
import { Editor } from "./views/Editor";
import { Term } from "./views/Term";
import { TokenGate } from "./views/TokenGate";

const NAV = [
  { view: "dashboard", label: "Dashboard", icon: "🛡️" },
  { view: "files", label: "Files", icon: "📁" },
  { view: "term", label: "Terminal", icon: "▚" },
];

export function App() {
  const [route, setRoute] = useState<Route>(parseHash());
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  if (locked) return <TokenGate />;
  const lock = () => setLocked(true);

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex w-52 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950">
        <div className="flex items-center gap-2 px-4 py-4">
          <span className="text-xl">🛡️</span>
          <span className="text-sm font-semibold tracking-wide text-zinc-100">Steward</span>
        </div>
        <nav className="flex flex-col gap-0.5 px-2">
          {NAV.map((item) => (
            <button
              key={item.view}
              onClick={() => navigate(item.view)}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                route.view === item.view || (item.view === "files" && route.view === "edit")
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
              }`}
            >
              <span className="w-5 text-center">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="mt-auto px-4 py-3 text-[10px] uppercase tracking-wider text-zinc-600">
          steward · local node
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-auto bg-zinc-950">
        {route.view === "dashboard" && <Dashboard onLocked={lock} />}
        {route.view === "files" && <Files params={route.params} onLocked={lock} />}
        {route.view === "edit" && <Editor params={route.params} onLocked={lock} />}
        {route.view === "term" && <Term params={route.params} />}
      </main>
    </div>
  );
}
