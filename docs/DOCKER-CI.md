# Docker Management, Git Sync & CI

Design for three related capabilities: **Docker awareness/control** (promise 7 of the
BRIEF), **node-to-node git sync** (promise 5, "no GitHub required"), and an
**actions-like CI runner** (promise 5, "later"). They stack: git sync feeds CI its
commits, and CI runs its jobs in Docker containers that the Docker subsystem manages.

Phasing at a glance:

| Phase | Scope |
|-------|-------|
| **v0** | Local-node Docker: engine discovery, list/inspect containers/images/volumes/networks, start/stop/restart/rm, logs + exec over WS, compose project detection (read-only), disk usage + prune *suggestions* (no auto-prune). |
| **v1** | Fleet Docker (same UI against any node), compose up/down/restart, guarded prune execution, docker event stream → live UI. Git sync: bare mirrors, git-over-steward-channel transport, auto-push policies, mirror redundancy feeding the redundancy score. |
| **v2** | CI: YAML workflows in repos, docker-executed jobs on chosen nodes, log streaming, per-commit status. SSH transport fallback for git sync. |

Everything below is implementation-ready for its phase; v2 sections are design-complete
but explicitly *build later*.

---

## Part 1 — Docker Management

### 1.1 Engine discovery (v0)

Docker is optional per node. The daemon probes for an engine at startup and every 60s
(cheap: one `GET /_ping`). Probe order — first reachable socket wins:

1. `$DOCKER_HOST` if set (`unix://` and `tcp://` both supported; `tcp` only for
   `127.0.0.1`/`localhost` — we never reach out to remote engines directly, fleet
   routing handles remote).
2. Docker context: parse `~/.docker/config.json` → `currentContext`, then
   `~/.docker/contexts/meta/<sha256(name)>/meta.json` → `Endpoints.docker.Host`.
3. Well-known sockets, in order:
   - `/var/run/docker.sock` (Linux, and Docker Desktop's privileged symlink)
   - `~/.docker/run/docker.sock` (Docker Desktop macOS, current layout)
   - `~/.colima/default/docker.sock` and `~/.colima/<profile>/docker.sock`
     (glob `~/.colima/*/docker.sock`)
   - `~/.rd/docker.sock` (Rancher Desktop)
   - `~/.orbstack/run/docker.sock` (OrbStack)
   - `/run/user/<uid>/docker.sock` (rootless Linux)

On success, `GET /version` to record `ApiVersion`, `Version`, `Os`, `Arch`. We pin all
requests to `Min(ApiVersion, "1.43")` via the `/v1.43/...` path prefix and require
`>= 1.41` (Docker 20.10+, 2020). Below that: mark engine `unsupported`, show version in
UI, do nothing else.

**Transport module** `src/docker/client.ts`:

```ts
export type DockerEndpoint =
  | { kind: "unix"; path: string }
  | { kind: "tcp"; host: string; port: number };

export class DockerClient {
  constructor(readonly endpoint: DockerEndpoint, readonly apiVersion: string) {}
  // Bun's fetch supports unix sockets natively:
  //   fetch(`http://docker/v1.43/containers/json`, { unix: endpoint.path })
  get(path: string, query?: Record<string, string>): Promise<Response>;
  post(path: string, body?: unknown, query?: Record<string, string>): Promise<Response>;
  del(path: string): Promise<Response>;
  // Raw duplex socket for hijacked streams (exec/attach) — Bun.connect() on the
  // unix path, hand-rolled HTTP/1.1 upgrade, then raw frames. See §1.7.
  hijack(path: string, body?: unknown): Promise<DockerHijackedStream>;
}
```

No dockerode, no shelling to `docker` CLI for data (CLI output formats drift; the HTTP
API is stable and versioned). The **only** CLI shell-outs are `docker compose ...`
(§1.5) because reimplementing compose semantics is a non-goal.

### 1.2 State model: live queries + cached snapshot

Two consumers with different needs:

- **Docker pages in the UI** want fresh truth → live queries against the engine,
  proxied through the daemon. No DB involved.
- **Fleet overview / redundancy engine / offline nodes** want "what did this node's
  Docker look like last time we saw it" → periodic snapshot in SQLite.

Snapshot tables (in `~/.steward/steward.db`; `node_id` is the fleet-wide node key so
snapshots gossip between nodes like other fleet state):

```sql
CREATE TABLE docker_engine (
  node_id       TEXT PRIMARY KEY,
  status        TEXT NOT NULL,          -- 'ok' | 'unreachable' | 'unsupported' | 'absent'
  endpoint      TEXT,                   -- e.g. 'unix:///Users/e/.colima/default/docker.sock'
  version       TEXT, api_version TEXT, os TEXT, arch TEXT,
  updated_at    INTEGER NOT NULL        -- unix ms
);

CREATE TABLE docker_snapshot (
  node_id       TEXT NOT NULL,
  kind          TEXT NOT NULL,          -- 'container' | 'image' | 'volume' | 'network'
  id            TEXT NOT NULL,          -- engine object id (volume: name)
  name          TEXT,                   -- primary name, no leading slash
  state         TEXT,                   -- containers: 'running'|'exited'|... ; images: NULL
  compose_project TEXT,                 -- from label com.docker.compose.project
  compose_service TEXT,
  size_bytes    INTEGER,                -- images: Size; volumes: UsageData.Size if known
  labels_json   TEXT NOT NULL DEFAULT '{}',
  raw_json      TEXT NOT NULL,          -- full list-endpoint object, for detail views
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (node_id, kind, id)
);

CREATE INDEX docker_snapshot_project ON docker_snapshot(node_id, compose_project);

CREATE TABLE docker_disk_usage (
  node_id     TEXT PRIMARY KEY,
  df_json     TEXT NOT NULL,            -- raw GET /system/df response
  updated_at  INTEGER NOT NULL
);
```

Snapshot refresh: full re-list (`/containers/json?all=1`, `/images/json`,
`/volumes`, `/networks`) every 5 minutes **and** debounced (2s) after any relevant
`/events` message. `/system/df` is expensive on big engines — refresh every 30 minutes
and on demand when the user opens the disk page.

**Event stream** (v0 local, v1 fleet): the daemon holds one long-lived
`GET /events?filters={"type":["container","image","volume","network"]}` request per
engine, auto-reconnecting with `since=<last event time>` and 1s→30s backoff. Events are
re-broadcast on the daemon's internal pub/sub bus as `docker.event` and pushed to any
subscribed UI over WS, driving live container-list updates without polling.

### 1.3 HTTP API (v0 local, v1 adds `node` param)

All under the daemon's Hono app. Every route takes `?node=<nodeId>`; omitted or
`self` = local. For remote nodes the daemon forwards the request verbatim over the
authenticated node channel (the fleet channel is the *only* path to a remote engine —
remote Docker sockets are never exposed).

```
GET    /api/docker/engine                       → docker_engine row (live-probed)
GET    /api/docker/containers?all=1             → list (live)
GET    /api/docker/containers/:id               → inspect
POST   /api/docker/containers/:id/start|stop|restart|pause|unpause|kill
DELETE /api/docker/containers/:id?force=1&volumes=0
GET    /api/docker/containers/:id/stats         → one-shot stats (stream=false)
GET    /api/docker/images                       → list (live)
GET    /api/docker/images/:ref                  → inspect (+history)
DELETE /api/docker/images/:ref?force=0
POST   /api/docker/images/pull  {ref}           → 202 + progress over WS topic
GET    /api/docker/volumes
DELETE /api/docker/volumes/:name                -- refused if snapshot shows an
                                                -- attached container; ?force=1 overrides
GET    /api/docker/networks
GET    /api/docker/df                           → disk usage + prune plan (§1.6)
POST   /api/docker/prune  {actions:[...], dryRun:bool}   (v1; §1.6)
GET    /api/docker/compose                      → compose projects (§1.5)
POST   /api/docker/compose/:projectId/up|down|restart|pull   (v1)
```

Mutating routes are `POST`/`DELETE` and return `{ok:true}` or a structured error
`{error:{code, message, dockerStatus}}`. Container IDs accepted as full or short id or
name; the daemon passes them through — the engine resolves.

### 1.4 WebSocket protocol for logs / exec / progress

One multiplexed WS at `GET /api/ws` (shared with the rest of Steward). Messages are
JSON envelopes; binary payloads (terminal bytes) are base64 inside JSON for v0 —
simple, and log volume doesn't justify binary framing yet. Revisit if profiling says so.

Client → server:

```jsonc
{ "op": "sub",  "topic": "docker.logs", "id": "s1",
  "params": { "node": "self", "container": "abc123", "tail": 500, "follow": true, "timestamps": true } }
{ "op": "sub",  "topic": "docker.events", "id": "s2", "params": { "node": "self" } }
{ "op": "exec.open", "id": "e1",
  "params": { "node": "self", "container": "abc123", "cmd": ["/bin/sh"], "tty": true,
              "env": [], "workdir": null, "cols": 120, "rows": 32 } }
{ "op": "exec.stdin",  "id": "e1", "data": "<base64>" }
{ "op": "exec.resize", "id": "e1", "cols": 80, "rows": 24 }
{ "op": "unsub", "id": "s1" }   // also closes execs
```

Server → client:

```jsonc
{ "op": "data",  "id": "s1", "stream": "stdout", "data": "<base64>", "ts": 1755500000000 }
{ "op": "data",  "id": "e1", "stream": "stdout", "data": "<base64>" }
{ "op": "event", "id": "s2", "event": { /* raw docker event */ } }
{ "op": "closed","id": "e1", "exitCode": 0 }
{ "op": "error", "id": "e1", "code": "container_not_running", "message": "..." }
```

**Logs**: `GET /containers/:id/logs?follow=1&stdout=1&stderr=1&tail=N&timestamps=1`.
For non-TTY containers the body is stdcopy-framed: 8-byte header
`[streamType, 0,0,0, len_be32]` then `len` bytes. The daemon demuxes and tags each
chunk `stdout`/`stderr`. TTY containers are raw → tag everything `stdout`.

**Exec**: `POST /containers/:id/exec` → `{Id}`, then `POST /exec/:eid/start` with
`Connection: Upgrade, Upgrade: tcp` on the hijacked socket. `tty:true` → raw
bidirectional bytes; resize via `POST /exec/:eid/resize?w=&h=`. On stream close,
`GET /exec/:eid/json` for `ExitCode`. UI renders with xterm.js.

**Fleet forwarding (v1)**: for `node != self`, the local daemon opens a logical
sub-channel on the node-to-node WS and relays envelopes verbatim; the remote daemon
does the actual engine work. Backpressure: per-subscription bounded queue (256
messages); on overflow drop oldest and send
`{op:"data-gap", id, dropped:N}` so the UI can render a "output truncated" divider —
never buffer unboundedly, never stall the shared WS.

### 1.5 Compose projects (v0 read-only, v1 control)

Two sources, merged by project name:

1. **Indexer-discovered files.** The filesystem indexer already walks everything; it
   flags files matching `compose.yaml|compose.yml|docker-compose.yml|docker-compose.yaml`
   (plus `*.override.*` siblings). Stored:

```sql
CREATE TABLE compose_file (
  node_id      TEXT NOT NULL,
  path         TEXT NOT NULL,           -- absolute path
  project_name TEXT NOT NULL,           -- x-steward name > top-level `name:` > dirname
  parsed_json  TEXT,                    -- normalized parse, NULL if parse failed
  parse_error  TEXT,
  mtime        INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (node_id, path)
);
```

   Parsing uses the `yaml` package. We normalize only what the UI needs — services
   (name, image, build context, ports, volumes, depends_on, profiles), top-level
   volumes/networks — into `parsed_json`. Unknown keys are preserved in a `raw` field,
   never dropped. We do **not** implement interpolation of `${VARS}` for display; show
   them literally and let `docker compose` resolve at run time.

2. **Engine labels.** Running containers carry `com.docker.compose.project`,
   `...service`, `...project.config_files`, `...project.working_dir`.

`GET /api/docker/compose` returns the merged view:

```jsonc
[{
  "project": "seedhost",
  "configFiles": ["/Users/e/Code/SeedHost/compose.yaml"],
  "workingDir": "/Users/e/Code/SeedHost",
  "source": "both",                     // 'file' | 'engine' | 'both'
  "services": [{
    "name": "db", "image": "postgres:16",
    "desired": true,                    // present in file
    "containers": [{ "id": "...", "state": "running", "health": "healthy" }]
  }],
  "status": "running"                   // running | partial | stopped | file-only | orphaned
}]
```

`orphaned` = engine labels with no known file (file deleted or on another machine) —
a first-class UI state, since that's exactly the "what is this?" question Steward exists
to answer.

**Control (v1)** shells out, always with explicit flags so state can't drift with the
user's shell env:

```
docker compose --project-directory <workingDir> -f <file> [-f <override>] -p <project> up -d
```

stdout/stderr stream to the UI over a `docker.compose-op` WS topic; exit code ends the
operation. Concurrent ops on the same project are queued (per-project mutex). If
`docker compose version` fails at engine-probe time, control buttons are disabled with
an explanatory tooltip; read-only view still works.

### 1.6 Disk usage & prune suggestions (v0 suggest, v1 execute)

`GET /api/docker/df` computes a **prune plan** from `/system/df` + snapshots:

```jsonc
{
  "totals": { "images": 41234567890, "containers": 123456, "volumes": 9876543210,
              "buildCache": 5555555555 },
  "suggestions": [
    { "id": "dangling-images",  "title": "Dangling images",            "reclaimable": 1234567890,
      "risk": "safe",    "action": { "type": "image-prune", "filters": { "dangling": ["true"] } } },
    { "id": "stopped-containers", "title": "Containers exited > 7 days", "reclaimable": 123456,
      "risk": "safe",    "action": { "type": "container-prune", "filters": { "until": ["168h"] } } },
    { "id": "build-cache",      "title": "Build cache",                 "reclaimable": 5555555555,
      "risk": "safe",    "action": { "type": "buildcache-prune", "filters": {} } },
    { "id": "unused-images",    "title": "Images unused by any container, not pulled in 30d",
      "reclaimable": 8888888888, "risk": "moderate",
      "action": { "type": "image-prune", "filters": { "dangling": ["false"], "until": ["720h"] } },
      "items": [{ "ref": "node:18", "size": 998877665 }] },
    { "id": "unused-volumes",   "title": "Volumes not attached to any container",
      "reclaimable": 4444444444, "risk": "manual-only",
      "items": [{ "name": "pg_data_old", "size": 4444444444, "lastAttached": null }] }
  ]
}
```

Risk tiers are policy, hardcoded:

- `safe` — one-click in v1 (still shows a confirm with reclaimable bytes).
- `moderate` — requires expanding the item list and confirming.
- `manual-only` — **volumes are novel data until proven otherwise.** Steward never
  offers bulk volume prune. Deleting a volume is per-volume, requires typing its name
  (GitHub-repo-delete style), and is logged to the daemon's audit log. A future
  refinement can downgrade a volume to `derivable` if a facet/compose file marks it
  `x-steward.derivable: true`.

`POST /api/docker/prune {actions:[ids], dryRun}` (v1) executes via the engine's native
prune endpoints (`/images/prune`, `/containers/prune`, `/build/prune`) and returns
actual reclaimed bytes. `dryRun:true` just re-returns the plan (the engine has no dry
run; we present our estimate and label it an estimate).

### 1.7 File layout (daemon)

```
src/docker/
  discover.ts        # socket probing, context parsing, version negotiation
  client.ts          # DockerClient (fetch-over-unix + hijack)
  stdcopy.ts         # frame demuxer
  events.ts          # /events subscription, reconnect, bus publishing
  snapshot.ts        # periodic + event-driven snapshot into SQLite
  compose.ts         # file parsing/normalization, merge with engine labels, ops
  prune.ts           # plan computation + execution
  routes.ts          # Hono routes under /api/docker
  ws.ts              # logs/exec/progress handlers for the shared WS
src/ui/pages/docker/
  ContainersPage.tsx ImagesPage.tsx VolumesPage.tsx ComposePage.tsx DiskPage.tsx
  ContainerDetail.tsx  # tabs: overview | logs (xterm) | exec (xterm) | inspect JSON
```

---

## Part 2 — Git Sync (v1)

### 2.1 Concept

Every node can hold **bare mirrors** of repos under `~/.steward/mirrors/`. A mirror is
a full clone of committed history — which makes it simultaneously (a) a GitHub-free
remote you can push/pull against from any node, and (b) a redundancy copy: a repo whose
committed data exists as mirrors on N healthy nodes has committed-data redundancy N+1.
(Dirty/untracked files are *not* covered by mirrors — the blob-store backup path owns
those; the repo UI must show both numbers, not blur them.)

### 2.2 Repo identity

Mirrors need an identity stable across path renames and across nodes. Rules:

1. On first index of a repo, the daemon reads `git config steward.repoid`. If absent,
   generate `r_<ulid>` and write it (`git config steward.repoid r_01J...`). This
   travels with clones? — no, git config doesn't clone. So additionally:
2. Match key for correlating clones that don't share config: `root_commits` = sorted
   SHAs of `git rev-list --max-parents=0 HEAD` (cheap, cached). Two repos with
   intersecting root commits and no `steward.repoid` conflict are offered as "same
   project" in the UI; the user confirms merge → both get the same repoid. Auto-merge
   only when root commits match exactly *and* origin URLs match.
3. Empty repos (no commits) get a repoid but can't be correlated; fine.

```sql
CREATE TABLE repo (
  repo_id      TEXT PRIMARY KEY,        -- r_<ulid>
  display_name TEXT NOT NULL,
  root_commits TEXT NOT NULL DEFAULT '[]',
  created_at   INTEGER NOT NULL
);

CREATE TABLE repo_checkout (             -- working copies, per node (indexer-owned)
  node_id TEXT NOT NULL, path TEXT NOT NULL, repo_id TEXT NOT NULL,
  head_ref TEXT, head_sha TEXT, dirty INTEGER, ahead INTEGER, behind INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (node_id, path)
);

CREATE TABLE repo_mirror (
  repo_id      TEXT NOT NULL,
  node_id      TEXT NOT NULL,           -- node hosting the mirror
  state        TEXT NOT NULL,           -- 'ready' | 'cloning' | 'error'
  last_sync_at INTEGER,
  last_sha_json TEXT,                   -- {"refs/heads/main":"abc...", ...} at last sync
  size_bytes   INTEGER,
  error        TEXT,
  PRIMARY KEY (repo_id, node_id)
);

CREATE TABLE repo_sync_policy (
  repo_id            TEXT PRIMARY KEY,
  auto_push          TEXT NOT NULL DEFAULT 'off',  -- 'off'|'on-commit'|'interval'|'manual'
  interval_minutes   INTEGER DEFAULT 60,
  replication_factor INTEGER NOT NULL DEFAULT 2,   -- desired mirror count
  pinned_nodes_json  TEXT NOT NULL DEFAULT '[]',   -- must-have mirror hosts
  push_refs          TEXT NOT NULL DEFAULT 'branches+tags'  -- or 'all' (incl. notes)
);
```

Mirror path on disk: `~/.steward/mirrors/<repo_id>.git` (bare,
`git init --bare` + fetch; a `steward.json` file inside stores
`{repoId, displayName}` for humans poking around).

### 2.3 Transport: git-over-steward-channel

Core trick: **each daemon exposes git smart-HTTP on localhost and proxies to peers
over the existing authenticated node channel.** Git itself never learns about node
auth; it just talks HTTP to the local daemon.

```
GET  /git/:nodeId/:repoId.git/info/refs?service=git-upload-pack|git-receive-pack
POST /git/:nodeId/:repoId.git/git-upload-pack
POST /git/:nodeId/:repoId.git/git-receive-pack
```

- Local daemon (`nodeId = self`): spawn
  `git http-backend` via CGI env (`GIT_PROJECT_ROOT=~/.steward/mirrors`,
  `GIT_HTTP_EXPORT_ALL=1`, `PATH_INFO=/<repoId>.git/...`), piping request body →
  stdin, stdout → response. `http-backend` handles both smart services and
  `http.receivepack` is enabled by setting `http.receivepack=true` in each mirror's
  config at creation (localhost-only server, node-channel auth in front — safe).
- Remote: forward the request over the node channel as a streamed
  request/response pair (channel already supports framed binary streams for backup
  blobs; git reuses that). Gzip encoding passes through untouched.

So from any checkout, a mirror remote is plain git:

```
git remote add steward http://127.0.0.1:4777/git/<nodeId>/<repoId>.git
```

The daemon writes this remote (named `steward`) into checkouts automatically when a
sync policy is enabled, and rewrites it if the hosting node changes. Because the URL
targets localhost, no credentials are ever stored in git config.

**SSH fallback (v2):** for peers reachable by ssh but not yet running Steward (or
during recovery), `git push ssh://user@host/~/.steward/mirrors/<repoId>.git` works
because mirrors are ordinary bare repos. Steward can generate the command; it does not
manage ssh keys in v1.

### 2.4 Sync algorithm & auto-push

Mirror updates are **push-based from a checkout node** (the node with the working copy
has the newest objects; pull-based mirroring would require mirrors to reach into
checkouts). Flow for a repo with policy enabled:

1. **Placement.** Ensure `replication_factor` mirrors exist: pinned nodes first, then
   rank remaining online nodes by free disk desc, preferring "backup-class" nodes
   (node metadata flag). Create missing mirrors: hosting node runs
   `git init --bare` + records `repo_mirror(state='cloning')`; first push populates it.
2. **Trigger.**
   - `on-commit`: the indexer's fs-watcher already watches `.git/HEAD` and
     `.git/refs/**`; on change, debounce 10s, then sync.
   - `interval`: timer per policy.
   - `manual`: UI button / `steward repo push`.
3. **Push.** For each target mirror, from the checkout:
   `git push --prune http://127.0.0.1:4777/git/<node>/<repoId>.git
   +refs/heads/*:refs/heads/* +refs/tags/*:refs/tags/*`
   (`push_refs='all'` adds `+refs/notes/*` and `+refs/replace/*`). Forced refspecs are
   correct here: the mirror is a *replica of this checkout*, not a collaboration
   point — history rewrites (rebases) must propagate. **Safety valve:** before
   pushing, fetch the mirror's ref advertisement (already in hand from `info/refs`);
   if the mirror has a branch whose tip is not an ancestor of ours and was updated by a
   *different* node since our `last_sha_json`, mark the repo `diverged` in the UI and
   require the user to pick a winner instead of silently clobbering. (Multi-checkout
   same-repo-on-two-nodes is real in this fleet — ~300 dirs with duplicated
   experiments.)
4. **Record.** Update `repo_mirror.last_sync_at/last_sha_json/size_bytes`
   (`du -sk` of the mirror, cached). Emit `repo.synced` on the bus → redundancy engine
   recomputes the repo's committed-data redundancy = 1 (checkout) + healthy mirrors +
   (1 if an external remote like GitHub is configured and `ahead == 0`).

Concurrency: per-`(repo, mirror)` mutex; pushes to different mirrors run in parallel
(max 3). Failures retry with backoff (1m, 5m, 30m, then hourly) and surface as a
yellow badge, never a modal.

### 2.5 Routes & CLI

```
GET  /api/repos/:repoId/mirrors             → repo_mirror rows + live ref comparison
POST /api/repos/:repoId/mirrors             {nodeId}        → create mirror
DELETE /api/repos/:repoId/mirrors/:nodeId                   → remove (refuses if it
                                                              would drop redundancy < 2
                                                              unless ?force=1)
PUT  /api/repos/:repoId/sync-policy         {autoPush, replicationFactor, ...}
POST /api/repos/:repoId/sync                → sync now (202; progress over WS topic
                                              'repo.sync')
```

CLI: `steward repo mirrors <path>`, `steward repo push <path>`,
`steward repo policy <path> --auto-push on-commit --replicas 2`.

New daemon code: `src/gitsync/{identity.ts, mirrors.ts, placement.ts, pusher.ts,
httpbackend.ts, routes.ts}`.

---

## Part 3 — CI (v2 — design now, build later)

### 3.1 Shape

GitHub-Actions-like, radically smaller. A repo opts in with `.steward/ci.yml`.
Workflows trigger on pushes **to the repo's mirrors** (git sync is the event source —
no webhooks needed: the receiving daemon's `post-receive` hook, installed into every
mirror at creation, POSTs `{repoId, refUpdates}` to `localhost:4777/internal/git-hook`).
Jobs run in Docker containers on nodes you select. Status lands per commit and shows in
Steward's repo/commit UI.

### 3.2 Workflow YAML

```yaml
# .steward/ci.yml
name: checks
on:
  push:
    branches: [main, "release/*"]
  manual: true                # run button in UI
  # cron: "0 3 * * *"         # later

jobs:
  test:
    runs-on:                  # node selector, all fields optional
      labels: [linux]         # node labels from fleet config
      node: any               # or explicit nodeId; 'any' = scheduler picks
    image: oven/bun:1.2       # required — jobs ALWAYS run in a container
    timeout-minutes: 30
    env:
      CI: "1"
    steps:
      - run: bun install --frozen-lockfile
      - run: bun test
  build:
    needs: [test]
    image: oven/bun:1.2
    steps:
      - run: bun run build
      - artifacts:            # globs, uploaded to hosting node's blob store
          paths: [dist/**]
          retention-days: 14
```

Deliberate omissions (v2 keeps them out): reusable workflows, matrices, third-party
"actions" marketplace, services containers, caching DSL (mount-based cache below
instead). Secrets integrate with the vault: `secrets.FOO` in `env` resolves from a
per-repo allowlist in the vault at job start, decrypted in-memory on the runner node
only.

### 3.3 Execution model

Roles:

- **Coordinator** = the mirror-hosting node that received the push (deterministic:
  lowest nodeId among mirrors hosting that repo, to dedupe when one push fans out to
  two mirrors — each hook fires, but only the coordinator creates the run; others
  verify a run exists for `(repoId, sha, workflow)` via fleet query and stand down).
- **Runner** = any node matching `runs-on` with a working Docker engine and the
  `ci-runner` capability enabled in its config (opt-in per node; a laptop shouldn't
  silently run CI).

Scheduling is lease-based over fleet state — no queue broker:

```sql
CREATE TABLE ci_run (
  run_id     TEXT PRIMARY KEY,          -- ci_<ulid>
  repo_id    TEXT NOT NULL, workflow TEXT NOT NULL,
  sha        TEXT NOT NULL, ref TEXT NOT NULL,
  trigger    TEXT NOT NULL,             -- 'push' | 'manual' | 'cron'
  status     TEXT NOT NULL,             -- queued|running|success|failure|cancelled|error
  created_at INTEGER NOT NULL, finished_at INTEGER
);

CREATE TABLE ci_job (
  run_id TEXT NOT NULL, job TEXT NOT NULL,
  status TEXT NOT NULL,                 -- queued|leased|running|success|failure|skipped|cancelled
  runner_node TEXT, lease_expires INTEGER,   -- runner heartbeats every 15s, lease 60s
  exit_code INTEGER, started_at INTEGER, finished_at INTEGER,
  PRIMARY KEY (run_id, job)
);

CREATE TABLE ci_log_chunk (
  run_id TEXT NOT NULL, job TEXT NOT NULL, seq INTEGER NOT NULL,
  step INTEGER NOT NULL, stream TEXT NOT NULL, data BLOB NOT NULL, ts INTEGER NOT NULL,
  PRIMARY KEY (run_id, job, seq)
);
```

Eligible runners poll the coordinator (over the node channel) for `queued` jobs whose
`needs` are satisfied, take a lease, and execute. Lease expiry → job back to `queued`
(max 2 retries, then `error`).

**Job execution on the runner:**

1. `git clone --depth 50 http://127.0.0.1:4777/git/<coordinator>/<repoId>.git` into a
   fresh workdir `~/.steward/ci/<runId>/<job>/src`, `git checkout <sha>`. Local git
   transport again — CI needs no credentials, ever.
2. Create container: image from YAML (pull if missing, progress into log), workdir
   bind-mounted at `/work`, `--workdir /work`, no other mounts. Cache: one named
   volume `steward-ci-cache-<repoId>-<job>` mounted at `/cache` with
   `STEWARD_CACHE=/cache` exported; tools can be pointed at it. Network on;
   resource caps `--memory 8g --cpus 4` (node-config overridable).
3. Steps run sequentially as `docker exec` invocations of
   `/bin/sh -euc '<script>'` in the one container (state persists between steps,
   like Actions). Output → stdcopy demux → `ci_log_chunk` (append, seq monotonic,
   chunks coalesced to ≥4KB or 500ms) → also published on WS topic `ci.log` for live
   viewers. Nonzero exit stops the job (`failure`).
4. Artifacts: matched files tarred and stored via the existing content-addressed blob
   store; `ci_artifact(run_id, job, path, blob_hash, size)` table on the coordinator.
5. Teardown: container rm -f, workdir deleted; cache volume persists. Timeout →
   `docker kill`, status `failure` with `timed_out: true` noted in final log line.

**Status per commit:** coordinator writes
`ci_status(repo_id, sha, workflow, status, run_id)`; the repo UI's commit list and the
git panel decorate commits (green check / red x / amber dot), clicking through to the
run page with per-job live logs (same xterm/log components as Docker logs — shared
`LogView` UI component, one implementation).

Routes: `GET /api/ci/runs?repo=`, `GET /api/ci/runs/:id`,
`POST /api/ci/runs {repoId, workflow, ref}` (manual), `POST /api/ci/runs/:id/cancel`,
`GET /api/ci/runs/:id/artifacts/:path`. WS topics `ci.run` (status deltas), `ci.log`.

Code layout when built: `src/ci/{yaml.ts, coordinator.ts, scheduler.ts, runner.ts,
artifacts.ts, routes.ts}`; hook script templated in `src/gitsync/hooks/post-receive`.

### 3.4 What stays out until it hurts

Cross-node artifact fetch UI (artifacts live on the coordinator; download proxies
through it), cron triggers, matrices, macOS-native (non-Docker) jobs, concurrent-run
cancellation groups. Each has an obvious slot in this design; none blocks v2 shipping.

---

## Build order

1. **v0 (Docker local):** `discover.ts` → `client.ts`+`stdcopy.ts` → routes (read-only)
   → logs/exec WS → snapshot+events → compose read-only → df/prune plan. UI pages.
2. **v1 (fleet + git sync):** request forwarding over node channel → compose ops →
   prune execution → repo identity → mirrors + smart-HTTP proxy → auto-push +
   divergence guard → redundancy integration.
3. **v2 (CI + ssh fallback):** post-receive hooks → run/job schema + coordinator →
   runner + log pipeline → commit status UI → artifacts → secrets integration.
