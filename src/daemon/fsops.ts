// Filesystem operations for the Files UI. The whole filesystem is reachable
// (like the terminal); OS permissions are the real boundary. Destructive ops
// refuse a short list of catastrophic targets.
import { promises as fsp } from "fs";
import { homedir } from "os";
import { join, resolve, sep, dirname, basename } from "path";

const HOME = homedir();

export class FsError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function expandPath(p: string): string {
  if (!p) return HOME;
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return join(HOME, p.slice(2));
  return p;
}

/** Normalize to an absolute path (full filesystem access, like the shell). */
export function resolveSafe(p: string): string {
  return resolve(expandPath(p));
}

/** Paths we refuse to delete/overwrite wholesale, ever. */
export function isProtectedPath(abs: string): boolean {
  if (abs === "/" || abs === HOME) return true;
  const depth = abs.split(sep).filter(Boolean).length;
  return depth <= 1; // /System, /Users, /Library, /etc, ...
}

export type FsEntryType = "file" | "dir" | "symlink";
export interface FsEntry {
  name: string;
  type: FsEntryType;
  size: number;
  mtime: number;
  mode: number; // permission bits only (0o7777)
  uid: number;
  gid: number;
  nlink: number;
  ino: number;
  hidden: boolean;
  target: string | null; // symlink target
  targetType: "dir" | "file" | "missing" | null;
}

async function run(cmd: string[], cwd?: string): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, out: out.trim(), err: err.trim() };
}

const userCache = new Map<number, string>();
const groupCache = new Map<number, string>();

async function username(uid: number): Promise<string> {
  const hit = userCache.get(uid);
  if (hit) return hit;
  const { code, out } = await run(["id", "-nu", String(uid)]);
  const name = code === 0 && out ? out : String(uid);
  userCache.set(uid, name);
  return name;
}

async function groupname(gid: number): Promise<string> {
  const hit = groupCache.get(gid);
  if (hit) return hit;
  let name = String(gid);
  if (process.platform === "darwin") {
    const { code, out } = await run(["dscacheutil", "-q", "group", "-a", "gid", String(gid)]);
    const m = code === 0 ? out.match(/^name: (.+)$/m) : null;
    if (m) name = m[1];
  } else {
    const { code, out } = await run(["getent", "group", String(gid)]);
    if (code === 0 && out) name = out.split(":")[0];
  }
  groupCache.set(gid, name);
  return name;
}

export async function statEntry(dir: string, name: string): Promise<FsEntry | null> {
  const full = join(dir, name);
  const ls = await fsp.lstat(full).catch(() => null);
  if (!ls) return null;
  const isLink = ls.isSymbolicLink();
  let target: string | null = null;
  let targetType: FsEntry["targetType"] = null;
  if (isLink) {
    target = await fsp.readlink(full).catch(() => null);
    const rs = await fsp.stat(full).catch(() => null);
    targetType = rs ? (rs.isDirectory() ? "dir" : "file") : "missing";
  }
  return {
    name,
    type: isLink ? "symlink" : ls.isDirectory() ? "dir" : "file",
    size: ls.size,
    mtime: ls.mtimeMs,
    mode: ls.mode & 0o7777,
    uid: ls.uid,
    gid: ls.gid,
    nlink: ls.nlink,
    ino: ls.ino,
    hidden: name.startsWith("."),
    target,
    targetType,
  };
}

export async function listDir(path: string) {
  const dir = resolveSafe(path);
  const st = await fsp.stat(dir).catch(() => null);
  if (!st) throw new FsError(404, "not found");
  if (!st.isDirectory()) throw new FsError(400, "not a directory");
  const names = await fsp.readdir(dir);
  const entries = (await Promise.all(names.map((n) => statEntry(dir, n)))).filter(
    (e): e is FsEntry => e !== null
  );
  const users: Record<number, string> = {};
  const groups: Record<number, string> = {};
  for (const uid of new Set(entries.map((e) => e.uid))) users[uid] = await username(uid);
  for (const gid of new Set(entries.map((e) => e.gid))) groups[gid] = await groupname(gid);
  return {
    path: dir,
    parent: dir === "/" ? null : dirname(dir),
    home: HOME,
    entries,
    users,
    groups,
  };
}

export async function statOne(path: string) {
  const full = resolveSafe(path);
  const entry = await statEntry(dirname(full), basename(full));
  if (!entry) throw new FsError(404, "not found");
  return {
    path: full,
    ...entry,
    user: await username(entry.uid),
    group: await groupname(entry.gid),
  };
}

export async function writeFile(path: string, content: string) {
  const full = resolveSafe(path);
  await fsp.mkdir(dirname(full), { recursive: true });
  await Bun.write(full, content);
  return { path: full };
}

export async function uploadFile(dir: string, file: File) {
  // The filename may carry a relative path (folder uploads). Sanitize each
  // component: no empty, ".", "..", or absolute segments.
  const parts = file.name
    .split("/")
    .map((p) => p.trim())
    .filter((p) => p && p !== "." && p !== "..")
    .map((p) => p.replace(/^\.+$/, "_"));
  if (parts.length === 0) throw new FsError(400, "invalid filename");
  const full = resolveSafe(join(dir, ...parts));
  await fsp.mkdir(dirname(full), { recursive: true });
  await Bun.write(full, file);
  return { path: full };
}

export async function mkdir(path: string) {
  const full = resolveSafe(path);
  await fsp.mkdir(full, { recursive: true });
  return { path: full };
}

export async function rename(from: string, to: string) {
  const src = resolveSafe(from);
  const dst = resolveSafe(to);
  if (await fsp.lstat(dst).catch(() => null)) throw new FsError(409, `${dst} already exists`);
  try {
    await fsp.rename(src, dst);
  } catch {
    const { code, err } = await run(["mv", src, dst]);
    if (code !== 0) throw new FsError(500, err || "move failed");
  }
  return { path: dst };
}

export async function copy(from: string, to: string) {
  const src = resolveSafe(from);
  let dst = resolveSafe(to);
  // Copying onto itself: create "name copy" alongside, like Finder.
  if (dst === src) {
    const dir = dirname(src);
    const base = basename(src);
    let candidate = join(dir, `${base} copy`);
    for (let i = 2; await fsp.lstat(candidate).catch(() => null); i++) {
      candidate = join(dir, `${base} copy ${i}`);
    }
    dst = candidate;
  } else if (await fsp.lstat(dst).catch(() => null)) {
    throw new FsError(409, `${dst} already exists`);
  }
  // -a: recursive, preserve modes/times, don't follow symlinks.
  const { code, err } = await run(["cp", "-a", src, dst]);
  if (code !== 0) throw new FsError(500, err || "copy failed");
  return { path: dst };
}

export async function remove(paths: string[], permanent: boolean) {
  const resolved = paths.map(resolveSafe);
  const guarded = resolved.find(isProtectedPath);
  if (guarded) throw new FsError(400, `refusing to delete protected path ${guarded}`);
  const trashDir = join(HOME, ".Trash");
  const useTrash = !permanent && (await fsp.stat(trashDir).catch(() => null));
  for (const p of resolved) {
    if (useTrash) {
      let dst = join(trashDir, basename(p));
      for (let i = 2; await fsp.lstat(dst).catch(() => null); i++) {
        dst = join(trashDir, `${basename(p)} ${i}`);
      }
      const { code, err } = await run(["mv", p, dst]);
      if (code !== 0) throw new FsError(500, err || "trash failed");
    } else {
      await fsp.rm(p, { recursive: true, force: true });
    }
  }
  return { deleted: resolved.length, trashed: !!useTrash };
}

export async function chmod(path: string, mode: string, recursive: boolean) {
  const full = resolveSafe(path);
  if (!/^[0-7]{3,4}$/.test(mode)) throw new FsError(400, "mode must be octal like 644 or 0755");
  const args = recursive ? ["chmod", "-R", mode, full] : ["chmod", mode, full];
  const { code, err } = await run(args);
  if (code !== 0) throw new FsError(500, err || "chmod failed");
  return { path: full, mode };
}

export async function makeLink(target: string, path: string, kind: "symlink" | "hard") {
  const linkPath = resolveSafe(path);
  if (await fsp.lstat(linkPath).catch(() => null)) throw new FsError(409, `${linkPath} already exists`);
  if (kind === "hard") {
    const src = resolveSafe(target);
    const st = await fsp.lstat(src).catch(() => null);
    if (!st) throw new FsError(404, "link target not found");
    if (!st.isFile()) throw new FsError(400, "hard links only work for regular files");
    await fsp.link(src, linkPath);
  } else {
    // Symlink targets may be relative or absolute; store as given.
    await fsp.symlink(expandPath(target), linkPath);
  }
  return { path: linkPath };
}

export async function search(dir: string, q: string, limit = 200): Promise<string[]> {
  const root = resolveSafe(dir);
  if (!q.trim()) return [];
  const proc = Bun.spawn(
    ["find", root, "-iname", `*${q}*`, "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*"],
    { stdout: "pipe", stderr: "ignore" }
  );
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.split("\n").filter(Boolean).slice(0, limit);
}

export function guessMime(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", svg: "image/svg+xml", ico: "image/x-icon", avif: "image/avif",
    mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
    mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", flac: "audio/flac",
    pdf: "application/pdf",
    woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf",
    zip: "application/zip", gz: "application/gzip", tar: "application/x-tar", dmg: "application/octet-stream",
  };
  return map[ext] ?? "application/octet-stream";
}

/** Heuristic: is this file text we can open in the editor? */
export async function isTextFile(full: string, sampleSize = 8192): Promise<boolean> {
  const fd = await fsp.open(full, "r");
  try {
    const buf = Buffer.alloc(sampleSize);
    const { bytesRead } = await fd.read(buf, 0, sampleSize, 0);
    if (bytesRead === 0) return true;
    for (let i = 0; i < bytesRead; i++) if (buf[i] === 0) return false;
    return true;
  } finally {
    await fd.close();
  }
}

export { HOME };
