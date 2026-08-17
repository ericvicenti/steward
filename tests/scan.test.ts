import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { initSchema } from "../src/daemon/db";
import { runScan, findRepos } from "../src/daemon/indexer/scan";
import { tmpHomeDir, testConfig, git } from "./helpers";

const { dir, cleanup } = tmpHomeDir("scan");
afterAll(cleanup);

const GIT_ENV = ["-c", "user.email=test@test", "-c", "user.name=Test", "-c", "commit.gpgsign=false"];

async function makeRepo(path: string): Promise<void> {
  mkdirSync(path, { recursive: true });
  await git(path, "init", "-b", "main");
  writeFileSync(join(path, "README.md"), "# test\n");
  await git(path, "add", "-A");
  await git(path, ...GIT_ENV, "commit", "-m", "init");
}

beforeAll(async () => {
  // orphan: no remote, dirty working tree
  await makeRepo(join(dir, "orphan"));
  writeFileSync(join(dir, "orphan", "wip.txt"), "uncommitted");
  writeFileSync(join(dir, "orphan", "README.md"), "# modified\n");

  // pushed: has a remote, fully pushed and clean
  await makeRepo(join(dir, "pushed"));
  const bare = join(dir, ".bare-remote.git");
  mkdirSync(bare);
  await git(bare, "init", "--bare");
  await git(join(dir, "pushed"), "remote", "add", "origin", bare);
  await git(join(dir, "pushed"), "push", "-u", "origin", "main");

  // ahead: has a remote but one unpushed commit and junk to measure
  await makeRepo(join(dir, "ahead"));
  const bare2 = join(dir, ".bare-remote2.git");
  mkdirSync(bare2);
  await git(bare2, "init", "--bare");
  await git(join(dir, "ahead"), "remote", "add", "origin", bare2);
  await git(join(dir, "ahead"), "push", "-u", "origin", "main");
  writeFileSync(join(dir, "ahead", "feature.ts"), "export {}\n");
  await git(join(dir, "ahead"), "add", "-A");
  await git(join(dir, "ahead"), ...GIT_ENV, "commit", "-m", "unpushed feature");
  mkdirSync(join(dir, "ahead", "node_modules", "fake-pkg"), { recursive: true });
  writeFileSync(join(dir, "ahead", "node_modules", "fake-pkg", "blob.js"), "x".repeat(50_000));

  // not a repo at all
  mkdirSync(join(dir, "plain-folder"));
  writeFileSync(join(dir, "plain-folder", "notes.txt"), "no git here");
});

test("findRepos discovers repos and skips non-repos", () => {
  const cfg = testConfig({ roots: [dir] });
  const repos = findRepos(cfg).sort();
  expect(repos).toContain(join(dir, "orphan"));
  expect(repos).toContain(join(dir, "pushed"));
  expect(repos).toContain(join(dir, "ahead"));
  expect(repos).not.toContain(join(dir, "plain-folder"));
});

test("runScan classifies risk correctly", async () => {
  const cfg = testConfig({ roots: [dir] });
  const db = new Database(":memory:");
  initSchema(db);
  await runScan(db, cfg);
  const rows = db.query("SELECT * FROM repos").all() as any[];
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));

  expect(byName["orphan"].risk).toBe("at-risk");
  expect(JSON.parse(byName["orphan"].risk_reasons).join(" ")).toContain("no remote");
  expect(byName["orphan"].dirty_files).toBe(1);
  expect(byName["orphan"].untracked_files).toBe(1);

  expect(byName["pushed"].risk).toBe("safe");
  expect(byName["pushed"].ahead).toBe(0);
  expect(JSON.parse(byName["pushed"].remotes)).toHaveLength(1);

  expect(byName["ahead"].risk).toBe("attention");
  expect(byName["ahead"].ahead).toBe(1);
  expect(byName["ahead"].junk_bytes).toBeGreaterThan(40_000);
  expect(byName["ahead"].head_branch).toBe("main");
}, 30000);

test("rescan drops repos deleted from disk", async () => {
  const cfg = testConfig({ roots: [dir] });
  const db = new Database(":memory:");
  initSchema(db);
  await runScan(db, cfg);
  const before = db.query("SELECT COUNT(*) AS n FROM repos").get() as any;
  const doomed = join(dir, "doomed-repo");
  await makeRepo(doomed);
  await runScan(db, cfg);
  expect((db.query("SELECT COUNT(*) AS n FROM repos").get() as any).n).toBe(before.n + 1);
  await Bun.spawn(["rm", "-rf", doomed]).exited;
  await runScan(db, cfg);
  expect((db.query("SELECT COUNT(*) AS n FROM repos").get() as any).n).toBe(before.n);
}, 60000);
