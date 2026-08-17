# Steward — Roadmap

Milestone plan from empty repo to the full BRIEF. Each milestone is shippable on its own,
runs on Eric's real fleet, and ends with a concrete acceptance test. Design references
are in [OVERVIEW.md](OVERVIEW.md); nothing here invents new design — it sequences the
existing docs.

Ordering rationale: M0 proves the spine (install → daemon → index → UI) on one machine;
M1 makes it a fleet, because everything after (redundancy, vault sync, remote docker,
mirrors) rides the peer channel; M2 delivers the core product promise (nothing exists in
only one place); M3–M7 layer on independent capabilities roughly by
value-per-implementation-cost.

---

## M0 — Walking skeleton

**Goal:** one machine, end to end: one-line install, supervised self-updating daemon,
web UI shell, real indexing of `~/Code` with git awareness, and a dashboard that says
something true.

**Deliverables**

1. Repo scaffold per ARCHITECTURE §2: single `package.json`, `src/daemon/main.ts` boot
   sequence (lock, config, migrations, server), `src/core/` (db, bus, config, log, ids,
   errors), `migrations/0001_init.sql` with the canonical schema (ARCHITECTURE §4.2).
2. `install.sh` (INSTALL §3): bash-3.2, main-on-last-line, flags `--headless --port
   --channel --repo --no-start --uninstall`; bun resolution + `STEWARD_BUN` pinning in
   `~/.steward/env`; clone → `checkouts/<sha>` worktree → build → selfcheck → `current`
   symlink swap; launchd plist + systemd user unit running `bin/steward-daemon-shim`;
   port-conflict probe against `/api/system/health`; idempotent re-run as the repair path.
3. `steward` CLI shim + `src/cli/main.ts`: `status`, `start`, `stop`, `restart`
   (exit-64 contract), `logs`, `version`, `update` (re-run installer), `open`.
4. Self-update job (ARCHITECTURE §9): stage worktree, offline smoke test, symlink swap,
   120s probation, shim crash-counter rollback, sha blocklist.
5. Job system (ARCHITECTURE §5): jobs table queue, claim via `UPDATE…RETURNING`, dedupe
   keys, concurrency groups, checkpoints, `interrupted` requeue on boot.
6. Indexer v1 (INDEXING §2, §5): scan job over `~/Code` (sorted-DFS, cursor resume),
   hard-prune list crediting `derivable_bytes`, classifier with builtin `class_rules`
   seed, `repo_audit` job (status/stash/ahead/remote → `risk`), `dir_stats` aggregation.
   Stat-pass incremental rescans; watcher + dirhash tiers may slip to M2.
7. Event bus + `/api/ws` (ARCHITECTURE §6.3, §7): persisted events, seq replay,
   `X-Steward-Seq` on REST responses.
8. API subset: `system/*`, `config`, `roots`, `scans`, `repos` (read + audit), `files`,
   `files/tree`, `jobs`, `events`. Browser auth: token → ticket → session cookie +
   Host/Origin/CSRF middleware (SECURITY §4).
9. UI shell (UX §2–§5, §8): tokens, nav rail, TopBar, DataTable/Badge/StatusDot
   primitives, `/dev/states` route; **Fleet dashboard** (verdict hero, at-risk table,
   single node card, activity feed), **Repos board** (read-only glyph clusters), **Files
   browser** (list view), **Steward self view** (version, update button, log tail).
   Live-updating over WS, skeleton/empty/error states.
10. macOS FDA detection + banner + `steward setup` TCC walkthrough (INSTALL §8).

**Acceptance test:** On a fresh macOS machine, Eric runs the curl one-liner; within two
minutes a browser opens showing the Fleet dashboard. After the first scan completes he
can see every repo under `~/Code` ranked by risk — dirty, unpushed, and remote-less repos
flagged with true counts — browse files with novel/derivable classification and a
reclaimable-junk byte total, watch a live rescan stream into the UI without refreshing,
run `steward update` and watch the daemon swap versions and come back healthy, and
`kill -9` the daemon to see launchd restart it with all interrupted jobs resumed.

---

## M1 — Fleet: pairing + remote browse

**Goal:** two-plus nodes that discover, trust, and administer each other; every later
feature inherits the channel.

**Deliverables**

1. Node identity (FLEET §2): ed25519 keypair at `~/.steward/identity/`, `stw1…` nodeId,
   perm checks.
2. Mesh listener on 4778 + Noise-XX handshake + secretstream framing + channels
   (FLEET §4), heartbeat/reconnect, mDNS discovery, deterministic dialing.
3. Pairing flows (FLEET §3): URL/QR offer + 6-digit code with transcript-bound MAC;
   roster import; revocation tombstones; `steward pair`, UI pairing dialog.
4. RPC frames + method registry (FLEET §5), `dst` routing, `/api/nodes/:id/proxy/*`
   forwarding; 1-hop relay.
5. Gossip: signed peer records, digest anti-entropy, fleet KV with HLC-LWW (FLEET §7–8).
6. UI: node cards for all nodes (offline = cooled, lastSeen tiers), node scope pill,
   remote Files/Repos browsing through the proxy, pairing/revoke flows, activity feed
   entries for node events.

**Acceptance test:** Eric pairs his laptop with the backup tower by typing a 6-digit
code, sees both nodes on the dashboard from either machine, browses the tower's
`~/Code` and repo risk list from the laptop's UI, unplugs the tower's network and sees
its card cool to "last seen 2m ago" (with cached data still browsable), reconnects and
watches it converge — and revoking a test node locks it out of the mesh permanently.

---

## M2 — Backup, redundancy & the git client

**Goal:** the core promise: every novel dataset has a redundancy score, anything at ×1
can be fixed in one click, and the fix-it tools (backup + full git client) live in the UI.

**Deliverables**

1. Blob store (ARCHITECTURE §4.3): sha256 CAS, FastCDC chunking, snapshot manifests,
   verify + GC jobs; blob channel replication to chosen nodes; backup policies in config.
2. Datasets (INDEXING §3): boundary derivation, rollups, fingerprints; dataset manifest
   gossip (`fleet_datasets`); redundancy scoring with `score_reasons`, weakest-component
   rule, remote-liveness cache (`git ls-remote` ≤7 days).
3. Watcher (FSEvents/inotify) + dirhash skip tier + lazy hash sweep — warm rescans in
   seconds.
4. Full git client (UX §7): Changes tab with hunk/line staging, commit box, push/pull
   as streamed jobs, History graph, Branches tab, raw git console strip; the git mutation
   API routes (ARCHITECTURE §6.2).
5. Data view + junk reclaim (UX §6): dataset table with RedundancyBadge, classification
   drawer, duplicate/project grouping with dedupe verdicts (INDEXING §8), reclaim job
   (trash, novel-refusing re-check).
6. Fleet dashboard upgraded to real riskScore ranking with inline actions (Back up now /
   Push) and the `/api/redundancy/summary` histogram.

**Acceptance test:** Eric opens Data, filters to ×1 copies, clicks "Back up now" on his
largest remote-less project and watches it replicate to the tower and turn ×2; commits
and pushes a dirty repo entirely from the browser (staging individual hunks); accepts a
duplicate-group suggestion and reclaims 40+ GB of `node_modules` and stale clones to the
Trash — with dirty-repo members correctly excluded — and the dashboard verdict drops
from "17 things need attention" toward zero, each remaining item explaining its reason.

---

## M3 — Vault

**Goal:** passwords/keys/notes on every node, decryptable on none of them.

**Deliverables**

1. Vault schema + ciphertext routes (SECURITY §5.2/§5.4), header + version vectors,
   409-merge protocol.
2. Browser crypto worker: argon2id unlock, key hierarchy, memzero lock, auto-lock
   (SECURITY §5.5–5.6); create-vault and rotate-password flows (§7).
3. Sync over the peer channel: digest/want/rows anti-entropy, conflict-copy items,
   tombstone purge (SECURITY §6); rotation gated on max key_generation.
4. Vault UI (UX §10): unlock card, item list/detail, secret reveal + 30s clipboard
   clear, TOTP ring, generator (rejection-sampled chars + diceware, real entropy bits).
5. ⌘K integration (titles only while locked) and TopBar lock state.

**Acceptance test:** Eric creates the vault on his laptop, adds a login with a TOTP
secret, unlocks the same vault on the tower's UI via master password and copies the live
TOTP code there; edits the same item on both machines while the tower is offline and,
after reconnect, finds both versions preserved (one as a "(conflict from …)" item, no
silent loss); confirms `sqlite3 steward.db` on any node shows only ciphertext — titles
included — and that lock wipes the UI instantly.

---

## M4 — Convergence facets

**Goal:** `steward setup` makes a fresh machine his machine; drift stays visible forever
after.

**Deliverables**

1. Facet framework (CONVERGENCE §2, §4): types, runner subprocess with NDJSON protocol,
   brokered vault socket, structural differ, overlay merge, toposorted serial apply with
   recapture verify.
2. Profile repo: `steward profile init` bootstrap (brew leaves, curated defaults,
   dotfile allowlist move+symlink, ssh keys → vault), machines.json, profile sync.
3. Builtin facet library tier 1: homebrew, dotfiles, git-config, macos-defaults,
   ssh-keys, runtime-versions, vscode, apt-packages (CONVERGENCE §10); remainder follows.
4. Drift loop: scheduled recapture, `facet_state`/`facet_drift`/`facet_runs`, drift
   gossip → fleet badge; sudo honesty (`--pending` terminal bundle) and the manual
   checklist.
5. Setup UI (UX §11): facets × machines matrix, DriftDrawer with **Apply / Adopt /
   Ignore**, per-machine checklist with live converge log; CLI `steward plan|apply|
   capture|adopt|drift`.

**Acceptance test:** Eric runs `steward profile init` on his configured laptop and gets a
committed profile repo capturing his brew leaves, dotfiles, and key macOS defaults; on a
factory-fresh Mac he runs the installer + `steward setup`, and in one sitting (one sudo
prompt, one master password, a short manual checklist) the machine has his packages,
dotfiles, git config, and SSH keys; a week later he `brew install`s something by hand and
the Setup matrix shows the drift, which he **Adopts** into the profile from the UI.

---

## M5 — Docker

**Goal:** see and control every container on every node; prune safely.

**Deliverables**

1. Engine discovery + `DockerClient` over unix socket, API pinning (DOCKER-CI §1.1).
2. Live container/image/volume/network routes, snapshot tables + `/events`-driven
   refresh for fleet overview and offline nodes (§1.2–1.3).
3. Logs + exec over `/api/ws` stream frames with stdcopy demux and xterm.js UI;
   remote streaming over the peer channel with bounded queues (§1.4).
4. Compose detection (indexer files ⋈ engine labels, orphaned as first-class) and v1
   compose up/down/restart via CLI shell-out (§1.5).
5. Disk usage + prune plan with risk tiers; prune execution with typed-name per-volume
   deletion only (§1.6). Docker UI pages (UX §9).

**Acceptance test:** Eric opens Docker with "All nodes" scope and sees every container on
laptop and tower with live state; tails a server container's logs and opens a shell into
it from his laptop; brings a compose project up and down from its card; runs the prune
plan accepting the "safe" tier to reclaim dangling images — while verifying Steward
never offers bulk volume deletion and an unused volume requires typing its name.

---

## M6 — Git mirror sync

**Goal:** GitHub-optional: committed history replicates node-to-node and counts toward
redundancy.

**Deliverables**

1. Repo identity (`steward.repoid` + root-commit correlation, DOCKER-CI §2.2) and the
   `repo_identity`/`repo_mirror`/`repo_sync_policy` tables.
2. Bare mirrors under `~/.steward/mirrors/`; git smart-HTTP at
   `/git/:nodeId/:repoId.git` via `git http-backend`, proxied to peers over the node
   channel; auto-written `steward` remote in checkouts (§2.3).
3. Auto-push policies (off/on-commit/interval/manual), replication-factor placement,
   forced-refspec push with the multi-checkout divergence guard (§2.4).
4. Mirror health in the redundancy score (committed-data vs dirty-file numbers kept
   distinct) and mirror management UI + `steward repo` CLI (§2.5).

**Acceptance test:** Eric enables on-commit sync for a remote-less repo with replication
factor 2; within a minute of committing, the history exists as mirrors on two other
nodes and the repo's committed-data redundancy shows ×3 — then he deletes the working
copy, runs `git clone http://127.0.0.1:4777/git/<tower>/<repoId>.git`, and gets his full
history back with no GitHub and no credentials anywhere.

---

## M7 — CI

**Goal:** push → tests ran somewhere on the fleet → commit gets a green check.

**Deliverables**

1. `.steward/ci.yml` parsing (jobs, needs, image, steps, artifacts — deliberately no
   matrices/marketplace, DOCKER-CI §3.2).
2. Trigger pipeline: post-receive hooks in mirrors → deterministic coordinator (lowest
   mirror-hosting nodeId) → `ci_run`/`ci_job` rows (§3.3).
3. Lease-based runner scheduling on opt-in `ci-runner` nodes; one container per job,
   steps as `docker exec`, credential-free clone from the local mirror URL, cache
   volume, timeouts.
4. Log pipeline (`ci_log_chunk` + live `ci.log` WS topic), artifacts into the blob
   store, per-commit `ci_status` decorating the repo UI's History tab; manual run button
   and cancel.

**Acceptance test:** Eric adds a two-job workflow (test → build with artifacts) to a
mirrored repo; on his next push the tower picks the jobs up, the run page streams both
logs live from his laptop's UI, the History tab shows a green check on that commit (red
when he pushes a failing test), and he downloads the built `dist/` artifact from the run
page — with `git log` proving CI never needed a token or secret.

---

## After M7

Deferred by design, slots already reserved: multi-hop relay, per-method ACLs /
multi-user, SSH git fallback, CI cron + macOS-native jobs, compiled daemon binary as the
narrow TCC grant target, NAT traversal beyond tailscale. See each doc's "open questions"
section.
