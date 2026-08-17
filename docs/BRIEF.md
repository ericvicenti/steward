# Steward — Vision Brief

Steward is a self-hosted fleet-and-data guardian. It runs as a background service on every
machine you own (Macs, Linux boxes, backup servers) and makes sure **all novel data is known,
synced, and redundantly backed up**, and that **every machine converges to your desired setup**.

## Core promises

1. **One-line install.** `curl -fsSL https://steward.sh/install | bash` installs the service,
   daemonizes it (launchd on macOS, systemd on Linux), and opens the web UI.
2. **Knows your data.** Indexes the filesystem, understands git repos (dirty? unpushed?
   remote-less?), and distinguishes *novel* data (irreplaceable) from *derivable* junk
   (node_modules, build output, caches, downloaded artifacts).
3. **Redundancy awareness.** Every piece of novel data has a redundancy score. The UI
   highlights anything that exists in only one place. Green fleet = everything safe.
4. **Fleet, not silos.** Nodes discover and manage each other. From any node you can browse,
   sync, and administer every other node. Backup servers are just nodes with lots of disk.
5. **Full git client.** Web UI can stage/commit/branch/push/pull any repo on any node.
   Later: direct node-to-node git sync (no GitHub required) and CI (actions-like runners).
6. **Self-managing.** Steward runs from a git checkout of its own source and can update,
   rebuild, and restart itself. Its own repo is just another repo it stewards.
7. **Docker aware.** Manages Docker: images, containers, compose services, on any node.
8. **Secrets vault.** Password manager + key store, encrypted client-side with a master
   password (argon2id-derived key). Synced between nodes as ciphertext only.
9. **Machine convergence.** A customization framework ("facets") captures app settings,
   dotfiles, installed tools, and preferences. `steward setup` on a fresh Mac/Linux box
   converges it to your profile. Imperfect at first; iterate.

## Tech stack (decided)

- **Runtime:** Bun + TypeScript everywhere. Daemon is a Bun process.
- **Server:** Hono (HTTP + WebSocket) on localhost port 4777; remote access via
  authenticated node-to-node channel, not raw port exposure.
- **Storage:** SQLite (`bun:sqlite`) at `~/.steward/steward.db`; content-addressed blob
  store for backup data at `~/.steward/blobs`.
- **UI:** React + Vite + Tailwind, built into the daemon's static assets. Dark-first,
  beautiful, calm. Design language documented in docs/UX.md.
- **Identity:** ed25519 keypair per node. Nodes pair via short code / QR; thereafter
  mutually authenticated (noise-style handshake over WebSocket).
- **Git:** shell out to system `git` (always present on dev machines; installer ensures it).
- **Install layout:** `~/.steward/` (data), `~/.steward/src/` (its own git checkout),
  `~/.steward/bin/steward` (CLI shim).

## Non-goals (for now)

- Mobile apps, Windows support, public multi-tenant hosting, E2E sync through third-party
  clouds. LAN + tailscale-style direct connectivity first.

## Audience

Single power-user (Eric) with many machines and ~300 project directories in `~/Code`,
several of which are duplicated experiments. Steward should make it obvious what is safe
to delete, what must be pushed/backed up, and what config a new machine needs.
