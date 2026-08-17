import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { writeFileSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { startTestServer, TEST_TOKEN, type TestServer } from "./helpers";
import { tmpHomeDir } from "./helpers";

const { dir, cleanup } = tmpHomeDir("api");
let srv: TestServer;

beforeAll(() => {
  writeFileSync(join(dir, "readable.txt"), "file contents here");
  writeFileSync(join(dir, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  mkdirSync(join(dir, "zipme"));
  writeFileSync(join(dir, "zipme", "inner.txt"), "zip inner");
  srv = startTestServer();
});
afterAll(() => {
  srv.stop();
  cleanup();
});

describe("auth", () => {
  test("rejects missing token", async () => {
    const res = await fetch(`${srv.base}/api/status`);
    expect(res.status).toBe(401);
  });
  test("rejects wrong token", async () => {
    const res = await fetch(`${srv.base}/api/status`, {
      headers: { authorization: "Bearer nope" },
    });
    expect(res.status).toBe(401);
  });
  test("accepts bearer header and query token", async () => {
    expect((await srv.api("/api/status")).status).toBe(200);
    expect((await fetch(`${srv.base}/api/status?token=${TEST_TOKEN}`)).status).toBe(200);
  });
});

describe("status", () => {
  test("reports node info", async () => {
    const s = await (await srv.api("/api/status")).json();
    expect(s.nodeName).toBe("test-node");
    expect(s.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("fs over http", () => {
  test("list", async () => {
    const res = await srv.api(`/api/fs/list?path=${encodeURIComponent(dir)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries.map((e: any) => e.name)).toContain("readable.txt");
  });
  test("list outside home is 403", async () => {
    const res = await srv.api("/api/fs/list?path=/etc");
    expect(res.status).toBe(403);
  });
  test("read streams file with mime", async () => {
    const res = await srv.api(`/api/fs/read?path=${encodeURIComponent(join(dir, "image.png"))}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect((await res.arrayBuffer()).byteLength).toBe(6);
  });
  test("text endpoint returns content for text, 415 for binary", async () => {
    const ok = await srv.api(`/api/fs/text?path=${encodeURIComponent(join(dir, "readable.txt"))}`);
    expect((await ok.json()).content).toBe("file contents here");
    const bad = await srv.api(`/api/fs/text?path=${encodeURIComponent(join(dir, "image.png"))}`);
    expect(bad.status).toBe(415);
  });
  test("write via POST", async () => {
    const res = await srv.api("/api/fs/write", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: join(dir, "posted.txt"), content: "from api" }),
    });
    expect(res.status).toBe(200);
    expect(readFileSync(join(dir, "posted.txt"), "utf8")).toBe("from api");
  });
  test("upload multipart", async () => {
    const fd = new FormData();
    fd.append("files", new File(["upload body"], "uploaded.txt", { type: "text/plain" }));
    fd.append("files", new File(["second"], "uploaded2.txt", { type: "text/plain" }));
    const res = await srv.api(`/api/fs/upload?dir=${encodeURIComponent(dir)}`, {
      method: "POST",
      body: fd,
    });
    expect(res.status).toBe(200);
    expect(readFileSync(join(dir, "uploaded.txt"), "utf8")).toBe("upload body");
    expect(readFileSync(join(dir, "uploaded2.txt"), "utf8")).toBe("second");
  });
  test("upload strips path components from filenames", async () => {
    const fd = new FormData();
    fd.append("files", new File(["evil"], "../../../escape.txt", { type: "text/plain" }));
    const res = await srv.api(`/api/fs/upload?dir=${encodeURIComponent(dir)}`, {
      method: "POST",
      body: fd,
    });
    const body = await res.json();
    expect(body.saved[0].path).toBe(join(dir, "escape.txt"));
  });
  test("download dir as zip", async () => {
    const res = await srv.api(`/api/fs/download?path=${encodeURIComponent(join(dir, "zipme"))}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 2).toString()).toBe("PK"); // zip magic
    expect(buf.length).toBeGreaterThan(50);
  });
  test("search", async () => {
    const res = await srv.api(
      `/api/fs/search?dir=${encodeURIComponent(dir)}&q=readable`
    );
    const body = await res.json();
    expect(body.results.some((r: string) => r.endsWith("readable.txt"))).toBe(true);
  });
  test("chmod + stat roundtrip", async () => {
    await srv.api("/api/fs/chmod", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: join(dir, "readable.txt"), mode: "640" }),
    });
    const st = await (
      await srv.api(`/api/fs/stat?path=${encodeURIComponent(join(dir, "readable.txt"))}`)
    ).json();
    expect((st.mode & 0o777).toString(8)).toBe("640");
    expect(st.user).toBeTruthy();
  });
});
