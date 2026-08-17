import { homedir, hostname } from "os";
import { join } from "path";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";

export const STEWARD_HOME = process.env.STEWARD_HOME ?? join(homedir(), ".steward");

export interface StewardConfig {
  nodeName: string;
  port: number;
  /** Directories scanned for repos and novel data. */
  roots: string[];
  /** Directory basenames treated as derivable junk (reclaimable, never novel). */
  junkDirs: string[];
  /** Directory basenames never descended into while scanning. */
  skipDirs: string[];
  /** Max directory depth when searching roots for git repos. */
  scanDepth: number;
}

const DEFAULTS: StewardConfig = {
  nodeName: hostname().replace(/\.local$/, ""),
  port: 4777,
  roots: [join(homedir(), "Code")],
  junkDirs: [
    "node_modules", ".next", ".turbo", ".cache", "dist", "build", ".parcel-cache",
    "target", ".gradle", "Pods", "DerivedData", ".venv", "venv", "__pycache__",
    ".expo", ".vercel", ".output", "coverage",
  ],
  skipDirs: [".git", "Library", ".Trash"],
  scanDepth: 3,
};

export function loadConfig(): StewardConfig {
  mkdirSync(STEWARD_HOME, { recursive: true });
  const path = join(STEWARD_HOME, "config.json");
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify(DEFAULTS, null, 2) + "\n");
    return { ...DEFAULTS };
  }
  const onDisk = JSON.parse(readFileSync(path, "utf8"));
  return { ...DEFAULTS, ...onDisk };
}

/** Bearer token gating the local HTTP API. Created on first run, mode 0600. */
export function loadToken(): string {
  const path = join(STEWARD_HOME, "token");
  if (!existsSync(path)) {
    writeFileSync(path, randomBytes(24).toString("hex"), { mode: 0o600 });
  }
  return readFileSync(path, "utf8").trim();
}
