// Self-update + fleet convergence. Every node tracks its own git commit,
// periodically checks origin, and applies updates by pulling/rebuilding and
// then exiting - launchd/systemd (KeepAlive/Restart=always) brings it back on
// the new code. Nodes nudge peers whose commit differs, so an update pushed
// anywhere propagates across the fleet within minutes.
import { join } from "path";
import type { Database } from "bun:sqlite";
import { bus } from "./events";

export const SRC_ROOT = join(import.meta.dir, "../..");

async function run(cmd: string[], cwd = SRC_ROOT): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out: out.trim(), err: err.trim() };
}

let cachedCommit: string | null = null;
export async function currentCommit(): Promise<string> {
  if (cachedCommit) return cachedCommit;
  const { code, out } = await run(["git", "rev-parse", "--short", "HEAD"]);
  cachedCommit = code === 0 ? out : "unknown";
  return cachedCommit;
}

export async function checkForUpdate(): Promise<{ commit: string; behind: number; error?: string }> {
  const commit = await currentCommit();
  const fetch_ = await run(["git", "fetch", "--quiet", "origin"]);
  if (fetch_.code !== 0) return { commit, behind: 0, error: `fetch failed: ${fetch_.err.slice(0, 200)}` };
  const count = await run(["git", "rev-list", "--count", "HEAD..origin/main"]);
  return { commit, behind: count.code === 0 ? parseInt(count.out, 10) || 0 : 0 };
}

let updating = false;
export const isUpdating = () => updating;

/** Pull + rebuild; on success schedules process exit so the supervisor
 *  restarts us on the new code. Returns before the exit happens. */
export async function applyUpdate(): Promise<{ ok: boolean; detail: string }> {
  if (updating) return { ok: false, detail: "update already in progress" };
  updating = true;
  bus.emit({ kind: "update:start" });
  try {
    const pull = await run(["git", "pull", "--ff-only", "--quiet", "origin", "main"]);
    if (pull.code !== 0) throw new Error(`git pull failed: ${pull.err.slice(0, 300)}`);
    // The service's PATH (launchd/systemd) may not include bun; we ARE bun.
    const bun = process.execPath;
    const install = await run([bun, "install"]);
    if (install.code !== 0) throw new Error(`bun install failed: ${install.err.slice(0, 300)}`);
    const build = await run([bun, "run", "build"]);
    if (build.code !== 0) throw new Error(`build failed: ${build.err.slice(0, 300)}`);
    const target = await run(["git", "rev-parse", "--short", "HEAD"]);
    bus.emit({ kind: "update:restarting", commit: target.out });
    console.log(`updated to ${target.out}; restarting`);
    // Give the HTTP response time to flush, then let the supervisor restart us.
    setTimeout(() => process.exit(0), 750);
    return { ok: true, detail: `updated to ${target.out}, restarting` };
  } catch (err) {
    const detail = String(err instanceof Error ? err.message : err);
    bus.emit({ kind: "update:failed", error: detail });
    console.error("self-update failed:", detail);
    updating = false;
    return { ok: false, detail };
  }
}

// ---- fleet nudges: tell peers whose commit differs to check for updates ----
const lastNudge = new Map<string, number>();
const NUDGE_INTERVAL_MS = 10 * 60 * 1000;

export function nudgePeer(node: { id: string; url: string; token: string }): void {
  const last = lastNudge.get(node.id) ?? 0;
  if (Date.now() - last < NUDGE_INTERVAL_MS) return;
  lastNudge.set(node.id, Date.now());
  fetch(`${node.url}/api/system/update`, {
    method: "POST",
    headers: { authorization: `Bearer ${node.token}` },
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

let lastSelfCheck = 0;
export function maybeSelfUpdate(reason: string): void {
  if (updating || Date.now() - lastSelfCheck < NUDGE_INTERVAL_MS) return;
  lastSelfCheck = Date.now();
  checkForUpdate()
    .then((r) => {
      if (r.behind > 0) {
        console.log(`auto-update (${reason}): ${r.behind} commit(s) behind origin`);
        return applyUpdate();
      }
    })
    .catch((err) => console.error("auto-update check failed:", err));
}

/** Hourly origin check, plus a peer sweep so fleets converge even when no
 *  browser is open anywhere (UI fleet probes also nudge, faster). */
export function startAutoUpdater(db: Database): () => void {
  const tick = () => maybeSelfUpdate("periodic");
  const sweep = async () => {
    const mine = await currentCommit();
    const rows = db.query("SELECT id, name, url, token FROM nodes").all() as {
      id: string; name: string; url: string; token: string;
    }[];
    for (const node of rows) {
      try {
        const res = await Promise.race([
          fetch(`${node.url}/api/status`, {
            headers: { authorization: `Bearer ${node.token}` },
            signal: AbortSignal.timeout(4000),
          }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 4500)),
        ]);
        if (!res.ok) continue;
        const status = await res.json();
        if (status.commit && status.commit !== mine) {
          console.log(`peer ${node.name} on ${status.commit} (we are ${mine}); nudging both`);
          nudgePeer(node);
          maybeSelfUpdate(`peer ${node.name} differs`);
        }
      } catch {}
    }
  };
  const iv = setInterval(tick, 60 * 60 * 1000);
  const sweepIv = setInterval(sweep, 15 * 60 * 1000);
  setTimeout(tick, 90 * 1000); // shortly after boot, off the critical path
  setTimeout(sweep, 3 * 60 * 1000);
  return () => {
    clearInterval(iv);
    clearInterval(sweepIv);
  };
}
