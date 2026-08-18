// Automatic rescans: watch the code roots recursively (FSEvents on macOS,
// inotify on Linux) and debounce changes into a repo scan. Data roots are
// heavy (du over Documents etc.), so they rescan on a slower timer instead.
import { watch, existsSync, type FSWatcher } from "fs";
import type { Database } from "bun:sqlite";
import type { StewardConfig } from "../config";
import { runScan } from "./scan";
import { runDataScan } from "./data";
import { bus } from "../events";

const IGNORE = /node_modules|\.git\/|\/\.cache\/|\/dist\/|\/build\//;

export function startWatcher(db: Database, cfg: StewardConfig, debounceMs = 15_000): () => void {
  const watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingChanges = 0;

  const schedule = () => {
    pendingChanges++;
    clearTimeout(timer);
    timer = setTimeout(() => {
      bus.emit({ kind: "watch:rescan", changes: pendingChanges });
      pendingChanges = 0;
      runScan(db, cfg).catch((err) => console.error("watch-triggered scan failed:", err));
    }, debounceMs);
  };

  for (const root of cfg.roots) {
    if (!existsSync(root)) continue;
    try {
      const w = watch(root, { recursive: true }, (_event, filename) => {
        if (filename && IGNORE.test(`/${filename}/`)) return;
        schedule();
      });
      watchers.push(w);
    } catch (err) {
      console.error(`could not watch ${root}:`, err);
    }
  }
  console.log(`watching ${watchers.length} root(s) for changes (auto-rescan)`);

  // Data roots: rescan every 6 hours.
  const dataTimer = setInterval(() => {
    runDataScan(db, cfg).catch((err) => console.error("periodic data scan failed:", err));
  }, 6 * 60 * 60 * 1000);

  return () => {
    for (const w of watchers) w.close();
    clearTimeout(timer);
    clearInterval(dataTimer);
  };
}
