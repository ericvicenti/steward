// Guards against the class of bug that bit us twice: shell scripts must be
// pure ASCII (bash parses multibyte chars into variable names under set -u),
// must pass bash -n, and install.sh must complete a sandboxed install.
import { test, expect } from "bun:test";
import { readFileSync, readdirSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const ROOT = join(import.meta.dir, "..");

function shellScripts(): string[] {
  const out: string[] = [join(ROOT, "install.sh")];
  for (const f of readdirSync(join(ROOT, "service"))) out.push(join(ROOT, "service", f));
  return out;
}

test("shell scripts and service templates are pure ASCII", () => {
  for (const path of shellScripts()) {
    const buf = readFileSync(path);
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] > 127) {
        const line = buf.subarray(0, i).toString().split("\n").length;
        throw new Error(`${path}:${line} contains non-ASCII byte 0x${buf[i].toString(16)}`);
      }
    }
    expect(buf.length).toBeGreaterThan(0);
  }
});

test("bash syntax check (bash -n)", async () => {
  const proc = Bun.spawn(["bash", "-n", join(ROOT, "install.sh")], { stderr: "pipe" });
  const err = await new Response(proc.stderr).text();
  expect(await proc.exited).toBe(0);
  expect(err).toBe("");
});

test("shellcheck-lite: unbraced variables directly followed by word chars", () => {
  // `$FOO...` is fine ('.' ends the name) but "$FOObar" silently reads a
  // different variable. Require braces when a var is followed by [A-Za-z0-9_].
  const src = readFileSync(join(ROOT, "install.sh"), "utf8");
  const suspicious = src.match(/\$[A-Z_]+[a-z]/g) ?? [];
  expect(suspicious).toEqual([]);
});

test(
  "install.sh completes a full sandboxed install (update branch skipped services)",
  async () => {
    const sandbox = join(tmpdir(), `steward-install-test-${process.pid}`);
    rmSync(sandbox, { recursive: true, force: true });
    try {
      const proc = Bun.spawn(["bash", join(ROOT, "install.sh")], {
        env: {
          ...process.env,
          STEWARD_HOME: sandbox,
          STEWARD_TEST: "1", // skip service registration, PATH links, browser open
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const code = await proc.exited;
      if (code !== 0) throw new Error(`install.sh failed (${code}):\n${out}\n${err}`);

      expect(existsSync(join(sandbox, "src", ".git"))).toBe(true);
      expect(existsSync(join(sandbox, "src", "dist", "ui", "index.html"))).toBe(true);
      expect(existsSync(join(sandbox, "bin", "steward"))).toBe(true);
      const shim = readFileSync(join(sandbox, "bin", "steward"), "utf8");
      expect(shim).toContain("src/cli/steward.ts");

      // Second run exercises the update branch.
      const proc2 = Bun.spawn(["bash", join(ROOT, "install.sh")], {
        env: { ...process.env, STEWARD_HOME: sandbox, STEWARD_TEST: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const out2 = await new Response(proc2.stdout).text();
      expect(await proc2.exited).toBe(0);
      expect(out2).toContain("updating source");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  },
  180000
);
