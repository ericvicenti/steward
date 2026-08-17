import { loadConfig, loadToken, STEWARD_HOME } from "./config";
import { openDb } from "./db";
import { createServer, VERSION } from "./server";
import { runScan } from "./indexer/scan";

const cfg = loadConfig();
const token = loadToken();
const db = openDb();
const { fetch, websocket } = createServer(db, cfg, token);

const server = Bun.serve({
  port: cfg.port,
  hostname: "127.0.0.1",
  fetch,
  websocket,
});

console.log(`steward ${VERSION} — node "${cfg.nodeName}"`);
console.log(`listening on http://127.0.0.1:${server.port} (data in ${STEWARD_HOME})`);

// Initial scan on boot, then rescan every 30 minutes.
runScan(db, cfg).catch((err) => console.error("initial scan failed:", err));
setInterval(() => {
  runScan(db, cfg).catch((err) => console.error("periodic scan failed:", err));
}, 30 * 60 * 1000);
