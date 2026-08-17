# Steward — Documentation Overview

**Start here.** This is the entry point to the Steward design docs: what the system is,
how the documents fit together, the system diagram, and a glossary of terms used
consistently across all docs.

---

## What Steward is

Steward is a **self-hosted fleet-and-data guardian**. A single Bun/TypeScript daemon runs
on every machine you own (Macs, Linux boxes, backup servers) and continuously ensures two
things:

1. **All novel data is known, scored for redundancy, and backed up.** Steward indexes the
   filesystem, understands git repos (dirty? unpushed? remote-less?), separates
   irreplaceable *novel* data from rebuildable *derivable* junk, and paints a redundancy
   score (×N verified copies) on every dataset. Green fleet = nothing exists in only one
   place.
2. **Every machine converges to your desired setup.** A declarative "facet" framework
   captures and applies packages, dotfiles, settings, and keys, so a fresh machine becomes
   *your* machine with `steward setup`.

Around that core: a full web git client, node-to-node git mirrors (no GitHub required), a
client-side-encrypted secrets vault, Docker management on every node, a small CI runner,
and a daemon that installs with one `curl | bash` and updates/rolls back itself.

Single user, many machines. LAN + tailscale-style connectivity. No cloud, no coordinator.

## The documents

| Doc | Owns |
|---|---|
| [BRIEF.md](BRIEF.md) | The vision: nine product promises, decided tech stack, non-goals. Authoritative for *what* and *why*. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | The daemon: process model, supervision + self-update (checkouts/`current` symlink), codebase layout, **canonical SQLite schema**, job queue, **canonical HTTP/WS API**, event bus, logging, config. Where docs disagree, this doc's schema and API win. |
| [INSTALL.md](INSTALL.md) | `install.sh`, `~/.steward/` on-disk layout, launchd/systemd units, the `steward` CLI shim, macOS Full Disk Access, headless/system installs, uninstall. |
| [INDEXING.md](INDEXING.md) | The indexer: scanner tiers (stat / dirhash / lazy content hash), datasets, the novel-vs-derivable classifier rule engine, git repo intelligence, the redundancy score, project grouping for the ~300-dirs problem. |
| [FLEET.md](FLEET.md) | Multi-node: node identity (`stw1…` = pubkey), pairing, the mesh transport on port 4778 (Noise-XX-style handshake — normative wire format), RPC frames, remote management via proxying, gossip replication, offline rules. |
| [UX.md](UX.md) | The web UI: design tokens, information architecture, every screen (Fleet dashboard, Data, Repos/git client, Files, Docker, Vault, Setup), live-update and optimistic-UI rules, frontend stack. |
| [SECURITY.md](SECURITY.md) | Threat model, crypto choices (libsodium, XChaCha20-Poly1305, argon2id), browser↔daemon auth (token → ticket → cookie), the vault key hierarchy and ciphertext-only sync, explicit non-goals. |
| [DOCKER-CI.md](DOCKER-CI.md) | Docker via the Engine HTTP API (unix socket), logs/exec streaming, compose, prune safety tiers; git mirror sync over the node channel (smart-HTTP proxy); the v2 CI runner. |
| [CONVERGENCE.md](CONVERGENCE.md) | Facets: capture/diff/apply/adopt, the profile repo, overlay merging, the converge algorithm, drift detection, sudo honesty, the builtin facet library. |

Reading order for a new contributor: BRIEF → ARCHITECTURE → INSTALL → INDEXING, then the
rest by interest. ROADMAP.md sequences the build.

## System diagram

```
                         one machine ("node")
┌───────────────────────────────────────────────────────────────────────┐
│  launchd / systemd  ──runs──▶  bin/steward-daemon-shim                │
│                                   │ exec $STEWARD_BUN                 │
│                                   ▼                                   │
│                  ~/.steward/current ──▶ checkouts/<sha>  (self-update │
│                                   │        = atomic symlink swap)     │
│   ┌───────────────────────────────┴──────────────────────────────┐    │
│   │                    steward daemon (Bun, 1 process)           │    │
│   │                                                              │    │
│   │  Hono HTTP+WS ◀── 127.0.0.1:4777 ──▶ browser UI (React/Vite) │    │
│   │   /api/* REST      │                  └─ vault Web Worker    │    │
│   │   /api/ws events   └──▶ steward CLI       (keys never leave  │    │
│   │   /git/* smart-HTTP                        the browser)      │    │
│   │                                                              │    │
│   │  JobRunner ── jobs table (scan, repo_audit, backup, sync,    │    │
│   │               update, gc — resumable via checkpoints)        │    │
│   │  Indexer ──── walks scan roots → files/datasets/repos,       │    │
│   │               classifier (novel vs derivable), redundancy    │    │
│   │  Watcher ──── FSEvents/inotify → debounced partial scans     │    │
│   │  EventBus ─── events table (seq) → WS fan-out                │    │
│   │  BlobStore ── ~/.steward/blobs  sha256 CAS, FastCDC chunks   │    │
│   │  Docker ───── Engine API over unix socket                    │    │
│   │  Mirrors ──── ~/.steward/mirrors/<repoId>.git (bare)         │    │
│   │  Facets ───── runner subprocesses ← ~/.steward/profile repo  │    │
│   │                                                              │    │
│   │  SQLite ~/.steward/steward.db (WAL, single writer)           │    │
│   │  PeerManager ◀── 0.0.0.0:4778 mesh listener (/api/peer)      │    │
│   └───────────────────┬──────────────────────────────────────────┘    │
└───────────────────────┼───────────────────────────────────────────────┘
                        │  Noise-XX-style encrypted WS (ed25519 identity),
                        │  channels: rpc · events/gossip · blob · relay
          ┌─────────────┼──────────────┐
          ▼             ▼              ▼
     ┌─────────┐   ┌─────────┐   ┌───────────┐     full mesh (≤20 nodes),
     │ node B  │   │ node C  │   │ backup    │     mDNS discovery on LAN,
     │ laptop  │   │ server  │   │ tower     │     tailscale addrs for WAN,
     └─────────┘   └─────────┘   └───────────┘     1-hop relay for NAT’d pairs

  Fleet properties: no coordinator; every node gossips signed peer records +
  dataset manifests and computes all redundancy scores locally; any node's UI
  can administer any other node via /api/nodes/:id/proxy/* over the mesh.
```

## Port & path quick reference

| Thing | Value |
|---|---|
| HTTP API + UI (loopback only) | `127.0.0.1:4777` |
| Fleet mesh listener (`/api/peer`) | `0.0.0.0:4778` |
| Dev daemon (`steward daemon run --dev`) | 4779 (HTTP) / 4780 (mesh), `~/.steward-dev/` |
| Data home | `~/.steward/` (db, blobs, identity/, token, env, logs, checkouts/, current→, mirrors/, profile/) |
| Bun runtime | `~/.bun/bin/bun`, pinned as `STEWARD_BUN` in `~/.steward/env` |
| Service units | `~/Library/LaunchAgents/sh.steward.daemon.plist` / `~/.config/systemd/user/steward.service` |

## Glossary

- **Node** — one Steward daemon on one machine; exactly one per machine. Identified by
  its **nodeId**: `"stw1" + base32(ed25519 pubkey)` — the public key *is* the identity.
- **Fleet** — the set of transitively paired nodes. One fleet per user; no coordinator.
- **Pairing** — the trust-bootstrap ceremony (URL/QR with pinned pubkey, or 6-digit code
  authenticating the handshake transcript). After pairing, all trust is cryptographic.
- **Peer channel / mesh** — the mutually-authenticated encrypted WebSocket between nodes
  (port 4778, Noise-XX-style handshake, XChaCha20-Poly1305 frames) carrying rpc, gossip,
  blob, and relay traffic.
- **Peer record** — a node's signed, single-writer, seq-versioned metadata document
  (name, addrs, disk, index summary), replicated fleet-wide by gossip.
- **Relay** — a node forwarding opaque end-to-end-encrypted frames between two peers that
  can't reach each other directly (exactly 1 hop in v1).
- **Scan root** — a user-configured directory the indexer walks (`~/Code`, `~/Documents`…).
- **Entry** — a file or directory row in the `files` table. Small files roll up into
  parent counters; dirs carry a **dirhash** (blake3 subtree fingerprint used as a
  change certificate).
- **Dataset** — the unit of redundancy accounting: a git repo root, a top-level dir under
  a scan root, a loose-files bucket, or a ≥2 GiB single file. Scores attach to datasets,
  not files.
- **Novel** — data that cannot be regenerated or re-fetched; losing the last copy is
  permanent loss. Subclasses: `novel-secret`, `novel-suspect`.
- **Derivable** — data reproducible from novel data + the network (`node_modules`, build
  output, caches). Subclasses: `derivable-remote` (pushed git objects),
  `derivable-refetch` (re-downloadable artifacts with provenance).
- **Classifier / class rules** — the priority-ordered rule table (`class_rules`, builtin
  seed rows + user overrides) that assigns classes; default for unknown data is novel.
- **Redundancy score** — 0–3+ = count of independent, *verified-current* copies of a
  dataset's novel portion (live copy on another node / blob snapshot / verified git
  remote). Computed as the min over components (history vs worktree novelty); every score
  carries human-readable `score_reasons`. Stale copies display but count 0.
- **Project** — a UI-level grouping of related datasets (clones, worktrees, `-copy 2`
  duplicates) with per-member dedupe verdicts: canonical / safe-delete /
  push-then-delete / diverged.
- **Blob store** — the content-addressed backup store at `~/.steward/blobs` (sha256,
  FastCDC chunking ≥1 MiB, JSON manifests stored as blobs).
- **Snapshot** — a manifest of paths → chunk lists at a point in time; a dataset's blob
  copy. Same-volume snapshots don't count toward redundancy.
- **Job** — any long-running unit of work, persisted in the `jobs` table with dedupe
  keys, priorities, concurrency groups, and handler-defined checkpoints for resume.
- **Event bus** — persistent append-only `events` table (monotonic `seq`) fanned out over
  `/api/ws`; clients resubscribe with `since=seq` and miss nothing.
- **Mirror** — a bare clone at `~/.steward/mirrors/<repoId>.git`, pushed to over
  localhost git smart-HTTP proxied across the mesh; counts toward committed-data
  redundancy.
- **Vault** — the client-side-encrypted secrets store. Master password → argon2id → KEK →
  VaultKey (generation-numbered) → per-item ItemKeys. The daemon stores and syncs
  **ciphertext only**; keys live in a browser Web Worker and are zeroed on lock.
- **Facet** — a declarative unit of machine configuration with capture / diff / apply /
  adopt verbs. Builtins ship with Steward; custom facets live in the profile repo.
- **Profile** — the git repo (`~/.steward/profile`) holding the facet manifest, desired
  state (base ⊕ role ⊕ machine overlays), dotfile payloads, and vault references — the
  recipe every machine converges toward.
- **Drift** — a discrete difference between a machine's captured state and the profile's
  desired state; resolved by Apply (machine ← profile), Adopt (profile ← machine), or
  Dismiss. `manual` changes form a human checklist.
- **Shim** — the dumb ~15-line bash script the supervisor runs; it execs bun on
  `~/.steward/current`, and holds the crash-counter rollback logic so a broken update can
  never brick the daemon.
- **`current` symlink** — `~/.steward/current → checkouts/<sha>`; atomic swap = version
  switch; `~/.steward/src` is a compat alias to it.
