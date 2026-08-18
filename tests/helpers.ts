import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { initSchema } from "../src/daemon/db";
import { createServer } from "../src/daemon/server";
import type { StewardConfig } from "../src/daemon/config";

/** Temp dir INSIDE the home directory (fs ops are home-confined). */
export function tmpHomeDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(homedir(), `.steward-test-${prefix}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const TEST_TOKEN = "test-token-abc";

export function testConfig(overrides: Partial<StewardConfig> = {}): StewardConfig {
  return {
    nodeName: "test-node",
    port: 0,
    bind: "127.0.0.1",
    autoUpdate: false,
    roots: [],
    junkDirs: ["node_modules", "dist"],
    skipDirs: [".git"],
    scanDepth: 3,
    ...overrides,
  };
}

export interface TestServer {
  db: Database;
  base: string;
  wsBase: string;
  stop: () => void;
  api: (path: string, init?: RequestInit) => Promise<Response>;
}

export function startTestServer(
  cfg: StewardConfig = testConfig(),
  opts: { token?: string; nodeId?: string } = {}
): TestServer {
  const token = opts.token ?? TEST_TOKEN;
  const db = new Database(":memory:");
  initSchema(db);
  const { fetch: appFetch, websocket } = createServer(db, cfg, token, opts.nodeId ?? "stw-test");
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: appFetch, websocket });
  const base = `http://127.0.0.1:${server.port}`;
  return {
    db,
    base,
    wsBase: `ws://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    api: (path, init) =>
      fetch(`${base}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, ...init?.headers },
      }),
  };
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")} failed: ${err}`);
  return out.trim();
}
