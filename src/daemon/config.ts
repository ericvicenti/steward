import { homedir, hostname } from "os";
import { join } from "path";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";

export const STEWARD_HOME = process.env.STEWARD_HOME ?? join(homedir(), ".steward");

export interface StewardConfig {
  nodeName: string;
  port: number;
  /** Listen address. 0.0.0.0 enables LAN fleet pairing; the API is token-gated. */
  bind: string;
  /** Directories scanned for repos and novel data. */
  roots: string[];
  /** User-data locations inventoried by the data scan (sizes, cache split). */
  dataRoots: string[];
  /** Directory basenames inside data roots that are app caches (reclaimable). */
  cacheDirs: string[];
  /** Watch roots for changes and rescan automatically. */
  watch: boolean;
  /** Keep this node's software current (pull origin + rebuild + restart),
   *  and accept update nudges from fleet peers. */
  autoUpdate: boolean;
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
  bind: "0.0.0.0",
  roots: [join(homedir(), "Code")],
  dataRoots: [
    join(homedir(), "Desktop"),
    join(homedir(), "Documents"),
    join(homedir(), "Downloads"),
    join(homedir(), "Pictures"),
    join(homedir(), "Movies"),
    join(homedir(), "Music"),
    join(homedir(), "Library", "Application Support"),
  ],
  cacheDirs: [
    "Cache", "Caches", "cache", "GPUCache", "Code Cache", "DawnCache", "DawnGraphiteCache",
    "DawnWebGPUCache", "CachedData", "CachedProfilesData", "CachedExtensions",
    "ShaderCache", "GrShaderCache", "logs", "Logs", "tmp", "Temp", "Crashpad",
    "Service Worker", "blob_storage", "IndexedDB-journal",
  ],
  watch: true,
  autoUpdate: true,
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

/** Stable node identity, minted on first run. */
export function loadNodeId(): string {
  const path = join(STEWARD_HOME, "node-id");
  if (!existsSync(path)) {
    writeFileSync(path, "stw-" + randomBytes(12).toString("hex"), { mode: 0o600 });
  }
  return readFileSync(path, "utf8").trim();
}

/** Bearer token gating the local HTTP API. Created on first run, mode 0600. */
export function loadToken(): string {
  const path = join(STEWARD_HOME, "token");
  if (!existsSync(path)) {
    writeFileSync(path, randomBytes(24).toString("hex"), { mode: 0o600 });
  }
  return readFileSync(path, "utf8").trim();
}
