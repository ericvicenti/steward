import { test, expect, beforeAll, afterAll } from "bun:test";
import { startTestServer, TEST_TOKEN, type TestServer } from "./helpers";

let srv: TestServer;
beforeAll(() => {
  srv = startTestServer();
});
afterAll(() => srv.stop());

function collect(ws: WebSocket): { output: () => string } {
  let out = "";
  ws.addEventListener("message", (ev) => {
    try {
      const msg = JSON.parse(String(ev.data));
      if (msg.t === "data") out += msg.data;
    } catch {}
  });
  return { output: () => out };
}

async function until(fn: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for terminal output");
    await new Promise((r) => setTimeout(r, 100));
  }
}

test("terminal runs a real shell over websocket", async () => {
  const ws = new WebSocket(`${srv.wsBase}/api/term?token=${TEST_TOKEN}`);
  const buf = collect(ws);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  ws.send(JSON.stringify({ t: "input", data: "echo steward_$((40+2))\r" }));
  await until(() => buf.output().includes("steward_42"));
  expect(buf.output()).toContain("steward_42");
  ws.close();
}, 15000);

test("terminal resize is applied", async () => {
  const ws = new WebSocket(`${srv.wsBase}/api/term?token=${TEST_TOKEN}`);
  const buf = collect(ws);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  ws.send(JSON.stringify({ t: "resize", cols: 97, rows: 41 }));
  ws.send(JSON.stringify({ t: "input", data: "stty size\r" }));
  await until(() => /41 97/.test(buf.output()));
  expect(buf.output()).toMatch(/41 97/);
  ws.close();
}, 15000);

test("terminal websocket without token is refused", async () => {
  const ws = new WebSocket(`${srv.wsBase}/api/term`);
  const buf = collect(ws);
  let opened = false;
  ws.addEventListener("open", () => {
    opened = true;
    ws.send(JSON.stringify({ t: "input", data: "echo leak_$((1+1))\r" }));
  });
  await new Promise((resolve) => {
    ws.addEventListener("close", resolve);
    ws.addEventListener("error", resolve);
    setTimeout(resolve, 3000);
  });
  // Either the upgrade was refused outright, or the socket opened with no
  // shell attached — in no case may shell output leak.
  expect(buf.output()).not.toContain("leak_2");
  if (opened) ws.close();
}, 10000);
