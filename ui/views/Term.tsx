import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { wsUrl } from "../lib/api";
import "@xterm/xterm/css/xterm.css";

export function Term({ params }: { params: URLSearchParams }) {
  const cwd = params.get("cwd") ?? "";
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"connecting" | "live" | "closed">("connecting");
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!host.current) return;
    const term = new Terminal({
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      cursorBlink: true,
      theme: {
        background: "#09090b",
        foreground: "#d4d4d8",
        cursor: "#34d399",
        selectionBackground: "#3f3f46",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    fit.fit();

    const ws = new WebSocket(wsUrl("/api/term", cwd ? { cwd } : {}));
    setStatus("connecting");

    ws.onopen = () => {
      setStatus("live");
      ws.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
      term.focus();
    };
    ws.onmessage = (msg) => {
      try {
        const m = JSON.parse(msg.data);
        if (m.t === "data") term.write(m.data);
        if (m.t === "exit") term.write(`\r\n\x1b[90m[process exited ${m.code}]\x1b[0m\r\n`);
      } catch {}
    };
    ws.onclose = () => setStatus("closed");
    ws.onerror = () => setStatus("closed");

    const inputSub = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "input", data }));
    });

    const ro = new ResizeObserver(() => {
      fit.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
      }
    });
    ro.observe(host.current);

    return () => {
      ro.disconnect();
      inputSub.dispose();
      ws.close();
      term.dispose();
    };
  }, [cwd, generation]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-zinc-800 px-4 py-2.5">
        <div className="flex-1 text-sm text-zinc-300">
          Terminal
          <span className="ml-2 font-mono text-xs text-zinc-600">{cwd || "~"}</span>
        </div>
        <span
          className={`inline-flex items-center gap-1.5 text-xs ${
            status === "live" ? "text-emerald-400" : status === "connecting" ? "text-amber-400" : "text-zinc-500"
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${status === "live" ? "bg-emerald-400" : status === "connecting" ? "bg-amber-400" : "bg-zinc-600"}`} />
          {status}
        </span>
        {status === "closed" && (
          <button
            onClick={() => setGeneration((g) => g + 1)}
            className="rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            Reconnect
          </button>
        )}
      </div>
      <div ref={host} className="min-h-0 flex-1 bg-[#09090b] p-2" data-testid="terminal-host" />
    </div>
  );
}
