import { readdirSync, existsSync } from "fs";
import { join, basename } from "path";
import type { Database } from "bun:sqlite";
import type { StewardConfig } from "../config";
import { bus } from "../events";

async function git(repo: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", repo, ...args], {
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trimEnd();
}

/** Find git repos under the configured roots. A repo ends descent. */
export function findRepos(cfg: StewardConfig): string[] {
  const repos: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === ".git")) {
      repos.push(dir);
      // A repo normally ends descent, but a configured root that is itself a
      // repo (e.g. ~/Code with a stray .git) still gets its children scanned.
      if (!cfg.roots.includes(dir)) return;
    }
    if (depth <= 0) return;
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      if (e.name.startsWith(".")) continue;
      if (cfg.skipDirs.includes(e.name) || cfg.junkDirs.includes(e.name)) continue;
      walk(join(dir, e.name), depth - 1);
    }
  };
  for (const root of cfg.roots) walk(root, cfg.scanDepth);
  return repos;
}

/** Sum sizes of junk dirs at repo root and one package level down (monorepos). */
async function junkBytes(repo: string, junkDirs: string[]): Promise<number> {
  const targets: string[] = [];
  const addJunkIn = (dir: string) => {
    for (const j of junkDirs) {
      const p = join(dir, j);
      if (existsSync(p)) targets.push(p);
    }
  };
  addJunkIn(repo);
  for (const sub of ["packages", "apps", "frontend"]) {
    const subdir = join(repo, sub);
    try {
      for (const e of readdirSync(subdir, { withFileTypes: true })) {
        if (e.isDirectory()) addJunkIn(join(subdir, e.name));
      }
    } catch {}
  }
  if (targets.length === 0) return 0;
  const proc = Bun.spawn(["du", "-sk", ...targets], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  let kb = 0;
  for (const line of out.split("\n")) {
    const n = parseInt(line, 10);
    if (!isNaN(n)) kb += n;
  }
  return kb * 1024;
}

async function scanRepo(path: string, cfg: StewardConfig) {
  const status = await git(path, ["status", "--porcelain=v1", "-b"]);
  const lines = status.split("\n");
  const header = lines[0] ?? "";
  const headerBody = header.replace(/^## /, "");
  const branch = headerBody.startsWith("No commits yet on ")
    ? headerBody.slice("No commits yet on ".length)
    : headerBody.split("...")[0].split(" ")[0] || null;
  let ahead = 0;
  const aheadMatch = header.match(/ahead (\d+)/);
  if (aheadMatch) ahead = parseInt(aheadMatch[1], 10);
  const behind = parseInt(header.match(/behind (\d+)/)?.[1] ?? "0", 10);
  const body = lines.slice(1).filter(Boolean);
  const untracked = body.filter((l) => l.startsWith("??")).length;
  const dirty = body.length - untracked;

  const [stashList, remoteList, lastCommit, unpushedAll] = await Promise.all([
    git(path, ["stash", "list"]),
    git(path, ["remote", "-v"]),
    git(path, ["log", "-1", "--format=%ct%x00%s"]),
    git(path, ["log", "--branches", "--not", "--remotes", "--oneline"]),
  ]);

  const stashes = stashList ? stashList.split("\n").length : 0;
  const remotes: { name: string; url: string }[] = [];
  for (const line of remoteList.split("\n")) {
    const m = line.match(/^(\S+)\t(\S+) \(fetch\)$/);
    if (m) remotes.push({ name: m[1], url: m[2] });
  }
  const [ctRaw, subject] = lastCommit ? lastCommit.split("\0") : ["", ""];
  const lastCommitAt = ctRaw ? parseInt(ctRaw, 10) * 1000 : null;
  // Unpushed commits on any branch, not just the current upstream.
  const unpushed = unpushedAll ? unpushedAll.split("\n").length : 0;
  if (remotes.length > 0) ahead = Math.max(ahead, unpushed);

  const reasons: string[] = [];
  if (remotes.length === 0) reasons.push("no remote — this may be the only copy");
  if (ahead > 0) reasons.push(`${ahead} unpushed commit${ahead === 1 ? "" : "s"}`);
  if (dirty > 0) reasons.push(`${dirty} modified file${dirty === 1 ? "" : "s"}`);
  if (untracked > 0) reasons.push(`${untracked} untracked file${untracked === 1 ? "" : "s"}`);
  if (stashes > 0) reasons.push(`${stashes} stash${stashes === 1 ? "" : "es"}`);

  const risk =
    remotes.length === 0 ? "at-risk" : reasons.length > 0 ? "attention" : "safe";

  return {
    path,
    name: basename(path),
    head_branch: branch,
    dirty_files: dirty,
    untracked_files: untracked,
    stashes,
    ahead,
    behind,
    remotes: JSON.stringify(remotes),
    last_commit_at: lastCommitAt,
    last_commit_subject: subject || null,
    junk_bytes: await junkBytes(path, cfg.junkDirs),
    size_bytes: 0,
    risk,
    risk_reasons: JSON.stringify(reasons),
    scanned_at: Date.now(),
  };
}

let scanRunning = false;

export async function runScan(db: Database, cfg: StewardConfig): Promise<void> {
  if (scanRunning) return;
  scanRunning = true;
  const scanId = db
    .query("INSERT INTO scans (started_at) VALUES (?) RETURNING id")
    .get(Date.now()) as { id: number };
  bus.emit({ kind: "scan:start", scanId: scanId.id });
  try {
    const repos = findRepos(cfg);
    bus.emit({ kind: "scan:found", total: repos.length });
    const upsert = db.query(`
      INSERT INTO repos (path, name, head_branch, dirty_files, untracked_files, stashes,
        ahead, behind, remotes, last_commit_at, last_commit_subject, junk_bytes,
        size_bytes, risk, risk_reasons, scanned_at)
      VALUES ($path, $name, $head_branch, $dirty_files, $untracked_files, $stashes,
        $ahead, $behind, $remotes, $last_commit_at, $last_commit_subject, $junk_bytes,
        $size_bytes, $risk, $risk_reasons, $scanned_at)
      ON CONFLICT(path) DO UPDATE SET
        name=excluded.name, head_branch=excluded.head_branch,
        dirty_files=excluded.dirty_files, untracked_files=excluded.untracked_files,
        stashes=excluded.stashes, ahead=excluded.ahead, behind=excluded.behind,
        remotes=excluded.remotes, last_commit_at=excluded.last_commit_at,
        last_commit_subject=excluded.last_commit_subject, junk_bytes=excluded.junk_bytes,
        size_bytes=excluded.size_bytes, risk=excluded.risk,
        risk_reasons=excluded.risk_reasons, scanned_at=excluded.scanned_at
    `);

    let done = 0;
    const CONCURRENCY = 8;
    const queue = [...repos];
    const worker = async () => {
      for (let path = queue.shift(); path; path = queue.shift()) {
        try {
          const row = await scanRepo(path, cfg);
          const bound = Object.fromEntries(
            Object.entries(row).map(([k, v]) => [`$${k}`, v])
          );
          upsert.run(bound as any);
        } catch (err) {
          console.error(`scan failed for ${path}:`, err);
        }
        done++;
        if (done % 10 === 0 || done === repos.length) {
          bus.emit({ kind: "scan:progress", done, total: repos.length });
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    // Drop repos that no longer exist on disk.
    const known = db.query("SELECT id, path FROM repos").all() as { id: number; path: string }[];
    const found = new Set(repos);
    for (const k of known) {
      if (!found.has(k.path)) db.query("DELETE FROM repos WHERE id = ?").run(k.id);
    }

    db.query("UPDATE scans SET finished_at = ?, repos_found = ?, status = 'done' WHERE id = ?")
      .run(Date.now(), repos.length, scanId.id);
    bus.emit({ kind: "scan:done", total: repos.length });
  } catch (err) {
    db.query("UPDATE scans SET finished_at = ?, status = 'failed' WHERE id = ?")
      .run(Date.now(), scanId.id);
    bus.emit({ kind: "scan:failed", error: String(err) });
    throw err;
  } finally {
    scanRunning = false;
  }
}

export function isScanRunning(): boolean {
  return scanRunning;
}
