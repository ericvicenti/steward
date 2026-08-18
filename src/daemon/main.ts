import { loadConfig, loadToken, loadNodeId, STEWARD_HOME } from "./config";
import { openDb } from "./db";
import { createServer, VERSION } from "./server";
import { runScan } from "./indexer/scan";
import { runDataScan } from "./indexer/data";
import { startWatcher } from "./indexer/watch";

const cfg = loadConfig();
const token = loadToken();
const nodeId = loadNodeId();
const db = openDb();
const { fetch, websocket } = createServer(db, cfg, token, nodeId);

const server = Bun.serve({
  port: cfg.port,
  hostname: cfg.bind,
  // Default is 10s, which kills slow-but-legitimate requests (large uploads,
  // fleet proxying, HLS transcode start). 0 disables the idle timeout.
  idleTimeout: 0,
  fetch,
  websocket,
});

console.log(`steward ${VERSION} — node "${cfg.nodeName}"`);
console.log(`listening on http://127.0.0.1:${server.port} (data in ${STEWARD_HOME})`);

// Initial scans on boot; the watcher handles change-driven rescans, with a
// slow periodic fallback in case watches drop events.
runScan(db, cfg)
  .then(() => runDataScan(db, cfg))
  .catch((err) => console.error("initial scan failed:", err));
setInterval(() => {
  runScan(db, cfg).catch((err) => console.error("periodic scan failed:", err));
}, 60 * 60 * 1000);
if (cfg.watch) startWatcher(db, cfg);
