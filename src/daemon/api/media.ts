// Media streaming: on-demand HLS transcoding via ffmpeg. Lets the browser
// play anything ffmpeg can read (mkv, hevc, avi, ...) and start playback
// while the transcode is still running. Native-format files play directly
// from /api/fs/read (which supports Range requests for seeking).
import type { Hono } from "hono";
import { createHash } from "crypto";
import { existsSync, mkdirSync, statSync, readdirSync, rmSync, createReadStream } from "fs";
import { join, basename } from "path";
import type { Subprocess } from "bun";
import { STEWARD_HOME } from "../config";
import { resolveSafe, FsError } from "../fsops";

const HLS_ROOT = join(STEWARD_HOME, "cache", "hls");
const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type Job = { proc: Subprocess; dir: string; startedAt: number };
const jobs = new Map<string, Job>();

let ffmpegPath: string | null | undefined;
export function findFfmpeg(): string | null {
  if (ffmpegPath !== undefined) return ffmpegPath;
  for (const p of ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]) {
    if (existsSync(p)) return (ffmpegPath = p);
  }
  ffmpegPath = Bun.which("ffmpeg");
  return ffmpegPath;
}

/** Formats browsers generally decode natively (direct playback preferred). */
export const NATIVE_VIDEO = new Set(["mp4", "webm", "m4v"]);
export const NATIVE_AUDIO = new Set(["mp3", "wav", "m4a", "aac", "ogg", "flac"]);

/** Unguessable id: keyed on the daemon token so the auth-exempt segment
 *  routes can't be enumerated by path guessing. */
function hlsId(full: string, token: string): string {
  const st = statSync(full);
  return createHash("sha256").update(`${token}|${full}|${st.mtimeMs}|${st.size}`).digest("hex").slice(0, 32);
}

export function cleanupHlsCache(): void {
  try {
    if (!existsSync(HLS_ROOT)) return;
    for (const entry of readdirSync(HLS_ROOT)) {
      const dir = join(HLS_ROOT, entry);
      try {
        if (Date.now() - statSync(dir).mtimeMs > MAX_CACHE_AGE_MS) {
          rmSync(dir, { recursive: true, force: true });
        }
      } catch {}
    }
  } catch {}
}

async function waitForFile(path: string, ms: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return existsSync(path);
}

export function registerMediaRoutes(app: Hono, token: string) {
  app.get("/api/media/info", (c) => {
    const path = c.req.query("path") ?? "";
    const ext = basename(path).toLowerCase().split(".").pop() ?? "";
    return c.json({
      ffmpeg: !!findFfmpeg(),
      nativeVideo: NATIVE_VIDEO.has(ext),
      nativeAudio: NATIVE_AUDIO.has(ext),
    });
  });

  // Start (or reuse) a transcode; returns the playlist URL once it exists.
  app.post("/api/media/hls/start", async (c) => {
    try {
      const full = resolveSafe((await c.req.json()).path ?? "");
      const ffmpeg = findFfmpeg();
      if (!ffmpeg) return c.json({ error: "ffmpeg is not installed on this node" }, 501);
      const id = hlsId(full, token);
      const dir = join(HLS_ROOT, id);
      const playlist = join(dir, "index.m3u8");
      const done = join(dir, ".done");
      mkdirSync(dir, { recursive: true });

      if (!existsSync(done) && !jobs.has(id)) {
        const proc = Bun.spawn(
          [
            ffmpeg, "-y", "-i", full,
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
            "-maxrate", "6M", "-bufsize", "12M",
            "-c:a", "aac", "-b:a", "160k", "-ac", "2",
            "-f", "hls", "-hls_time", "4", "-hls_list_size", "0",
            "-hls_segment_filename", join(dir, "seg_%05d.ts"),
            playlist,
          ],
          { stdout: "ignore", stderr: "ignore" }
        );
        jobs.set(id, { proc, dir, startedAt: Date.now() });
        proc.exited.then(async (code) => {
          jobs.delete(id);
          if (code === 0) await Bun.write(done, "ok");
        });
      }
      const ready = await waitForFile(playlist, 15_000);
      if (!ready) return c.json({ error: "transcode did not start (unsupported or unreadable file?)" }, 502);
      return c.json({ url: `/api/media/hls/${id}/index.m3u8`, transcoding: jobs.has(id) });
    } catch (err) {
      if (err instanceof FsError) return c.json({ error: err.message }, err.status as any);
      return c.json({ error: String(err instanceof Error ? err.message : err) }, 500);
    }
  });

  // Playlist + segments. Auth-exempt in the middleware: hls ids are derived
  // from the daemon token and thus unguessable; video element segment
  // requests cannot carry bearer headers.
  app.get("/api/media/hls/:id/:file", (c) => {
    const id = c.req.param("id");
    const file = c.req.param("file");
    if (!/^[a-f0-9]{32}$/.test(id) || !/^[\w.-]+$/.test(file) || file.includes("..")) {
      return c.json({ error: "bad request" }, 400);
    }
    const full = join(HLS_ROOT, id, file);
    if (!existsSync(full)) return c.json({ error: "not found" }, 404);
    const type = file.endsWith(".m3u8")
      ? "application/vnd.apple.mpegurl"
      : file.endsWith(".ts")
        ? "video/mp2t"
        : "application/octet-stream";
    return new Response(createReadStream(full) as any, {
      headers: { "content-type": type, "cache-control": "no-store" },
    });
  });
}
