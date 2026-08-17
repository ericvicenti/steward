#!/usr/bin/env bun
// steward CLI — talks to the local daemon and manages the service.
import { join } from "path";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { STEWARD_HOME, loadConfig } from "../daemon/config";

const cfg = loadConfig();
const BASE = `http://127.0.0.1:${cfg.port}`;
const SRC = join(STEWARD_HOME, "src");
const cmd = process.argv[2] ?? "help";

function token(): string {
  const p = join(STEWARD_HOME, "token");
  return existsSync(p) ? readFileSync(p, "utf8").trim() : "";
}

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token()}` },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

async function sh(command: string[]): Promise<number> {
  const proc = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
  return proc.exited;
}

const isMac = process.platform === "darwin";
const PLIST = join(homedir(), "Library/LaunchAgents/sh.steward.daemon.plist");
const uid = process.getuid?.() ?? 501;

async function serviceRestart() {
  if (isMac) await sh(["launchctl", "kickstart", "-k", `gui/${uid}/sh.steward.daemon`]);
  else await sh(["systemctl", "--user", "restart", "steward.service"]);
}

switch (cmd) {
  case "status": {
    try {
      const s = await api("/api/status");
      console.log(`steward ${s.version} — node "${s.nodeName}"`);
      console.log(`roots: ${s.roots.join(", ")}`);
      console.log(
        `repos: ${s.repos ?? 0}  at-risk: ${s.atRisk ?? 0}  attention: ${s.attention ?? 0}  safe: ${s.safe ?? 0}`
      );
      console.log(`reclaimable junk: ${((s.junkBytes ?? 0) / 1e9).toFixed(1)} GB`);
      console.log(s.scanning ? "scan in progress…" : `last scan: ${s.lastScanAt ? new Date(s.lastScanAt).toLocaleString() : "never"}`);
    } catch {
      console.log("daemon not reachable — try: steward restart");
      process.exit(1);
    }
    break;
  }
  case "open": {
    const url = `${BASE}/#t=${token()}`;
    await sh([isMac ? "open" : "xdg-open", url]);
    break;
  }
  case "scan":
    await api("/api/scan", { method: "POST" });
    console.log("scan started");
    break;
  case "restart":
    await serviceRestart();
    console.log("restarted");
    break;
  case "stop":
    if (isMac) await sh(["launchctl", "bootout", `gui/${uid}`, PLIST]);
    else await sh(["systemctl", "--user", "stop", "steward.service"]);
    break;
  case "start":
    if (isMac) await sh(["launchctl", "bootstrap", `gui/${uid}`, PLIST]);
    else await sh(["systemctl", "--user", "start", "steward.service"]);
    break;
  case "logs":
    await sh(["tail", "-f", join(STEWARD_HOME, "logs/daemon.log"), join(STEWARD_HOME, "logs/daemon.err.log")]);
    break;
  case "update": {
    // Steward manages its own source: pull, rebuild, restart.
    console.log("updating source…");
    if ((await sh(["git", "-C", SRC, "pull", "--ff-only"])) !== 0) process.exit(1);
    for (const step of [["bun", "install"], ["bun", "run", "build"]]) {
      const proc = Bun.spawn(step, { cwd: SRC, stdout: "inherit", stderr: "inherit" });
      if ((await proc.exited) !== 0) process.exit(1);
    }
    await serviceRestart();
    console.log("updated and restarted");
    break;
  }
  default:
    console.log(`steward — fleet-and-data guardian

usage: steward <command>

  status     daemon health and data summary
  open       open the web UI (authenticated)
  scan       trigger a rescan now
  restart    restart the daemon service
  stop/start manage the daemon service
  logs       tail daemon logs
  update     pull own source, rebuild, restart`);
}
