// Web terminal: a real PTY per WebSocket connection.
import { spawn as ptySpawn, type IPty } from "bun-pty";
import { existsSync } from "fs";
import { homedir } from "os";

export function createTermHandlers(cwdParam: string | undefined) {
  let pty: IPty | null = null;
  return {
    onOpen(_ev: unknown, ws: { send: (s: string) => void; close: () => void }) {
      const shell =
        process.env.SHELL && existsSync(process.env.SHELL)
          ? process.env.SHELL
          : process.platform === "darwin"
            ? "/bin/zsh"
            : "/bin/bash";
      let cwd = cwdParam || homedir();
      if (!existsSync(cwd)) cwd = homedir();
      try {
        pty = ptySpawn(shell, ["-il"], {
          name: "xterm-256color",
          cols: 120,
          rows: 32,
          cwd,
          env: { ...process.env, TERM: "xterm-256color", LANG: process.env.LANG ?? "en_US.UTF-8" } as any,
        });
      } catch (err) {
        ws.send(JSON.stringify({ t: "data", data: `\r\nfailed to start shell: ${err}\r\n` }));
        ws.close();
        return;
      }
      pty.onData((data: string) => ws.send(JSON.stringify({ t: "data", data })));
      pty.onExit(({ exitCode }: { exitCode: number }) => {
        try {
          ws.send(JSON.stringify({ t: "exit", code: exitCode }));
          ws.close();
        } catch {}
      });
    },
    onMessage(ev: { data: unknown }) {
      if (!pty) return;
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.t === "input" && typeof msg.data === "string") pty.write(msg.data);
        if (msg.t === "resize" && msg.cols > 0 && msg.rows > 0) {
          pty.resize(Math.min(500, msg.cols | 0), Math.min(200, msg.rows | 0));
        }
      } catch {}
    },
    onClose() {
      try {
        pty?.kill();
      } catch {}
      pty = null;
    },
  };
}
