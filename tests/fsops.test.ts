import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { writeFileSync, mkdirSync, symlinkSync, readFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import * as ops from "../src/daemon/fsops";
import { tmpHomeDir } from "./helpers";

const { dir, cleanup } = tmpHomeDir("fsops");
afterAll(cleanup);

beforeAll(() => {
  writeFileSync(join(dir, "hello.txt"), "hello world\n");
  writeFileSync(join(dir, ".hidden-file"), "shh");
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "nested.md"), "# nested\n");
  symlinkSync(join(dir, "hello.txt"), join(dir, "link-to-hello"));
  symlinkSync("/nonexistent-target-xyz", join(dir, "broken-link"));
  writeFileSync(join(dir, "binary.bin"), Buffer.from([0x89, 0x50, 0x00, 0x47, 0x0d, 0x00]));
});

describe("path resolution", () => {
  test("whole filesystem is reachable", async () => {
    expect(ops.resolveSafe("/etc/passwd")).toBe("/etc/passwd");
    const root = await ops.listDir("/");
    expect(root.parent).toBeNull();
    expect(root.entries.length).toBeGreaterThan(0);
    const etc = await ops.listDir("/etc");
    expect(etc.entries.some((e) => e.name === "hosts")).toBe(true);
  });
  test("normalizes ../ traversal", () => {
    expect(ops.resolveSafe(join(dir, "../../../../etc"))).toBe("/etc");
  });
  test("expands ~", () => {
    expect(ops.resolveSafe("~")).toBe(ops.HOME);
    expect(ops.resolveSafe("~/anything")).toBe(join(ops.HOME, "anything"));
  });
  test("protected paths refuse deletion", async () => {
    for (const p of ["/", "/System", "/Users", "/etc", ops.HOME]) {
      expect(ops.isProtectedPath(p)).toBe(true);
      await expect(ops.remove([p], true)).rejects.toThrow("protected");
    }
    expect(ops.isProtectedPath(join(dir, "x"))).toBe(false);
  });
});

describe("listDir", () => {
  test("lists entries with full metadata", async () => {
    const res = await ops.listDir(dir);
    const byName = Object.fromEntries(res.entries.map((e) => [e.name, e]));
    expect(byName["hello.txt"].type).toBe("file");
    expect(byName["hello.txt"].size).toBe(12);
    expect(byName["hello.txt"].nlink).toBe(1);
    expect(byName["hello.txt"].mode).toBeGreaterThan(0);
    expect(byName["sub"].type).toBe("dir");
    expect(byName[".hidden-file"].hidden).toBe(true);
    expect(res.users[byName["hello.txt"].uid]).toBeTruthy();
    expect(res.groups[byName["hello.txt"].gid]).toBeTruthy();
  });
  test("reports symlinks with targets", async () => {
    const res = await ops.listDir(dir);
    const link = res.entries.find((e) => e.name === "link-to-hello")!;
    expect(link.type).toBe("symlink");
    expect(link.target).toBe(join(dir, "hello.txt"));
    expect(link.targetType).toBe("file");
    const broken = res.entries.find((e) => e.name === "broken-link")!;
    expect(broken.targetType).toBe("missing");
  });
});

describe("mutations", () => {
  test("write + read", async () => {
    await ops.writeFile(join(dir, "new.txt"), "created by test");
    expect(readFileSync(join(dir, "new.txt"), "utf8")).toBe("created by test");
  });
  test("mkdir", async () => {
    await ops.mkdir(join(dir, "made", "deeply"));
    expect(statSync(join(dir, "made", "deeply")).isDirectory()).toBe(true);
  });
  test("rename refuses overwrite", async () => {
    await ops.writeFile(join(dir, "a.txt"), "a");
    await ops.writeFile(join(dir, "b.txt"), "b");
    await expect(ops.rename(join(dir, "a.txt"), join(dir, "b.txt"))).rejects.toThrow("exists");
  });
  test("rename moves", async () => {
    await ops.rename(join(dir, "a.txt"), join(dir, "sub", "a-moved.txt"));
    expect(existsSync(join(dir, "a.txt"))).toBe(false);
    expect(readFileSync(join(dir, "sub", "a-moved.txt"), "utf8")).toBe("a");
  });
  test("copy dir recursively, preserving structure", async () => {
    await ops.copy(join(dir, "sub"), join(dir, "sub2"));
    expect(readFileSync(join(dir, "sub2", "nested.md"), "utf8")).toBe("# nested\n");
    expect(existsSync(join(dir, "sub", "nested.md"))).toBe(true);
  });
  test("copy onto itself makes 'name copy'", async () => {
    const res = await ops.copy(join(dir, "hello.txt"), join(dir, "hello.txt"));
    expect(res.path).toBe(join(dir, "hello.txt copy"));
    expect(existsSync(res.path)).toBe(true);
  });
  test("chmod", async () => {
    await ops.chmod(join(dir, "hello.txt"), "600", false);
    expect(statSync(join(dir, "hello.txt")).mode & 0o777).toBe(0o600);
    await ops.chmod(join(dir, "hello.txt"), "644", false);
    expect(statSync(join(dir, "hello.txt")).mode & 0o777).toBe(0o644);
  });
  test("chmod rejects garbage modes", async () => {
    await expect(ops.chmod(join(dir, "hello.txt"), "banana", false)).rejects.toThrow("octal");
    await expect(ops.chmod(join(dir, "hello.txt"), "999", false)).rejects.toThrow("octal");
  });
  test("hard link shares inode, nlink becomes 2", async () => {
    await ops.makeLink(join(dir, "hello.txt"), join(dir, "hello-hard"), "hard");
    const a = statSync(join(dir, "hello.txt"));
    const b = statSync(join(dir, "hello-hard"));
    expect(a.ino).toBe(b.ino);
    expect(a.nlink).toBe(2);
  });
  test("hard link to dir is rejected", async () => {
    await expect(ops.makeLink(join(dir, "sub"), join(dir, "sub-hard"), "hard")).rejects.toThrow(
      "regular files"
    );
  });
  test("symlink creation", async () => {
    await ops.makeLink(join(dir, "sub"), join(dir, "sub-sym"), "symlink");
    const st = await ops.statOne(join(dir, "sub-sym"));
    expect(st.type).toBe("symlink");
    expect(st.targetType).toBe("dir");
  });
  test("delete (permanent)", async () => {
    await ops.writeFile(join(dir, "doomed.txt"), "bye");
    await ops.remove([join(dir, "doomed.txt")], true);
    expect(existsSync(join(dir, "doomed.txt"))).toBe(false);
  });
  test("refuses to delete home", async () => {
    await expect(ops.remove([ops.HOME], true)).rejects.toThrow("protected");
  });
});

describe("text/binary detection", () => {
  test("text file", async () => {
    expect(await ops.isTextFile(join(dir, "hello.txt"))).toBe(true);
  });
  test("binary file", async () => {
    expect(await ops.isTextFile(join(dir, "binary.bin"))).toBe(false);
  });
});

describe("search", () => {
  test("finds by name fragment, case-insensitive", async () => {
    const results = await ops.search(dir, "NESTED");
    expect(results.some((r) => r.endsWith("nested.md"))).toBe(true);
  });
});
