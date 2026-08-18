// Range requests (seeking) and HLS transcoding.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { writeFileSync, existsSync } from "fs";
import { join } from "path";
import { startTestServer, tmpHomeDir, type TestServer } from "./helpers";
import { findFfmpeg } from "../src/daemon/api/media";

const { dir, cleanup } = tmpHomeDir("media");
let srv: TestServer;
const FFMPEG = findFfmpeg();

beforeAll(() => {
  writeFileSync(join(dir, "seekme.bin"), "0123456789ABCDEF");
  srv = startTestServer();
});
afterAll(() => {
  srv.stop();
  cleanup();
});

test("read supports byte ranges (media seeking)", async () => {
  const url = `/api/fs/read?path=${encodeURIComponent(join(dir, "seekme.bin"))}`;

  const whole = await srv.api(url);
  expect(whole.status).toBe(200);
  expect(whole.headers.get("accept-ranges")).toBe("bytes");
  expect(await whole.text()).toBe("0123456789ABCDEF");

  const mid = await srv.api(url, { headers: { range: "bytes=4-7" } });
  expect(mid.status).toBe(206);
  expect(mid.headers.get("content-range")).toBe("bytes 4-7/16");
  expect(await mid.text()).toBe("4567");

  const openEnded = await srv.api(url, { headers: { range: "bytes=10-" } });
  expect(openEnded.status).toBe(206);
  expect(await openEnded.text()).toBe("ABCDEF");

  const suffix = await srv.api(url, { headers: { range: "bytes=-3" } });
  expect(suffix.status).toBe(206);
  expect(await suffix.text()).toBe("DEF");

  const bad = await srv.api(url, { headers: { range: "bytes=99-" } });
  expect(bad.status).toBe(416);
});

test("media info reports ffmpeg and native formats", async () => {
  const res = await srv.api(`/api/media/info?path=${encodeURIComponent("/x/movie.mkv")}`);
  const info = await res.json();
  expect(typeof info.ffmpeg).toBe("boolean");
  expect(info.nativeVideo).toBe(false);
  const mp4 = await (await srv.api(`/api/media/info?path=${encodeURIComponent("/x/a.mp4")}`)).json();
  expect(mp4.nativeVideo).toBe(true);
});

test.skipIf(!FFMPEG)(
  "HLS transcode: playlist appears while transcoding, segments are served without auth",
  async () => {
    // Generate a real 3s test video (mkv container -> not browser-native).
    const src = join(dir, "clip.mkv");
    const gen = Bun.spawn(
      [FFMPEG!, "-y", "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=15", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-shortest", src],
      { stdout: "ignore", stderr: "ignore" }
    );
    expect(await gen.exited).toBe(0);
    expect(existsSync(src)).toBe(true);

    const start = await srv.api("/api/media/hls/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: src }),
    });
    expect(start.status).toBe(200);
    const { url } = await start.json();
    expect(url).toMatch(/^\/api\/media\/hls\/[a-f0-9]{32}\/index\.m3u8$/);

    // Playlist and segments are fetchable WITHOUT a token (video elements
    // can't send bearer headers); the id itself is the secret.
    const playlist = await fetch(`${srv.base}${url}`);
    expect(playlist.status).toBe(200);
    expect(playlist.headers.get("content-type")).toContain("mpegurl");
    const text = await playlist.text();
    expect(text).toContain("#EXTM3U");
    const seg = text.split("\n").find((l) => l.endsWith(".ts"));
    expect(seg).toBeTruthy();
    const segRes = await fetch(`${srv.base}${url.replace("index.m3u8", seg!)}`);
    expect(segRes.status).toBe(200);
    expect((await segRes.arrayBuffer()).byteLength).toBeGreaterThan(1000);

    // Guessed/garbage ids are rejected.
    expect((await fetch(`${srv.base}/api/media/hls/${"0".repeat(32)}/index.m3u8`)).status).toBe(404);
    expect((await fetch(`${srv.base}/api/media/hls/../../etc/index.m3u8`)).status).not.toBe(200);
  },
  60000
);

test("HLS start requires auth", async () => {
  const res = await fetch(`${srv.base}/api/media/hls/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "/tmp/x.mkv" }),
  });
  expect(res.status).toBe(401);
});
