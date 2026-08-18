// Data inventory scan + change-driven auto-rescan (watcher).
import { test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { initSchema } from "../src/daemon/db";
import { runDataScan } from "../src/daemon/indexer/data";
import { startWatcher } from "../src/daemon/indexer/watch";
import { tmpHomeDir, testConfig, git } from "./helpers";
import { bus } from "../src/daemon/events";

const { dir, cleanup } = tmpHomeDir("data");
afterAll(cleanup);

test("data scan inventories top-level items with cache split", async () => {
  const docs = join(dir, "Documents");
  mkdirSync(join(docs, "Big Project"), { recursive: true });
  writeFileSync(join(docs, "Big Project", "novel.txt"), "x".repeat(80_000));
  mkdirSync(join(docs, "Big Project", "Caches"));
  writeFileSync(join(docs, "Big Project", "Caches", "junk.bin"), "y".repeat(40_000));
  writeFileSync(join(docs, "loose-file.pdf"), "z".repeat(10_000));
  const appSupport = join(dir, "AppSupport");
  mkdirSync(join(appSupport, "SomeApp", "GPUCache"), { recursive: true });
  writeFileSync(join(appSupport, "SomeApp", "settings.json"), "{}");
  mkdirSync(join(appSupport, "Caches"));
  writeFileSync(join(appSupport, "Caches", "blob"), "c".repeat(20_000));

  const cfg = testConfig({
    dataRoots: [docs, appSupport],
    cacheDirs: ["Caches", "GPUCache"],
  });
  const db = new Database(":memory:");
  initSchema(db);
  await runDataScan(db, cfg);

  const rows = db.query("SELECT * FROM data_dirs").all() as any[];
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));

  expect(byName["Big Project"].kind).toBe("data");
  expect(byName["Big Project"].size_bytes).toBeGreaterThan(80_000);
  expect(byName["Big Project"].cache_bytes).toBeGreaterThan(30_000); // its Caches subdir
  expect(byName["Big Project"].cache_bytes).toBeLessThan(byName["Big Project"].size_bytes);

  expect(byName["loose-file.pdf"].kind).toBe("data");
  expect(byName["loose-file.pdf"].size_bytes).toBeGreaterThan(0);

  expect(byName["Caches"].kind).toBe("cache"); // top-level cache dir counted wholly as cache
  expect(byName["Caches"].cache_bytes).toBe(byName["Caches"].size_bytes);

  expect(byName["SomeApp"].kind).toBe("data");
  expect(byName["SomeApp"].root).toBe(appSupport);
}, 30000);

test("data rescan drops rows for deleted items", async () => {
  const root = join(dir, "DropRoot");
  mkdirSync(join(root, "keep"), { recursive: true });
  mkdirSync(join(root, "doomed"));
  const cfg = testConfig({ dataRoots: [root], cacheDirs: [] });
  const db = new Database(":memory:");
  initSchema(db);
  await runDataScan(db, cfg);
  expect((db.query("SELECT COUNT(*) n FROM data_dirs").get() as any).n).toBe(2);
  await Bun.spawn(["rm", "-rf", join(root, "doomed")]).exited;
  await runDataScan(db, cfg);
  const names = (db.query("SELECT name FROM data_dirs").all() as any[]).map((r) => r.name);
  expect(names).toEqual(["keep"]);
}, 30000);

test("watcher triggers an automatic rescan after a change", async () => {
  const root = join(dir, "WatchRoot");
  mkdirSync(join(root, "repo"), { recursive: true });
  await git(join(root, "repo"), "init", "-b", "main");
  writeFileSync(join(root, "repo", "a.txt"), "1");
  await git(join(root, "repo"), "add", "-A");
  await git(join(root, "repo"), "-c", "user.email=t@t", "-c", "user.name=T", "commit", "-m", "init");

  const cfg = testConfig({ roots: [root] });
  const db = new Database(":memory:");
  initSchema(db);

  let rescans = 0;
  const unsub = bus.subscribe((ev) => {
    if (ev.kind === "watch:rescan") rescans++;
  });
  const stop = startWatcher(db, cfg, 300); // short debounce for the test
  try {
    await new Promise((r) => setTimeout(r, 200));
    writeFileSync(join(root, "repo", "new-file.txt"), "change!");
    const start = Date.now();
    while (rescans === 0) {
      if (Date.now() - start > 8000) throw new Error("watcher never fired");
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(rescans).toBeGreaterThanOrEqual(1);
    // the triggered scan indexed the repo
    const start2 = Date.now();
    while ((db.query("SELECT COUNT(*) n FROM repos").get() as any).n === 0) {
      if (Date.now() - start2 > 8000) throw new Error("scan did not index repo");
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    stop();
    unsub();
  }
}, 20000);
