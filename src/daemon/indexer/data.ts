// User-data inventory: one row per top-level entry of each data root
// (~/Desktop, ~/Documents, ~/Library/Application Support, ...), with sizes
// and an app-cache split so reclaimable bytes are visible.
import { readdirSync, statSync, existsSync } from "fs";
import { join, basename } from "path";
import type { Database } from "bun:sqlite";
import type { StewardConfig } from "../config";
import { bus } from "../events";

async function duBytes(paths: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (paths.length === 0) return out;
  // Batch to keep argv within limits.
  for (let i = 0; i < paths.length; i += 50) {
    const batch = paths.slice(i, i + 50);
    const proc = Bun.spawn(["du", "-sk", ...batch], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    for (const line of text.split("\n")) {
      const m = line.match(/^(\d+)\s+(.+)$/);
      if (m) out.set(m[2], parseInt(m[1], 10) * 1024);
    }
  }
  return out;
}

/** Sum of cache-named subdirectories directly inside `dir` (one level deep). */
async function cacheBytes(dir: string, cacheDirs: string[]): Promise<number> {
  let targets: string[] = [];
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && cacheDirs.includes(e.name)) targets.push(join(dir, e.name));
    }
  } catch {
    return 0;
  }
  const sizes = await duBytes(targets);
  let total = 0;
  for (const v of sizes.values()) total += v;
  return total;
}

let dataScanRunning = false;
export const isDataScanRunning = () => dataScanRunning;

export async function runDataScan(db: Database, cfg: StewardConfig): Promise<void> {
  if (dataScanRunning) return;
  dataScanRunning = true;
  bus.emit({ kind: "datascan:start" });
  try {
    const upsert = db.query(`
      INSERT INTO data_dirs (root, path, name, kind, size_bytes, cache_bytes, mtime, scanned_at)
      VALUES ($root, $path, $name, $kind, $size_bytes, $cache_bytes, $mtime, $scanned_at)
      ON CONFLICT(path) DO UPDATE SET
        root=excluded.root, name=excluded.name, kind=excluded.kind,
        size_bytes=excluded.size_bytes, cache_bytes=excluded.cache_bytes,
        mtime=excluded.mtime, scanned_at=excluded.scanned_at
    `);

    const seen = new Set<string>();
    const roots = cfg.dataRoots.filter((r) => existsSync(r));
    let rootIdx = 0;
    for (const root of roots) {
      rootIdx++;
      bus.emit({ kind: "datascan:progress", root, done: rootIdx, total: roots.length });
      let entries: string[] = [];
      try {
        entries = readdirSync(root).filter((n) => !n.startsWith("."));
      } catch {
        continue; // e.g. missing Full Disk Access for this folder
      }
      const paths = entries.map((n) => join(root, n));
      const sizes = await duBytes(paths);
      for (const p of paths) {
        const name = basename(p);
        seen.add(p);
        let mtime: number | null = null;
        let isDir = false;
        try {
          const st = statSync(p);
          mtime = st.mtimeMs;
          isDir = st.isDirectory();
        } catch {}
        const isCache = cfg.cacheDirs.includes(name);
        const caches = !isCache && isDir ? await cacheBytes(p, cfg.cacheDirs) : 0;
        upsert.run({
          $root: root,
          $path: p,
          $name: name,
          $kind: isCache ? "cache" : "data",
          $size_bytes: sizes.get(p) ?? 0,
          $cache_bytes: isCache ? (sizes.get(p) ?? 0) : caches,
          $mtime: mtime,
          $scanned_at: Date.now(),
        } as any);
      }
    }

    // Drop rows for entries that no longer exist (only under configured roots).
    const known = db.query("SELECT id, path, root FROM data_dirs").all() as { id: number; path: string; root: string }[];
    for (const k of known) {
      if (roots.includes(k.root) && !seen.has(k.path)) {
        db.query("DELETE FROM data_dirs WHERE id = ?").run(k.id);
      }
    }
    bus.emit({ kind: "datascan:done" });
  } catch (err) {
    bus.emit({ kind: "datascan:failed", error: String(err) });
    throw err;
  } finally {
    dataScanRunning = false;
  }
}
