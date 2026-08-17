// Two nodes pair via the one-time-code flow, then A browses B's files and
// runs a terminal on B, all through A's proxy routes.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { writeFileSync } from "fs";
import { join } from "path";
import { startTestServer, testConfig, tmpHomeDir, type TestServer } from "./helpers";

const { dir, cleanup } = tmpHomeDir("fleet");
let nodeA: TestServer;
let nodeB: TestServer;
let bId: string;

beforeAll(() => {
  writeFileSync(join(dir, "on-node-b.txt"), "remote file content");
  nodeA = startTestServer(testConfig({ nodeName: "alpha" }), { token: "token-alpha", nodeId: "stw-alpha" });
  nodeB = startTestServer(testConfig({ nodeName: "beta" }), { token: "token-beta", nodeId: "stw-beta" });
});
afterAll(() => {
  nodeA.stop();
  nodeB.stop();
  cleanup();
});

test("pairing: code on B, completed from A", async () => {
  const { code } = await (await nodeB.api("/api/fleet/pairing/start", { method: "POST" })).json();
  expect(code).toMatch(/^\d{6}$/);

  const res = await nodeA.api("/api/fleet/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: nodeB.base, code }),
  });
  const body = await res.json();
  expect(res.status).toBe(200);
  expect(body.paired.name).toBe("beta");
  bId = body.paired.id;
  expect(bId).toBe("stw-beta");

  // Both sides now list each other.
  const aNodes = await (await nodeA.api("/api/fleet/nodes")).json();
  expect(aNodes.nodes.map((n: any) => n.id)).toContain("stw-beta");
  expect(aNodes.nodes[0].online).toBe(true);
  expect(aNodes.nodes[0].status.nodeName).toBe("beta");
  // token must never leak in listings
  expect(JSON.stringify(aNodes)).not.toContain("token-beta");

  const bNodes = await (await nodeB.api("/api/fleet/nodes")).json();
  expect(bNodes.nodes.map((n: any) => n.id)).toContain("stw-alpha");
});

test("pairing code is single-use and wrong codes fail", async () => {
  const { code } = await (await nodeB.api("/api/fleet/pairing/start", { method: "POST" })).json();
  const bad = await nodeA.api("/api/fleet/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: nodeB.base, code: code === "000000" ? "000001" : "000000" }),
  });
  expect(bad.status).toBe(502);
  const good = await nodeA.api("/api/fleet/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: nodeB.base, code }),
  });
  expect(good.status).toBe(200);
  // reuse fails
  const reuse = await nodeA.api("/api/fleet/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: nodeB.base, code }),
  });
  expect(reuse.status).toBe(502);
});

test("proxy: browse remote files through node A", async () => {
  const res = await nodeA.api(`/api/nodes/${bId}/proxy/fs/list?path=${encodeURIComponent(dir)}`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.entries.map((e: any) => e.name)).toContain("on-node-b.txt");
});

test("proxy: write a file on the remote node", async () => {
  const res = await nodeA.api(`/api/nodes/${bId}/proxy/fs/write`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: join(dir, "written-via-proxy.txt"), content: "hello beta" }),
  });
  expect(res.status).toBe(200);
  const read = await nodeA.api(`/api/nodes/${bId}/proxy/fs/text?path=${encodeURIComponent(join(dir, "written-via-proxy.txt"))}`);
  expect((await read.json()).content).toBe("hello beta");
});

test("proxy: unauthorized callers cannot use the proxy", async () => {
  const res = await fetch(`${nodeA.base}/api/nodes/${bId}/proxy/fs/list?path=${encodeURIComponent(dir)}`);
  expect(res.status).toBe(401);
});

test("proxy: unknown node id is a 404", async () => {
  const res = await nodeA.api("/api/nodes/stw-nope/proxy/fs/list");
  expect(res.status).toBe(404);
});

test("remote terminal through the websocket proxy", async () => {
  const ws = new WebSocket(`${nodeA.wsBase}/api/nodes/${bId}/term?token=token-alpha`);
  let out = "";
  ws.addEventListener("message", (ev) => {
    try {
      const m = JSON.parse(String(ev.data));
      if (m.t === "data") out += m.data;
    } catch {}
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  ws.send(JSON.stringify({ t: "input", data: "echo fleet_$((2**5))\r" }));
  const start = Date.now();
  while (!out.includes("fleet_32")) {
    if (Date.now() - start > 8000) throw new Error(`timeout; got: ${out.slice(-200)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(out).toContain("fleet_32");
  ws.close();
}, 15000);

test("unpair removes the node", async () => {
  await nodeA.api(`/api/fleet/nodes/${bId}`, { method: "DELETE" });
  const nodes = await (await nodeA.api("/api/fleet/nodes")).json();
  expect(nodes.nodes.map((n: any) => n.id)).not.toContain(bId);
  // re-pair for any later tests
  const { code } = await (await nodeB.api("/api/fleet/pairing/start", { method: "POST" })).json();
  await nodeA.api("/api/fleet/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: nodeB.base, code }),
  });
});
