// Self-update endpoint + fleet convergence plumbing.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { startTestServer, testConfig, type TestServer } from "./helpers";
import { currentCommit } from "../src/daemon/updater";

let srv: TestServer;
beforeAll(() => {
  srv = startTestServer(); // autoUpdate: false in testConfig
});
afterAll(() => srv.stop());

test("status reports the running git commit", async () => {
  const proc = Bun.spawn(["git", "rev-parse", "--short", "HEAD"], { stdout: "pipe" });
  const expected = (await new Response(proc.stdout).text()).trim();
  expect(await currentCommit()).toBe(expected);
  // allow the server's async commit cache to fill
  const start = Date.now();
  let s: any;
  do {
    s = await (await srv.api("/api/status")).json();
    if (s.commit) break;
    await new Promise((r) => setTimeout(r, 100));
  } while (Date.now() - start < 3000);
  expect(s.commit).toBe(expected);
  expect(s.updating).toBe(false);
});

test("update is refused when autoUpdate is disabled", async () => {
  const res = await srv.api("/api/system/update", { method: "POST" });
  expect(res.status).toBe(403);
});

test("update check reports drift from origin", async () => {
  const res = await srv.api("/api/system/update?check=1", { method: "POST" });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.commit).toMatch(/^[a-f0-9]{7,}$/);
  // offline machines get an error field instead of a behind count
  if (!body.error) expect(body.behind).toBeGreaterThanOrEqual(0);
}, 30000);

test("update endpoint on an up-to-date autoUpdate node is a safe no-op", async () => {
  const enabled = startTestServer(testConfig({ autoUpdate: true }));
  try {
    const res = await enabled.api("/api/system/update", { method: "POST" });
    const body = await res.json();
    // dev checkouts are at-or-ahead of origin, so this must NOT restart
    if (res.status === 200) expect(body.detail ?? "").toContain("up to date");
  } finally {
    enabled.stop();
  }
}, 30000);
