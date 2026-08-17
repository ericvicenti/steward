# Steward Daemon Architecture

Status: design, implementation-ready. Companion to `docs/BRIEF.md` (authoritative vision).
This doc covers the daemon process model, codebase layout, storage schema, job system,
API surface, event bus, logging, self-update, and configuration.

---

## 1. Process model

### 1.1 One daemon, one process

Steward is a **single long-lived Bun process** per node. No worker processes, no sidecar
services. Concurrency comes from Bun's event loop plus bounded async job workers inside the
process (§5). CPU-heavy hashing uses `Bun.hash`/`crypto` in-process; if profiling ever shows
the event loop stalling, we move hashing into `new Worker()` threads — but not before.

```
launchd / systemd
  └── bun ~/.steward/src/src/daemon/main.ts     ("steward-daemon")
        ├── Hono HTTP+WS server on 127.0.0.1:4777
        ├── JobRunner (N=4 worker slots, in-process)
        ├── PeerManager (outbound WS connections to paired nodes)
        ├── Watcher (fs.watch on scan roots, debounced)
        └── Scheduler (cron-like tick, 30s resolution)
```

Rationale for single-process: SQLite with one writer is trivially correct (WAL mode, one
connection, no busy-loop dances), the event bus is a plain in-memory `EventTarget`, and
crash recovery is one supervisor restart. The failure domain is the whole daemon, which is
acceptable because jobs are resumable (§5.4).

There is additionally a thin **CLI** (`~/.steward/bin/steward`) which is not a second
daemon: it is an HTTP client of the local daemon (plus a handful of offline subcommands:
`install`, `doctor`, `daemon run`).

### 1.2 Supervision

The installer writes a supervisor unit that runs the **shim**, not `main.ts` directly,
so that self-update can swap the active checkout without touching the unit (§9).

**macOS — `~/Library/LaunchAgents/sh.steward.daemon.plist`:**

```xml
<key>Label</key><string>sh.steward.daemon</string>
<key>ProgramArguments</key>
<array>
  <string>/Users/eric/.steward/bin/steward-daemon-shim</string>
</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key>
<dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>/Users/eric/.steward/logs/daemon.out.log</string>
<key>StandardErrorPath</key><string>/Users/eric/.steward/logs/daemon.err.log</string>
<key>EnvironmentVariables</key>
<dict><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string></dict>
```

**Linux — `~/.config/systemd/user/steward.service`:**

```ini
[Unit]
Description=Steward daemon
After=network.target

[Service]
ExecStart=%h/.steward/bin/steward-daemon-shim
Restart=on-failure
RestartSec=5
# Give self-update exec-replace a clean signal story:
KillMode=mixed
TimeoutStopSec=20

[Install]
WantedBy=default.target
```

`steward-daemon-shim` is a ~15-line bash script:

```bash
#!/usr/bin/env bash
set -euo pipefail
STEWARD_HOME="${STEWARD_HOME:-$HOME/.steward}"
CURRENT="$STEWARD_HOME/current"          # symlink -> checkouts/<sha> (see §9)
[ -f "$STEWARD_HOME/env" ] && . "$STEWARD_HOME/env"   # KEY=VALUE incl. STEWARD_BUN (INSTALL.md §2.1)
BUN="${STEWARD_BUN:-$HOME/.bun/bin/bun}" # shared bun, absolute path pinned at install
exec "$BUN" "$CURRENT/src/daemon/main.ts"
```

The supervisor's only job is "restart on crash." All intelligence (health, rollback,
version selection) lives in the shim + daemon + `current` symlink.

### 1.3 Lifecycle & signals

| Signal | Behavior |
|---|---|
| `SIGTERM` | Graceful: stop accepting jobs, checkpoint running jobs (§5.4), flush WAL, close WS with code 1001, exit 0 within 15s or hard-exit 1. |
| `SIGINT` | Same as SIGTERM (dev convenience). |
| `SIGHUP` | Reload `config.json` (watched anyway; HUP forces it). |
| `SIGUSR2` | Trigger self-update check (used by `steward update`). |

Startup sequence (`src/daemon/main.ts`):

1. Acquire singleton lock: `flock` on `~/.steward/daemon.lock`; if held, print the PID from
   the lockfile and exit 3.
2. Load + validate config (Zod schema, §10). Invalid config → log fatal, exit 78 (EX_CONFIG)
   so `KeepAlive`'s throttle doesn't spin-loop hot.
3. Open SQLite, run migrations (§4.1).
4. Write `~/.steward/daemon.json` runtime manifest: `{pid, version, gitSha, startedAt, port}`.
5. Mark any `running` jobs from a previous life as `interrupted` → requeue (§5.4).
6. Start HTTP server, then Watcher, Scheduler, PeerManager.
7. If launched by an updater (env `STEWARD_UPDATE_FROM` set), run self-test and confirm
   the update (§9.4).

---

## 2. Codebase layout

Single repo, single `package.json` (no monorepo tooling — Bun workspaces add ceremony we
don't need at this scale). UI is a Vite app whose build output is committed-adjacent
(`dist/ui`, gitignored, built by `bun run build`).

```
steward/
├── package.json
├── bunfig.toml
├── docs/                      # BRIEF.md, this file, UX.md
├── migrations/                # 0001_init.sql, 0002_....sql (plain SQL, ordered)
├── src/
│   ├── daemon/
│   │   ├── main.ts            # entrypoint: boot sequence, signal handlers
│   │   ├── context.ts         # AppContext: db, bus, config, jobs — passed everywhere
│   │   ├── server.ts          # Hono app assembly, WS upgrade, static UI serving
│   │   ├── auth.ts            # local-token + node-to-node session auth middleware
│   │   └── selfupdate.ts      # §9: check, stage, switch, confirm, rollback
│   ├── api/                   # one file per resource; route tables in §6
│   │   ├── nodes.ts
│   │   ├── repos.ts
│   │   ├── scans.ts
│   │   ├── files.ts
│   │   ├── jobs.ts
│   │   ├── git.ts
│   │   ├── backups.ts
│   │   ├── docker.ts
│   │   ├── vault.ts
│   │   ├── events.ts          # WS endpoint + subscription protocol
│   │   └── system.ts          # health, version, update, logs
│   ├── core/
│   │   ├── db.ts              # bun:sqlite open, pragmas, migrate(), typed query helpers
│   │   ├── bus.ts             # EventBus (§7)
│   │   ├── config.ts          # load/validate/watch ~/.steward/config.json (§10)
│   │   ├── log.ts             # logger (§8)
│   │   ├── ids.ts             # ulid(), short ids
│   │   └── errors.ts          # StewardError taxonomy → HTTP codes
│   ├── jobs/
│   │   ├── runner.ts          # JobRunner: queue, leases, checkpoints (§5)
│   │   ├── registry.ts        # jobType → handler map
│   │   ├── scan.ts            # filesystem scan job (§5.5)
│   │   ├── repo-audit.ts      # git status/unpushed/remote analysis per repo
│   │   ├── backup.ts          # snapshot → blob store → replicate
│   │   ├── sync.ts            # node-to-node blob/db sync
│   │   └── update.ts          # self-update as a job
│   ├── fleet/
│   │   ├── identity.ts        # ed25519 keypair load/create (~/.steward/identity/)
│   │   ├── pairing.ts         # short-code pairing flow
│   │   ├── peers.ts           # PeerManager: dial, handshake, heartbeat, reconnect
│   │   └── tunnel.ts          # request proxying to remote nodes (/api/nodes/:id/proxy)
│   ├── scan/
│   │   ├── classify.ts        # novel vs derivable rules engine (§5.5)
│   │   ├── gitinfo.ts         # shell-out git helpers (status --porcelain=v2, etc.)
│   │   └── watcher.ts         # fs.watch roots → debounced rescan enqueue
│   ├── blobs/
│   │   ├── store.ts           # CAS: write/read/has/gc at ~/.steward/blobs (§4.3)
│   │   └── chunker.ts         # FastCDC content-defined chunking for large files
│   ├── vault/                 # ciphertext-only storage; crypto lives in UI
│   │   └── store.ts
│   └── cli/
│       ├── main.ts            # `steward` CLI: parses argv, calls daemon HTTP API
│       └── commands/*.ts
├── ui/                        # React + Vite + Tailwind (dark-first, see docs/UX.md)
│   ├── index.html
│   ├── vite.config.ts
│   └── src/...
└── test/
```

**Dependency direction:** `api/*` and `jobs/*` depend on `core/*` and domain modules;
nothing imports from `api/`. Every handler receives `AppContext` explicitly — no module
singletons except the logger. This keeps jobs testable with an in-memory SQLite.

---

## 3. Filesystem layout at runtime

```
~/.steward/
├── config.json                # §10
├── env                        # KEY=VALUE (STEWARD_BUN, STEWARD_PORT, …), see INSTALL.md §2.1
├── steward.db  (+ -wal/-shm)
├── daemon.lock
├── daemon.json                # runtime manifest {pid, port, version, gitSha}
├── token                      # local UI/CLI bearer token, mode 0600
├── identity/
│   ├── node.key               # ed25519 private key, 0600
│   └── node.pub
├── blobs/
│   ├── sha256/ab/cd/abcd…     # content-addressed chunks (§4.3)
│   └── tmp/
├── logs/
│   ├── daemon.log             # current JSONL log (§8)
│   └── daemon.log.1.gz …
├── src -> current             # compat alias per BRIEF ("~/.steward/src/")
├── current -> checkouts/ab12cd3   # active version symlink (§9)
├── checkouts/
│   ├── ab12cd3/               # git worktree at that sha, with dist/ui built
│   └── 9f00e21/
└── bin/
    ├── steward                # CLI shim (exec $STEWARD_BUN $CURRENT/src/cli/main.ts "$@")
    └── steward-daemon-shim
```

Bun itself is **not** vendored here: it lives at the standard `~/.bun/bin/bun`, with the
absolute path pinned as `STEWARD_BUN` in `~/.steward/env` (see INSTALL.md §2 — sharing the
user's bun avoids duplicate runtimes and keeps the macOS Full Disk Access grant on one binary).

Note on BRIEF's `~/.steward/src/`: we keep that path as a symlink to `current` so docs and
muscle memory hold, but the real mechanism is `checkouts/<sha>` + atomic symlink swap,
which is what makes rollback safe (§9).

---

## 4. Storage

### 4.1 SQLite conventions

- `bun:sqlite`, single connection, `PRAGMA journal_mode=WAL; synchronous=NORMAL;
  foreign_keys=ON; busy_timeout=5000;`.
- IDs are **ULIDs** stored as 26-char TEXT (sortable, no coordination).
- Times are `INTEGER` unix millis, columns suffixed `_at`.
- Migrations: `migrations/NNNN_name.sql`, applied in a transaction each, tracked in
  `schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER)`. Forward-only; a
  rollback of the daemon must tolerate newer schema, so migrations are **additive only**
  (new tables/columns; never drop/rename within a minor line). Destructive cleanup happens
  in a later migration after the fleet is past the old version.

### 4.2 Core schema (`migrations/0001_init.sql`)

```sql
-- Every machine in the fleet, including self (is_self = 1, exactly one row).
CREATE TABLE nodes (
  id            TEXT PRIMARY KEY,           -- nodeId = "stw1" + base32(ed25519 pubkey), see FLEET.md §2.2
  pubkey        TEXT NOT NULL UNIQUE,       -- ed25519, base64
  name          TEXT NOT NULL,              -- "erics-mbp", editable
  is_self       INTEGER NOT NULL DEFAULT 0,
  os            TEXT NOT NULL,              -- 'darwin' | 'linux'
  arch          TEXT NOT NULL,
  roles         TEXT NOT NULL DEFAULT '[]', -- JSON, from {"laptop","desktop","server","backup"}
  endpoints     TEXT NOT NULL DEFAULT '[]', -- JSON mesh addrs: ["192.168.1.10:4778","host.ts.net:4778"]
  version       TEXT,                       -- steward version last seen
  paired_at     INTEGER NOT NULL,
  last_seen_at  INTEGER,
  status        TEXT NOT NULL DEFAULT 'offline'  -- 'online'|'offline'|'revoked'
);

-- Scan roots come from config; rows record per-root scan state.
CREATE TABLE scan_roots (
  id            TEXT PRIMARY KEY,
  node_id       TEXT NOT NULL REFERENCES nodes(id),
  path          TEXT NOT NULL,              -- absolute, e.g. /Users/eric/Code
  last_scan_id  TEXT,
  UNIQUE(node_id, path)
);

-- One row per scan execution (a job produces exactly one).
CREATE TABLE scans (
  id            TEXT PRIMARY KEY,
  root_id       TEXT NOT NULL REFERENCES scan_roots(id),
  job_id        TEXT NOT NULL,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  status        TEXT NOT NULL,              -- 'running'|'done'|'failed'|'interrupted'
  dirs_seen     INTEGER NOT NULL DEFAULT 0,
  files_seen    INTEGER NOT NULL DEFAULT 0,
  bytes_seen    INTEGER NOT NULL DEFAULT 0,
  novel_bytes   INTEGER NOT NULL DEFAULT 0,
  error         TEXT
);

-- Git repositories discovered under scan roots.
CREATE TABLE repos (
  id             TEXT PRIMARY KEY,
  node_id        TEXT NOT NULL REFERENCES nodes(id),
  path           TEXT NOT NULL,             -- worktree root, absolute
  origin_url     TEXT,                      -- NULL => remote-less (danger!)
  head_ref       TEXT,                      -- 'refs/heads/main' or detached sha
  head_sha       TEXT,
  is_dirty       INTEGER NOT NULL DEFAULT 0,
  untracked      INTEGER NOT NULL DEFAULT 0,   -- count of untracked files
  ahead          INTEGER NOT NULL DEFAULT 0,   -- commits ahead of upstream
  behind         INTEGER NOT NULL DEFAULT 0,
  stashes        INTEGER NOT NULL DEFAULT 0,
  unpushed_branches TEXT NOT NULL DEFAULT '[]', -- JSON ["feature-x", ...]
  size_bytes     INTEGER NOT NULL DEFAULT 0,    -- excluding .git and derivable dirs
  last_commit_at INTEGER,
  audited_at     INTEGER,
  risk           TEXT NOT NULL DEFAULT 'unknown',
    -- 'safe'      : clean, pushed, has remote
    -- 'unpushed'  : has remote, but ahead>0 or unpushed branches
    -- 'dirty'     : uncommitted changes / untracked / stashes
    -- 'orphan'    : no remote at all
    -- 'unknown'   : not yet audited
  gone           INTEGER NOT NULL DEFAULT 0,    -- path vanished on a later scan
  UNIQUE(node_id, path)
);
CREATE INDEX repos_risk ON repos(node_id, risk) WHERE gone = 0;

-- File index. One row per file currently believed to exist. Directories are not rows;
-- they are reconstructed from paths (and aggregated in dir_stats below).
CREATE TABLE files (
  id            TEXT PRIMARY KEY,
  node_id       TEXT NOT NULL REFERENCES nodes(id),
  root_id       TEXT NOT NULL REFERENCES scan_roots(id),
  path          TEXT NOT NULL,              -- absolute
  size          INTEGER NOT NULL,
  mtime_ms      INTEGER NOT NULL,
  inode         INTEGER,
  class         TEXT NOT NULL,              -- 'novel'|'derivable'|'ignored' (§5.5); indexing
                                            -- migrations extend this enum with subclasses
                                            -- novel-secret/novel-suspect/derivable-remote/
                                            -- derivable-refetch (see INDEXING.md §4)
  class_reason  TEXT,                       -- rule that matched, e.g. 'node_modules'
  repo_id       TEXT REFERENCES repos(id),  -- containing repo, if any
  git_tracked   INTEGER,                    -- NULL if not in a repo
  content_hash  TEXT,                       -- sha256 hex; NULL until hashed (lazy)
  hashed_at     INTEGER,
  last_seen_scan TEXT NOT NULL,             -- scans.id that last confirmed existence
  gone          INTEGER NOT NULL DEFAULT 0,
  UNIQUE(node_id, path)
);
CREATE INDEX files_hash    ON files(content_hash) WHERE content_hash IS NOT NULL;
CREATE INDEX files_class   ON files(node_id, class) WHERE gone = 0;
CREATE INDEX files_repo    ON files(repo_id);
CREATE INDEX files_seen    ON files(root_id, last_seen_scan);

-- Aggregates per directory for fast treemap UI; recomputed at scan end.
CREATE TABLE dir_stats (
  node_id       TEXT NOT NULL,
  path          TEXT NOT NULL,
  depth         INTEGER NOT NULL,
  total_bytes   INTEGER NOT NULL,
  novel_bytes   INTEGER NOT NULL,
  file_count    INTEGER NOT NULL,
  redundancy_min INTEGER NOT NULL DEFAULT 1,  -- min copies of any novel file within
  PRIMARY KEY(node_id, path)
);

-- Content-addressed blob metadata (data lives in ~/.steward/blobs, §4.3).
CREATE TABLE blobs (
  hash          TEXT PRIMARY KEY,           -- sha256 hex of chunk
  size          INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  refcount      INTEGER NOT NULL DEFAULT 0  -- maintained by snapshot add/gc
);

-- Which nodes hold which blob => redundancy is computable by JOIN.
CREATE TABLE blob_locations (
  hash          TEXT NOT NULL REFERENCES blobs(hash),
  node_id       TEXT NOT NULL REFERENCES nodes(id),
  verified_at   INTEGER NOT NULL,           -- last time presence was confirmed
  PRIMARY KEY(hash, node_id)
);

-- A backup snapshot: a manifest mapping paths -> chunk lists at a point in time.
CREATE TABLE snapshots (
  id            TEXT PRIMARY KEY,
  node_id       TEXT NOT NULL,              -- source node
  target        TEXT NOT NULL,              -- scan root or repo path snapshotted
  manifest_hash TEXT NOT NULL,              -- blob hash of JSON manifest (itself CAS'd)
  file_count    INTEGER NOT NULL,
  byte_count    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);

-- Job queue (§5).
CREATE TABLE jobs (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,              -- 'scan'|'repo_audit'|'backup'|'sync'|'update'|...
  params        TEXT NOT NULL DEFAULT '{}', -- JSON
  dedupe_key    TEXT,                       -- e.g. 'scan:/Users/eric/Code'
  status        TEXT NOT NULL DEFAULT 'queued',
    -- 'queued'|'running'|'done'|'failed'|'interrupted'|'canceled'
  priority      INTEGER NOT NULL DEFAULT 5, -- 1 highest .. 9 lowest
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  run_after     INTEGER NOT NULL DEFAULT 0, -- delay / backoff gate
  checkpoint    TEXT,                       -- JSON, handler-defined resume state (§5.4)
  progress      TEXT,                       -- JSON {phase, done, total, message}
  error         TEXT,
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  finished_at   INTEGER,
  heartbeat_at  INTEGER                     -- lease liveness while running
);
CREATE UNIQUE INDEX jobs_dedupe ON jobs(dedupe_key)
  WHERE status IN ('queued','running');
CREATE INDEX jobs_ready ON jobs(status, priority, run_after);

-- Append-only event log; the event bus persists here (§7).
CREATE TABLE events (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  id            TEXT NOT NULL UNIQUE,       -- ulid
  topic         TEXT NOT NULL,              -- 'job.progress', 'repo.changed', ...
  payload       TEXT NOT NULL,              -- JSON
  created_at    INTEGER NOT NULL
);
CREATE INDEX events_topic ON events(topic, seq);

-- Vault: ciphertext only; the daemon never sees plaintext or keys (crypto lives in a
-- browser Web Worker — XChaCha20-Poly1305 + argon2id, full design in SECURITY.md §5).
CREATE TABLE vault_header (                 -- exactly one row per vault; synced
  vault_id        TEXT PRIMARY KEY,
  kdf             TEXT NOT NULL,            -- JSON argon2id params + salt
  key_generation  INTEGER NOT NULL,         -- bumped on password rotation
  wrapped_vault_key BLOB NOT NULL,
  verifier        BLOB NOT NULL,
  updated_at      INTEGER NOT NULL,
  updated_by      TEXT NOT NULL             -- nodeId
);
CREATE TABLE vault_items (
  item_id         TEXT PRIMARY KEY,         -- uuidv7
  key_generation  INTEGER NOT NULL,
  wrapped_item_key BLOB NOT NULL,
  ciphertext      BLOB NOT NULL,            -- includes the encrypted title; daemon sees nothing
  version_vector  TEXT NOT NULL,            -- JSON {"<nodeId>": counter}; concurrent edits
                                            -- keep both rows (SECURITY.md §6) — never silent LWW
  deleted         INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL,
  updated_by      TEXT NOT NULL
);
```

**Redundancy score** (BRIEF promise #3) is derived, not stored per-file:
for a novel file with `content_hash = H`, redundancy = distinct locations of its chunks:
`SELECT MIN(cnt) FROM (SELECT COUNT(DISTINCT node_id) cnt FROM blob_locations WHERE hash IN (chunks of H) GROUP BY hash)`
plus 1 for the live copy, plus (for git-tracked, pushed files) credit for the remote.
`dir_stats.redundancy_min` caches the minimum over a directory for the fleet dashboard.

### 4.3 Blob store

Content-addressed at `~/.steward/blobs/sha256/<h[0:2]>/<h[2:4]>/<hash>`, written via
`tmp/` + `rename()` for atomicity. Files > 1 MiB are chunked with FastCDC (min 256 KiB,
avg 1 MiB, max 4 MiB) so edited large files dedupe; files ≤ 1 MiB are single chunks.
A snapshot manifest is JSON `{files: [{path, mode, mtime, size, chunks: [hash...]}]}`,
itself stored as a blob and referenced by `snapshots.manifest_hash`. GC = mark from live
snapshot manifests, sweep unreferenced blobs older than 7 days, run as a low-priority job.

---

## 5. Jobs

### 5.1 Model

Everything long-running is a **job**: scans, repo audits, backups, node syncs, blob GC,
self-update. Jobs live in the `jobs` table (the queue survives restarts), execute in-process
in the `JobRunner`, and communicate progress via the event bus.

```ts
// src/jobs/registry.ts
export interface JobHandler<P, C> {
  type: string;
  concurrencyGroup?: string;       // jobs in the same group never run concurrently
  run(job: JobHandle<P, C>): Promise<void>;
}
export interface JobHandle<P, C> {
  id: string;
  params: P;
  checkpoint: C | null;                       // from previous attempt, if resuming
  saveCheckpoint(c: C): void;                 // persisted immediately (single UPDATE)
  progress(p: {phase: string; done?: number; total?: number; message?: string}): void;
  canceled(): boolean;                        // handlers poll at loop boundaries
  log: Logger;                                // child logger bound to job id
}
```

### 5.2 Scheduling loop

`JobRunner.tick()` runs on demand (enqueue) and every 5s:

1. Claim: `UPDATE jobs SET status='running', started_at=?, heartbeat_at=?, attempts=attempts+1
   WHERE id = (SELECT id FROM jobs WHERE status='queued' AND run_after<=? ORDER BY priority, created_at LIMIT 1) RETURNING *`
   — single-writer SQLite makes this race-free.
2. Skip claim if the handler's `concurrencyGroup` already has a running job, or if 4 slots
   are full. Default groups: `disk-io` (scan, backup — max 1 to avoid thrashing spinning
   backup disks), `net` (sync — max 2), ungrouped (max 4 total).
3. Heartbeat: running jobs update `heartbeat_at` every 10s (runner does it, not handlers).
4. Completion: `done` / `failed` (+ `run_after = now + min(2^attempts * 30s, 1h)` if
   attempts < max_attempts, else terminal `failed`).

`dedupe_key` prevents pile-ups: enqueuing `scan:/Users/eric/Code` while one is queued or
running is a no-op returning the existing job id.

### 5.3 Recurring jobs

The `Scheduler` (30s tick) reads schedules from config (§10) and enqueues with dedupe keys.
Defaults: full scan of each root every 6h, repo audit sweep every 1h, backup per policy,
blob verify (re-stat + spot-hash of `blob_locations`) weekly, update check daily.
Filesystem watcher events also enqueue targeted scans (coalesced dirty-set debounce —
quiet 5s / dirty 60s, see INDEXING.md §2.5).

### 5.4 Resumability

Rule: **handlers must be idempotent per checkpoint interval.** A checkpoint is a small JSON
blob the handler can resume from; the runner persists it synchronously on `saveCheckpoint`.
On boot, jobs found `running` are flipped to `interrupted` and requeued (keeping their
checkpoint) without consuming an attempt.

Checkpoint shapes:

- **scan**: `{cursor: "/Users/eric/Code/mtt"}` — last fully-processed top-level entry;
  scan iterates `readdir` in sorted order so the cursor is a resume point. Per-file rows
  are upserted, so re-processing an entry is harmless.
- **backup**: `{manifestBuilt: bool, uploadedChunks: number}` — chunks already in the CAS
  are skipped by hash check, so resume is a fast no-op until the frontier.
- **sync**: `{lastEventSeq: number, lastBlobHash: string}`.

### 5.5 The scan job (core algorithm)

Input: `{rootId}`. Phases: `walk` → `classify` → `git` → `aggregate`.

1. **Walk.** Iterative DFS with an explicit stack, sorted entries (for cursor resume).
   At each directory, first apply **prune rules** — if the dirname matches the derivable
   set, record one synthetic "derivable subtree" file row (path = dir, size = `du` of
   subtree computed by continuing the walk in counting-only mode) and do not index within.
   Default prune set: `node_modules`, `.git` (handled specially), `dist`, `build`, `out`,
   `.next`, `.turbo`, `.cache`, `target`, `Pods`, `DerivedData`, `venv`, `.venv`,
   `__pycache__`, `coverage`, `.gradle`, `.expo`. Configurable via `classify.derivableDirs`.
2. **Classify** each file (`src/scan/classify.ts`), first match wins:
   1. `ignored` — name match: `.DS_Store`, `*.sock`, `*.lock` temp files, size 0 + known junk.
   2. `derivable` — inside pruned subtree (already handled), or extension in
     `{.o,.pyc,.class,.map}` etc., or matched by the containing repo's `.gitignore`
     (via `git check-ignore --stdin` batch call — cheap and exactly matches user intent).
   3. `novel` — everything else. Untracked-but-gitignored is derivable; untracked and
     NOT ignored is novel and flagged.
3. **Git.** Every directory containing `.git` registers/updates a `repos` row and enqueues
   a `repo_audit` job (dedupe-keyed). Audit shells out:
   `git status --porcelain=v2 --branch`, `git stash list`, `git for-each-ref
   --format='%(refname:short) %(upstream:track)' refs/heads`, `git count-objects`.
   Computes `risk` per the enum in §4.2.
4. **Aggregate.** Mark rows whose `last_seen_scan` < this scan and path under this root as
   `gone=1`; rebuild `dir_stats` for the root with a recursive CTE; emit `scan.finished`.

Content hashing is **lazy**: a separate low-priority `hash_sweep` job hashes novel files
(newest-mtime first, budgeted at 30 min/day by default) since redundancy scoring needs
hashes but scans must be fast (300 project dirs ≈ minutes, not hours).

---

## 6. HTTP + WS API

### 6.1 Conventions

- Base: `http://127.0.0.1:4777/api`. UI static assets at `/` (Hono `serveStatic` from
  `$CURRENT/dist/ui`, SPA fallback to `index.html`).
- Auth, two callers (full design in SECURITY.md §4): **CLI** sends
  `Authorization: Bearer <token>` where token is the 0600 file `~/.steward/token`;
  **browser** exchanges that token (via `steward open`) for a 30s one-time ticket, then a
  `HttpOnly SameSite=Strict` session cookie — the long-lived token never enters the page.
  All requests pass Host/Origin checks (DNS-rebinding/CSRF). Node-to-node requests
  authenticate via the peer channel session (§6.4) — never via the bearer token.
- Errors: `{error: {code: "REPO_NOT_FOUND", message, details?}}` with proper HTTP status.
- All list endpoints accept `?limit=&cursor=` (cursor = last ULID) and return
  `{items, nextCursor}`.

### 6.2 Route table

| Method | Path | Body / params | Returns |
|---|---|---|---|
| GET | `/api/system/health` | — | `{app: "steward", ok, version, gitSha, uptimeMs, db: {sizeBytes}, jobs: {queued, running}}` — the `"app":"steward"` marker is how the installer distinguishes an old steward from a foreign listener (INSTALL.md §3/§8) |
| GET | `/api/system/version` | — | `{version, gitSha, builtAt, channel}` |
| POST | `/api/system/update` | `{ref?}` | enqueues `update` job → `{jobId}` |
| POST | `/api/system/restart` | — | daemon finishes in-flight work, exits 64 (supervisor relaunches) |
| GET | `/api/system/logs` | `?level=&since=&limit=` | `{items: LogLine[]}` (from ring buffer + file tail) |
| GET | `/api/config` | — | redacted config (no secrets) |
| PATCH | `/api/config` | JSON merge patch | new config (validated, then written to disk) |
| GET | `/api/nodes` | — | `{items: Node[]}` incl. self, status, lastSeen, disk stats |
| GET | `/api/nodes/:id` | — | Node detail + capabilities |
| POST | `/api/nodes/pairing/start` | — | `{code: "738-114", expiresAt}` (this node listens) |
| POST | `/api/nodes/pairing/complete` | `{code, endpoint}` | `{node}` (dials endpoint, verifies code, exchanges pubkeys) |
| DELETE | `/api/nodes/:id` | — | revoke pairing |
| ANY | `/api/nodes/:id/proxy/*` | any | transparently forwards the request to that node's API over the authenticated WS tunnel; this is how "administer every node from any node" works — remote UIs reuse the same routes |
| GET | `/api/roots` | — | scan roots with last-scan summaries |
| POST | `/api/roots` | `{path}` | adds root (also persisted to config) |
| POST | `/api/roots/:id/scan` | `{full?: bool}` | `{jobId}` |
| GET | `/api/scans/:id` | — | scan row + live progress |
| GET | `/api/repos` | `?risk=&q=&sort=` | `{items: Repo[]}` |
| GET | `/api/repos/:id` | — | repo detail: branches, stashes, ahead/behind, size |
| POST | `/api/repos/:id/audit` | — | `{jobId}` re-audit now |
| GET | `/api/repos/:id/status` | — | live `git status --porcelain=v2` parsed: staged/unstaged/untracked entries |
| GET | `/api/repos/:id/log` | `?ref=&limit=` | commit list |
| GET | `/api/repos/:id/diff` | `?path=&staged=` | unified diff text |
| POST | `/api/repos/:id/stage` | `{paths: string[]}` | ok |
| POST | `/api/repos/:id/unstage` | `{paths}` | ok |
| POST | `/api/repos/:id/commit` | `{message}` | `{sha}` |
| POST | `/api/repos/:id/branch` | `{name, from?}` | ok |
| POST | `/api/repos/:id/checkout` | `{ref}` | ok |
| POST | `/api/repos/:id/push` | `{remote?, ref?, setUpstream?}` | `{jobId}` (push is a job: slow, streamed) |
| POST | `/api/repos/:id/pull` | `{remote?}` | `{jobId}` |
| GET | `/api/files` | `?under=&class=&minSize=&q=` | file rows |
| GET | `/api/files/tree` | `?path=&depth=` | `dir_stats` subtree for treemap UI |
| GET | `/api/files/duplicates` | `?minSize=` | groups of same-hash files across paths/nodes |
| GET | `/api/redundancy/summary` | — | `{novelBytes, byRedundancy: {0: bytes, 1: …, 2: …}}` fleet-wide |
| GET | `/api/jobs` | `?status=&type=` | job rows |
| GET | `/api/jobs/:id` | — | job + checkpoint + progress |
| POST | `/api/jobs/:id/cancel` | — | ok (sets canceled flag; handler observes) |
| POST | `/api/jobs/:id/retry` | — | requeues a failed job |
| GET | `/api/snapshots` | `?target=` | snapshot list |
| POST | `/api/backups/run` | `{target, toNodes?: string[]}` | `{jobId}` |
| GET | `/api/backups/policy` | — | policies from config |
| GET | `/api/docker/containers` | — | live list via Docker Engine HTTP API over the unix socket (never the `docker` CLI); full docker route set in DOCKER-CI.md §1.3 |
| POST | `/api/docker/containers/:id/:action` | action ∈ start/stop/restart/rm | ok |
| GET | `/api/docker/images` \| `/compose` | — | images / compose project status |
| GET | `/api/vault/header` | — | vault header row (kdf params, key_generation) |
| PUT | `/api/vault/header` | header row | create / rotate (SECURITY.md §7) |
| GET | `/api/vault/items` | `?since=` | ciphertext rows `{item_id, key_generation, wrapped_item_key, ciphertext, version_vector, deleted, updated_at}[]` |
| PUT | `/api/vault/items/:id` | encrypted row + bumped version_vector | 409 with current row if VV conflicts (client merges & retries) |
| DELETE | `/api/vault/items/:id` | — | tombstone |
| ANY | `/git/:nodeId/:repoId.git/*` | git smart-HTTP | local mirrors served via `git http-backend`; remote nodes proxied over the peer channel (DOCKER-CI.md §2.3) |
| GET | `/api/events` | `?since=<seq>&topics=` | replay from event log (catch-up REST) |
| GET (WS) | `/api/ws` | — | live event stream (§6.3) |
| GET (WS) | `/api/peer` | — | node-to-node channel (§6.4) — served on the **mesh listener** `0.0.0.0:4778`, not the loopback HTTP server |

### 6.3 UI WebSocket protocol (`/api/ws`)

Client → server messages:

```jsonc
{"t":"auth","token":"<bearer>"}                      // must be first
{"t":"sub","topics":["job.*","repo.*"],"since":8123} // glob topics; since = event seq for replay
{"t":"unsub","topics":["repo.*"]}
{"t":"ping"}
```

Server → client:

```jsonc
{"t":"event","seq":8124,"topic":"job.progress","payload":{"jobId":"01J…","phase":"walk","done":1240,"total":0}}
{"t":"pong"}
{"t":"err","code":"AUTH_REQUIRED"}
```

Because every event has a monotonic `seq` and is persisted (§7), a reconnecting client
sends `since` and misses nothing. The UI's data layer is: fetch REST snapshot → subscribe
with `since = snapshot's seq header` (`X-Steward-Seq` on every REST response) → apply events.

### 6.4 Node-to-node channel (`/api/peer`)

The mesh listener binds `0.0.0.0:4778` and speaks only this channel (the loopback server
on 4777 never leaves the machine — see FLEET.md §4.1). Outbound-dialed WS from each node
to each paired peer (deterministic dial direction — smaller nodeId dials; crossed connects
close the duplicate). Handshake: Noise `XX`-style over the socket using the ed25519
identities (converted to x25519 for DH); peers must already be in `nodes` (pairing
established trust). Wire format is normative in FLEET.md §4.3. After handshake, the
channel carries multiplexed frames:

```
{"ch":"rpc","id":"…","req":{method,path,headers,body}}   // powers /api/nodes/:id/proxy
{"ch":"events","topic":"…", ...}                          // gossip: repo/redundancy summaries
{"ch":"blob","hash":"…","op":"has"|"get"|"put", ...}      // backup replication
```

---

## 7. Event bus

`src/core/bus.ts` — one class, two responsibilities: **fan-out** and **persistence**.

```ts
class EventBus {
  emit(topic: string, payload: unknown): number  // returns seq
  subscribe(pattern: string, fn: (e: StewardEvent) => void): () => void
  replay(sinceSeq: number, patterns: string[]): StewardEvent[]  // reads events table
}
```

- `emit` does: INSERT into `events` (getting `seq`), then synchronous fan-out to in-process
  subscribers (WS connections, PeerManager gossip, log sink).
- Topic taxonomy (dot-separated, `*` glob per segment):
  `job.queued|started|progress|done|failed`, `scan.started|finished`,
  `repo.discovered|changed|risk`, `file.changed` (coalesced), `node.online|offline|paired`,
  `backup.progress|done`, `redundancy.changed`, `vault.changed`, `system.updating|updated`.
- High-frequency producers (scan progress) are throttled at the source: `progress()` emits
  at most every 500 ms per job.
- Retention: `DELETE FROM events WHERE created_at < now-7d` nightly, but never below the
  minimum `since` of currently-connected clients. UI reconnects older than that fall back
  to full REST refetch (signaled by `{"t":"err","code":"SEQ_TOO_OLD"}`).

---

## 8. Logging

- **Format:** JSONL to `~/.steward/logs/daemon.log`:
  `{"ts":1755500000000,"lvl":"info","mod":"jobs.scan","jobId":"01J…","msg":"walk done","files":48211}`.
- **Logger:** tiny homegrown (`src/core/log.ts`), no dependency. `log.child({mod, jobId})`
  bindings. Levels trace/debug/info/warn/error; level per-module via config
  (`log.levels: {"jobs.scan": "debug"}`).
- **Sinks:** (1) file with size-based rotation (rotate at 20 MiB, keep 5, gzip old);
  (2) in-memory ring buffer of last 2,000 lines serving `/api/system/logs` and the UI log
  view; (3) `warn`+ also emitted on the bus as `system.log` so the UI can toast errors.
- stdout/stderr are left to the supervisor's capture files (crash output only — the daemon
  logs to its own file so rotation is under our control).

---

## 9. Self-update

Design goals: never brick the daemon; rollback is the default outcome unless the new
version proves itself; the supervisor stays dumb.

### 9.1 Layout recap

- `~/.steward/checkouts/<shortsha>/` — full git worktrees of the steward repo, each with
  `dist/ui` built and `bun install --frozen-lockfile` completed.
- `~/.steward/current` — symlink to the active checkout. The shim (§1.2) always execs
  through `current`, so a symlink swap + restart = version switch.
- `~/.steward/checkouts/.repo/` — the bare-ish primary clone (`git fetch` target);
  worktrees are created from it (`git worktree add`).

### 9.2 Update job algorithm (`src/jobs/update.ts`)

1. `git -C checkouts/.repo fetch origin` → resolve target sha (config `update.ref`,
   default `origin/main`; API may pass explicit `ref`).
2. If target sha == current sha → done (no-op).
3. **Stage:** `git worktree add checkouts/<sha> <sha>`; in it run
   `bun install --frozen-lockfile` and `bun run build` (UI + typecheck). Any failure →
   delete worktree, job `failed`, current version untouched.
4. **Smoke test:** `bun checkouts/<sha>/src/daemon/main.ts --selftest` runs in a subprocess:
   loads config, opens the DB **read-only**, checks migrations are applicable
   (additive-only rule §4.1), binds port 0, exits 0. Failure → abort as above.
5. **Switch:** write `~/.steward/update.json` = `{from: <oldsha>, to: <sha>, at, state: "switching"}`;
   atomically repoint symlink (`ln -sfn` via rename of a temp symlink); emit
   `system.updating`; then `process.exit(0)`. Supervisor restarts → shim execs new version.
6. **Confirm (new version, boot step 7):** if `update.json.state == "switching"`, the new
   daemon runs post-boot self-checks (HTTP health OK, DB writable, one trivial job
   round-trip), then after **120s of uptime** sets `state: "confirmed"`, emits
   `system.updated`, and prunes checkouts beyond the newest 3 (never the `from` sha until
   confirmed).

### 9.3 Rollback

Two layers:

- **Shim-level (handles "won't even boot"):** the shim increments a crash counter in
  `~/.steward/update.json` each start while `state == "switching"`. If the counter hits 3,
  the shim itself repoints `current` back to `from`, sets `state: "rolled_back"`, and execs
  the old version. This is why rollback logic must live in bash + symlinks, not in the
  possibly-broken new code.
- **Daemon-level (handles "boots but unhealthy"):** if post-boot self-checks fail during
  the 120s probation, the daemon repoints the symlink back and exits, letting the
  supervisor restart into the old version.

After `rolled_back`, updates to that sha are blocked (recorded in `update.json.blockedShas`)
until a newer sha appears, so we don't crash-loop through the same bad version daily.

### 9.4 Dev mode

`steward daemon run --dev` skips the shim/symlink machinery, runs from the working
checkout with `--watch`, uses ports 4779 (HTTP) / 4780 (mesh; 4778 belongs to the real
daemon) and `~/.steward-dev/` so the real daemon keeps running. Guardrail: self-update
refuses to run when the active checkout is dirty.

---

## 10. Configuration — `~/.steward/config.json`

Zod-validated (`src/core/config.ts`), watched for changes (debounced 1s, revalidated;
invalid edits are rejected with a `system.log` warn and the old config stays live).
Comments are supported (JSON5 parse; written back as pretty JSON with a `$schema` key
pointing at a schema file in the checkout for editor autocomplete).

```jsonc
{
  "$schema": "./current/schema/config.schema.json",
  "node": {
    "name": "erics-mbp",                 // default: hostname
    "roles": ["laptop"]                  // "laptop" | "desktop" | "server" | "backup"
  },
  "server": {
    "port": 4777,                        // localhost bind only; mesh listens on 4778 (FLEET.md §4.1)
    "openUiOnStart": false
  },
  "scan": {
    "roots": ["~/Code", "~/Documents", "~/Desktop"],
    "excludes": ["~/Code/**/tmp"],       // gitignore-style globs
    "fullScanIntervalHours": 6,
    "watch": true,
    "hashBudgetMinutesPerDay": 30
  },
  "classify": {
    "derivableDirs": ["node_modules", ".next", "dist", "target", "Pods"],  // merged with builtins
    "extraNovel": ["**/*.env"]           // force-classify patterns
  },
  "backup": {
    "policies": [
      { "target": "~/Code", "onlyNovel": true, "minRedundancy": 2,
        "toNodes": ["backup-tower"], "intervalHours": 24 }
    ]
  },
  "fleet": {
    "peers": [                            // informational cache; source of truth is DB
      { "name": "backup-tower", "endpoints": ["tower.ts.net:4778"] }
    ],
    "heartbeatSeconds": 20
  },
  "update": {
    "auto": true,                        // daily check + auto-apply
    "ref": "origin/main",
    "checkHourLocal": 4
  },
  "jobs": { "maxSlots": 4, "diskIoSlots": 1 },
  "log": { "level": "info", "levels": { "fleet.peers": "debug" } }
}
```

Precedence: DB is source of truth for *state* (nodes, repos, files); config is source of
truth for *intent* (roots, policies, schedules). API mutations that change intent
(`POST /api/roots`) write through to `config.json` so the file stays the single editable
artifact for machine convergence ("facets" will later template this file).

---

## 11. Open questions (tracked, not blocking)

- Whether repo-audit should also fingerprint pack refs to detect "pushed to a remote that
  no longer exists" (origin 404). Likely a slow weekly `git ls-remote` sweep, opt-in.
- FastCDC in pure TS vs. a small native addon — start pure TS, benchmark on the ~300-repo
  corpus.
- ~~Vault sync conflict handling~~ — resolved: per-item version vectors with
  conflict-copy semantics (SECURITY.md §6).
