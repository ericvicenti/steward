import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import { serveStatic } from "hono/bun";
import { join } from "path";
import type { Database } from "bun:sqlite";
import type { StewardConfig } from "./config";
import { bus } from "./events";
import { runScan, isScanRunning } from "./indexer/scan";
import { runDataScan, isDataScanRunning } from "./indexer/data";
import type { RepoRow } from "./db";
import { registerFsRoutes } from "./api/fs";
import { createTermHandlers } from "./api/term";
import { registerFleetRoutes } from "./api/fleet";
import { registerMediaRoutes, cleanupHlsCache } from "./api/media";
import { currentCommit, checkForUpdate, applyUpdate, isUpdating } from "./updater";

const UI_DIST = join(import.meta.dir, "../../dist/ui");
export const VERSION = "0.4.0";

export function createServer(db: Database, cfg: StewardConfig, token: string, nodeId = "stw-dev") {
  cleanupHlsCache();
  const { upgradeWebSocket, websocket } = createBunWebSocket();
  const app = new Hono();

  const authed = (c: { req: { header: (h: string) => string | undefined; query: (k: string) => string | undefined } }) => {
    const header = c.req.header("authorization");
    if (header === `Bearer ${token}`) return true;
    return c.req.query("token") === token;
  };

  app.use("/api/*", async (c, next) => {
    // Pairing completion is called by a not-yet-trusted peer; the one-time
    // code is its gate.
    if (c.req.path === "/api/fleet/pairing/complete") return next();
    // HLS segment requests come from <video> without headers; their ids are
    // unguessable (derived from the serving daemon's token). Also allow them
    // through the fleet proxy for remote playback.
    if (c.req.method === "GET" && /^\/api\/(nodes\/[^/]+\/proxy\/)?media\/hls\//.test(c.req.path)) return next();
    if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  let commitCache = "";
  currentCommit().then((c) => (commitCache = c));

  app.get("/api/status", (c) => {
    const counts = db
      .query(
        `SELECT
           COUNT(*) AS repos,
           SUM(risk = 'at-risk') AS atRisk,
           SUM(risk = 'attention') AS attention,
           SUM(risk = 'safe') AS safe,
           SUM(junk_bytes) AS junkBytes,
           MAX(scanned_at) AS lastScanAt
         FROM repos`
      )
      .get() as Record<string, number | null>;
    const data = db
      .query(`SELECT SUM(size_bytes) AS dataBytes, SUM(cache_bytes) AS dataCacheBytes FROM data_dirs`)
      .get() as Record<string, number | null>;
    return c.json({
      nodeName: cfg.nodeName,
      version: VERSION,
      commit: commitCache,
      updating: isUpdating(),
      roots: cfg.roots,
      scanning: isScanRunning(),
      dataScanning: isDataScanRunning(),
      watching: cfg.watch,
      ...counts,
      ...data,
    });
  });

  // Self-update: ?check=1 reports drift from origin; otherwise pull, rebuild,
  // and restart (the supervisor relaunches us on the new code). Fleet peers
  // call this to keep each other current.
  app.post("/api/system/update", async (c) => {
    if (c.req.query("check")) return c.json(await checkForUpdate());
    if (!cfg.autoUpdate) return c.json({ error: "autoUpdate is disabled on this node" }, 403);
    const check = await checkForUpdate();
    if (check.error) return c.json({ ok: false, detail: check.error }, 502);
    if (check.behind === 0) return c.json({ ok: true, detail: "already up to date", commit: check.commit });
    return c.json(await applyUpdate());
  });

  app.get("/api/data", (c) => {
    const rows = db
      .query("SELECT * FROM data_dirs ORDER BY size_bytes DESC")
      .all() as Record<string, unknown>[];
    return c.json({ roots: cfg.dataRoots, dirs: rows });
  });

  app.get("/api/repos", (c) => {
    const rows = db.query("SELECT * FROM repos ORDER BY path").all() as RepoRow[];
    return c.json(
      rows.map((r) => ({
        ...r,
        remotes: JSON.parse(r.remotes),
        risk_reasons: JSON.parse(r.risk_reasons),
      }))
    );
  });

  app.post("/api/scan", (c) => {
    if (!isScanRunning()) {
      runScan(db, cfg).catch((err) => console.error("scan error:", err));
    }
    if (!isDataScanRunning()) {
      runDataScan(db, cfg).catch((err) => console.error("data scan error:", err));
    }
    return c.json({ started: true });
  });

  registerFsRoutes(app);
  registerMediaRoutes(app, token);
  registerFleetRoutes(app, db, cfg, nodeId, token, upgradeWebSocket);

  app.get(
    "/api/term",
    upgradeWebSocket((c) => {
      if (!authed(c)) return {};
      return createTermHandlers(c.req.query("cwd")) as any;
    })
  );

  app.get(
    "/api/events",
    upgradeWebSocket((c) => {
      if (!authed(c)) return {}; // no handlers; socket opens but receives nothing
      let unsub = () => {};
      return {
        onOpen(_ev, ws) {
          unsub = bus.subscribe((event) => ws.send(JSON.stringify(event)));
        },
        onClose() {
          unsub();
        },
      };
    })
  );

  // Hashed assets are immutable; HTML must revalidate so deploys (which
  // replace the asset hashes) never strand a stale index.html in a browser.
  app.use("/*", async (c, next) => {
    await next();
    if (c.req.path.startsWith("/assets/")) {
      c.header("cache-control", "public, max-age=31536000, immutable");
    } else if ((c.res.headers.get("content-type") ?? "").includes("text/html")) {
      c.header("cache-control", "no-cache");
    }
  });
  app.use("/*", serveStatic({ root: UI_DIST }));
  app.get("*", serveStatic({ path: join(UI_DIST, "index.html") }));

  return { fetch: app.fetch, websocket };
}
