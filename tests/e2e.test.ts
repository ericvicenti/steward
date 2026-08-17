// Full-app e2e: real daemon (sandboxed STEWARD_HOME), real built UI, real
// Chromium. Covers browse, create, edit/save, rename, copy/paste, chmod,
// symlinks, hidden files, upload, delete, and the web terminal.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, statSync, lstatSync } from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";
import type { Subprocess } from "bun";

const PORT = 4795;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "e2e-test-token";
const ROOT = join(import.meta.dir, "..");

let stewardHome: string;
let play: string; // playground dir inside $HOME (fs API is home-confined)
let daemon: Subprocess;
let browser: Browser;
let page: Page;

async function waitFor(fn: () => Promise<boolean> | boolean, ms = 15000, step = 150): Promise<void> {
  const start = Date.now();
  while (!(await fn())) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, step));
  }
}

const gotoFiles = async (path: string) => {
  await page.goto(`${BASE}/#/files?path=${encodeURIComponent(path)}`);
  await page.waitForSelector('[data-testid="files-table"]');
  // wait for the async listing (not just the table shell) to render
  await page.waitForSelector('[data-testid^="row-"]');
};

const rowMenu = async (name: string, itemLabel: string) => {
  await page.click(`[data-testid="row-${name}"]`, { button: "right" });
  await page.waitForSelector('[data-testid="context-menu"]');
  await page.click(`[data-testid="context-menu"] >> text=${itemLabel}`);
};

beforeAll(async () => {
  // sandboxed daemon home
  stewardHome = mkdtempSync(join(tmpdir(), "steward-e2e-home-"));
  writeFileSync(join(stewardHome, "token"), TOKEN);
  play = mkdtempSync(join(homedir(), ".steward-e2e-play-"));
  writeFileSync(
    join(stewardHome, "config.json"),
    JSON.stringify({ nodeName: "e2e-node", port: PORT, roots: [play], junkDirs: ["node_modules"], skipDirs: [".git"], scanDepth: 2 })
  );
  writeFileSync(join(play, "readme.md"), "# playground\n");
  writeFileSync(join(play, "script.ts"), "export const x = 1\n");
  writeFileSync(join(play, ".secret"), "hidden!\n");
  mkdirSync(join(play, "folder"));
  writeFileSync(join(play, "folder", "inside.txt"), "inner content\n");

  daemon = Bun.spawn(["bun", "run", join(ROOT, "src/daemon/main.ts")], {
    env: { ...process.env, STEWARD_HOME: stewardHome },
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitFor(async () => {
    try {
      const res = await fetch(`${BASE}/api/status?token=${TOKEN}`);
      return res.ok;
    } catch {
      return false;
    }
  });

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("dialog", (d) => d.accept());
  await page.goto(`${BASE}/#t=${TOKEN}`);
  await page.waitForSelector("text=Dashboard");
}, 60000);

afterAll(async () => {
  await browser?.close();
  daemon?.kill();
  rmSync(stewardHome, { recursive: true, force: true });
  rmSync(play, { recursive: true, force: true });
});

test("dashboard renders with nav shell", async () => {
  expect(await page.textContent("aside")).toContain("Steward");
  expect(await page.textContent("main")).toContain("Dashboard");
});

test("files: lists playground entries with metadata", async () => {
  await gotoFiles(play);
  expect(await page.isVisible(`[data-testid="row-readme.md"]`)).toBe(true);
  expect(await page.isVisible(`[data-testid="row-folder"]`)).toBe(true);
  // permissions column shows rwx string
  const permText = await page.textContent(`[data-testid="row-readme.md"]`);
  expect(permText).toMatch(/-rw/);
  // hidden file not shown by default
  expect(await page.isVisible(`[data-testid="row-.secret"]`)).toBe(false);
});

test("files: hidden toggle reveals dotfiles", async () => {
  await gotoFiles(play);
  await page.check('[data-testid="toggle-hidden"]');
  await page.waitForSelector('[data-testid="row-.secret"]');
  expect(await page.isVisible('[data-testid="row-.secret"]')).toBe(true);
});

test("files: navigate into folder by double-click and back via breadcrumb", async () => {
  await gotoFiles(play);
  await page.dblclick('[data-testid="row-folder"]');
  await page.waitForSelector('[data-testid="row-inside.txt"]');
  const crumb = play.split("/").pop()!;
  await page.click(`[data-testid="breadcrumbs"] >> text="${crumb}"`);
  await page.waitForSelector('[data-testid="row-readme.md"]');
});

test("files: create new folder", async () => {
  await gotoFiles(play);
  await page.click('[data-testid="new-folder"]');
  await page.fill('input[value="untitled folder"]', "made-by-e2e");
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-testid="row-made-by-e2e"]');
  expect(statSync(join(play, "made-by-e2e")).isDirectory()).toBe(true);
});

test("files: create file, edit in CodeMirror, save with keyboard", async () => {
  await gotoFiles(play);
  await page.click('[data-testid="new-file"]');
  await page.fill('input[value="untitled.txt"]', "note.md");
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-testid="row-note.md"]');

  await page.dblclick('[data-testid="row-note.md"]');
  await page.waitForSelector(".cm-content");
  await page.click(".cm-content");
  await page.keyboard.type("# hello from e2e");
  await page.keyboard.press("ControlOrMeta+s");
  await waitFor(() => existsSync(join(play, "note.md")) && readFileSync(join(play, "note.md"), "utf8").includes("hello from e2e"));
  expect(readFileSync(join(play, "note.md"), "utf8")).toContain("# hello from e2e");
});

test("files: rename via context menu", async () => {
  await gotoFiles(play);
  await rowMenu("note.md", "Rename…");
  await page.fill('input[value="note.md"]', "renamed.md");
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-testid="row-renamed.md"]');
  expect(existsSync(join(play, "renamed.md"))).toBe(true);
  expect(existsSync(join(play, "note.md"))).toBe(false);
});

test("files: copy + paste into folder via context menu", async () => {
  await gotoFiles(play);
  await rowMenu("renamed.md", "Copy");
  await page.dblclick('[data-testid="row-folder"]');
  await page.waitForSelector('[data-testid="row-inside.txt"]');
  await page.click('[data-testid="paste-btn"]');
  await page.waitForSelector('[data-testid="row-renamed.md"]');
  expect(readFileSync(join(play, "folder", "renamed.md"), "utf8")).toContain("hello from e2e");
  expect(existsSync(join(play, "renamed.md"))).toBe(true); // copy, not move
});

test("files: cut + paste moves", async () => {
  await gotoFiles(play);
  await rowMenu("script.ts", "Cut");
  await page.dblclick('[data-testid="row-made-by-e2e"]');
  await page.waitForSelector("text=Empty folder");
  await page.click('[data-testid="paste-btn"]');
  await page.waitForSelector('[data-testid="row-script.ts"]');
  expect(existsSync(join(play, "made-by-e2e", "script.ts"))).toBe(true);
  expect(existsSync(join(play, "script.ts"))).toBe(false);
});

test("files: chmod via permissions dialog", async () => {
  await gotoFiles(play);
  await rowMenu("readme.md", "Permissions…");
  await page.waitForSelector("text=Owner");
  // uncheck all "write" bits -> 444; grid rows are Owner/Group/Others
  for (const row of ["Owner", "Group", "Others"]) {
    const checkbox = page.locator(`tr:has-text("${row}") input`).nth(1); // read, WRITE, execute
    if (await checkbox.isChecked()) await checkbox.uncheck();
  }
  await page.click("text=Apply");
  await waitFor(() => (statSync(join(play, "readme.md")).mode & 0o777) === 0o444);
  expect(statSync(join(play, "readme.md")).mode & 0o777).toBe(0o444);
  // restore
  await fetch(`${BASE}/api/fs/chmod?token=${TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: join(play, "readme.md"), mode: "644" }),
  });
});

test("files: create symlink via context menu, badge visible", async () => {
  await gotoFiles(play);
  await rowMenu("readme.md", "New symlink to this…");
  await page.keyboard.press("Enter"); // accept default "readme.md-link"
  await page.waitForSelector('[data-testid="row-readme.md-link"]');
  expect(lstatSync(join(play, "readme.md-link")).isSymbolicLink()).toBe(true);
  const rowText = await page.textContent('[data-testid="row-readme.md-link"]');
  expect(rowText).toContain("→"); // symlink target arrow
});

test("files: create hard link, nlink badge appears", async () => {
  await gotoFiles(play);
  await rowMenu("readme.md", "New hard link to this…");
  await page.fill('input[value="readme.md-link"]', "readme-hard.md");
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-testid="row-readme-hard.md"]');
  await waitFor(async () => (await page.textContent('[data-testid="files-table"]'))?.includes("⧉ 2") ?? false);
  expect(statSync(join(play, "readme.md")).nlink).toBe(2);
});

test("files: upload via file input", async () => {
  await gotoFiles(play);
  const tmpFile = join(tmpdir(), "e2e-upload.txt");
  writeFileSync(tmpFile, "uploaded via e2e");
  await page.setInputFiles('[data-testid="upload-input"]', tmpFile);
  await page.waitForSelector('[data-testid="row-e2e-upload.txt"]');
  expect(readFileSync(join(play, "e2e-upload.txt"), "utf8")).toBe("uploaded via e2e");
});

test("files: drop upload path (synthetic DataTransfer)", async () => {
  await gotoFiles(play);
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["dropped body"], "dropped.txt", { type: "text/plain" }));
    const target = document.querySelector('[data-testid="files-view"]')!;
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: dt }));
  });
  await page.waitForSelector('[data-testid="row-dropped.txt"]');
  expect(readFileSync(join(play, "dropped.txt"), "utf8")).toBe("dropped body");
});

test("files: delete permanently via context menu", async () => {
  await gotoFiles(play);
  await rowMenu("e2e-upload.txt", "Delete permanently");
  await waitFor(() => !existsSync(join(play, "e2e-upload.txt")));
  expect(existsSync(join(play, "e2e-upload.txt"))).toBe(false);
});

test("files: deep search finds nested file", async () => {
  await gotoFiles(play);
  await page.fill('[data-testid="files-filter"]', "inside");
  await page.keyboard.press("Enter");
  await page.waitForSelector("text=result");
  expect(await page.textContent("main")).toContain("inside.txt");
});

test("terminal: runs shell commands end-to-end", async () => {
  await page.goto(`${BASE}/#/term?cwd=${encodeURIComponent(play)}`);
  await page.waitForSelector("text=live");
  await page.click('[data-testid="terminal-host"]');
  await page.keyboard.type("echo e2e_$((6*7))");
  await page.keyboard.press("Enter");
  await waitFor(async () => (await page.textContent('[data-testid="terminal-host"]'))?.includes("e2e_42") ?? false);
  await page.keyboard.type("pwd");
  await page.keyboard.press("Enter");
  await waitFor(async () => {
    const text = await page.textContent('[data-testid="terminal-host"]');
    return text?.includes(play.split("/").pop()!) ?? false;
  });
}, 30000);

test("auth: wrong token is locked out", async () => {
  const p2 = await browser.newPage();
  await p2.goto(`${BASE}/#t=wrong-token`);
  await p2.waitForSelector("text=Steward is locked");
  await p2.close();
});
