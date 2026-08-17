import type { Hono } from "hono";
import { basename, dirname } from "path";
import { createReadStream, statSync } from "fs";
import * as ops from "../fsops";

function errStatus(err: unknown): { status: number; message: string } {
  if (err instanceof ops.FsError) return { status: err.status, message: err.message };
  return { status: 500, message: String(err instanceof Error ? err.message : err) };
}

/** Wrap an op so FsErrors map to HTTP statuses. */
async function handle<T>(c: any, fn: () => Promise<T>) {
  try {
    return c.json(await fn());
  } catch (err) {
    const { status, message } = errStatus(err);
    return c.json({ error: message }, status);
  }
}

export function registerFsRoutes(app: Hono) {
  app.get("/api/fs/list", (c) => handle(c, () => ops.listDir(c.req.query("path") ?? "~")));

  app.get("/api/fs/stat", (c) => handle(c, () => ops.statOne(c.req.query("path") ?? "~")));

  app.get("/api/fs/read", async (c) => {
    try {
      const full = ops.resolveSafe(c.req.query("path") ?? "");
      const st = statSync(full);
      if (st.isDirectory()) return c.json({ error: "is a directory" }, 400);
      const name = basename(full);
      const headers: Record<string, string> = {
        "content-type": ops.guessMime(name),
        "content-length": String(st.size),
      };
      if (c.req.query("download")) {
        headers["content-disposition"] = `attachment; filename="${name.replace(/"/g, "")}"`;
      }
      const stream = createReadStream(full);
      return new Response(stream as any, { headers });
    } catch (err) {
      const { status, message } = errStatus(err);
      return c.json({ error: message }, status as any);
    }
  });

  app.get("/api/fs/text", async (c) => {
    try {
      const full = ops.resolveSafe(c.req.query("path") ?? "");
      const st = statSync(full);
      if (st.isDirectory()) return c.json({ error: "is a directory" }, 400);
      if (st.size > 5 * 1024 * 1024) return c.json({ error: "file too large for the editor (5 MB max)" }, 413);
      if (!(await ops.isTextFile(full))) return c.json({ error: "binary file", binary: true }, 415);
      const content = await Bun.file(full).text();
      return c.json({ path: full, content, size: st.size, mtime: st.mtimeMs });
    } catch (err) {
      const { status, message } = errStatus(err);
      return c.json({ error: message }, status as any);
    }
  });

  // Download a directory as a zip stream (files stream directly via /read).
  app.get("/api/fs/download", async (c) => {
    try {
      const full = ops.resolveSafe(c.req.query("path") ?? "");
      const st = statSync(full);
      const name = basename(full);
      if (!st.isDirectory()) {
        return c.redirect(`/api/fs/read?path=${encodeURIComponent(full)}&download=1&token=${c.req.query("token") ?? ""}`);
      }
      const proc = Bun.spawn(["zip", "-qr", "-", name], { cwd: dirname(full), stdout: "pipe", stderr: "ignore" });
      return new Response(proc.stdout, {
        headers: {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="${name.replace(/"/g, "")}.zip"`,
        },
      });
    } catch (err) {
      const { status, message } = errStatus(err);
      return c.json({ error: message }, status as any);
    }
  });

  app.post("/api/fs/write", async (c) => {
    const body = await c.req.json();
    return handle(c, () => ops.writeFile(body.path, body.content ?? ""));
  });

  app.post("/api/fs/upload", async (c) => {
    const dir = c.req.query("dir") ?? "~";
    const body = await c.req.parseBody({ all: true });
    const raw = body["files"] ?? body["file"];
    const files = (Array.isArray(raw) ? raw : [raw]).filter((f): f is File => f instanceof File);
    if (files.length === 0) return c.json({ error: "no files" }, 400);
    return handle(c, async () => {
      const saved = [];
      for (const f of files) saved.push(await ops.uploadFile(dir, f));
      return { saved };
    });
  });

  app.post("/api/fs/mkdir", async (c) => {
    const body = await c.req.json();
    return handle(c, () => ops.mkdir(body.path));
  });

  app.post("/api/fs/rename", async (c) => {
    const body = await c.req.json();
    return handle(c, () => ops.rename(body.from, body.to));
  });

  app.post("/api/fs/copy", async (c) => {
    const body = await c.req.json();
    return handle(c, () => ops.copy(body.from, body.to));
  });

  app.post("/api/fs/delete", async (c) => {
    const body = await c.req.json();
    return handle(c, () => ops.remove(body.paths ?? [], !!body.permanent));
  });

  app.post("/api/fs/chmod", async (c) => {
    const body = await c.req.json();
    return handle(c, () => ops.chmod(body.path, String(body.mode), !!body.recursive));
  });

  app.post("/api/fs/link", async (c) => {
    const body = await c.req.json();
    return handle(c, () => ops.makeLink(body.target, body.path, body.kind === "hard" ? "hard" : "symlink"));
  });

  app.get("/api/fs/search", (c) =>
    handle(c, async () => ({
      results: await ops.search(c.req.query("dir") ?? "~", c.req.query("q") ?? ""),
    }))
  );
}
