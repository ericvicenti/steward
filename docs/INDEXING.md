# Steward — Content Indexing & Redundancy Scoring

Status: design, implementation-ready.
Scope: the indexer subsystem of the Steward daemon (Bun process). Everything here runs
inside the daemon; the UI and other nodes consume its output via the HTTP API and the
node-to-node channel described in BRIEF.md.

The indexer answers three questions, continuously and cheaply:

1. **What data exists on this node?** (filesystem scanner → `entries`, `datasets`)
2. **Which of it is novel vs derivable?** (classifier rule engine → `classification`)
3. **How many independent copies of each novel dataset exist across the fleet?**
   (redundancy model → `dataset_locations`, `redundancy score 0–3+`)

---

## 1. Terminology

| Term | Meaning |
|---|---|
| **Entry** | A single file or directory row in the index. We do *not* index every file on disk — see pruning rules. |
| **Dataset** | The unit of redundancy accounting. A directory subtree (or single large file) that is treated as one logical thing: a git repo, a project dir, a photo library, `~/Documents/Taxes`. Datasets never nest for scoring purposes (a repo inside `~/Code` is its own dataset; the residue of `~/Code` outside any repo is another). |
| **Novel** | Data that cannot be regenerated or re-fetched. Losing the last copy = permanent loss. |
| **Derivable** | Data reproducible from novel data + the network: `node_modules`, build output, caches, pushed git objects, re-downloadable artifacts. |
| **Location** | A (node, path, kind) triple where a copy of a dataset lives. Kinds: `live` (working tree/dir), `blob` (Steward blob-store snapshot), `remote` (external, e.g. GitHub). |
| **Copy** | A location that would survive the loss of every other location. Precise rules in §7. |
| **Project** | A UI-level grouping of related datasets (the ~300 `~/Code` dirs collapse into far fewer projects). Grouping rules in §8. |

---

## 2. Filesystem scanner

### 2.1 Roots

Scan roots are user-configured rows in `scan_roots`, seeded on first run per-OS:

macOS defaults: `~/Code`, `~/Documents`, `~/Desktop`, `~/Downloads`, `~/Pictures`,
`~/Movies`, `~/Music`, `~/.ssh` (metadata only, never blobbed unencrypted), `~/.steward` excluded.
Linux defaults: `~/` minus the exclusion list below, plus any user additions like `/srv`, `/data`.

Each root has a `policy`: `deep` (default — full recursion), `shallow` (index only
top-level children as opaque size buckets; used for `~/Library`-style noise if the user
adds it), or `metadata` (sizes only, contents never hashed or backed up — `~/.ssh`).

### 2.2 Hard ignore rules (never descend, never count)

These are pruned at walk time — they don't even become entries, only an aggregate
`derivable_bytes` credit on the parent dataset:

- Name matches: `node_modules`, `.pnpm-store`, `.yarn/cache`, `.turbo`, `.next`, `.nuxt`,
  `.output`, `dist`, `build`, `out`, `target` (only when a `Cargo.toml`/`pom.xml`/`build.gradle*`
  sibling exists), `.venv`, `venv`, `__pycache__`, `.pytest_cache`, `.mypy_cache`,
  `.gradle`, `.cache`, `coverage`, `.nyc_output`, `DerivedData`, `Pods`, `.expo`,
  `.parcel-cache`, `.vite`, `.svelte-kit`, `.angular`, `.dart_tool`, `bower_components`,
  `.terraform`, `vendor/bundle`, `.tox`, `.eggs`, `*.egg-info`.
- `.git/objects`, `.git/lfs` are size-sampled (via `du`-style stat walk once per scan,
  cached) but their individual objects are never entries — git intelligence (§5) decides
  whether they're novel.
- Anything matched by that dataset's *effective* `.gitignore` **when inside a git repo**
  is classified derivable-by-default (rule `gitignored`, confidence overridable) but IS
  walked, because gitignored files are frequently novel (`.env`, local databases). The
  hard-prune list above wins even over that.
- macOS: `.Trash`, `Library/Caches`, `.DS_Store`, `Icon\r`. Linux: `~/.cache`, `lost+found`.

Users extend all of this via the `class_rules` table (§4); the hard-prune list is just
rules with `action='prune'` and `builtin=1`.

### 2.3 What becomes an entry

To keep the DB small (target: <500k rows for Eric's fleet), we index:

- Every **directory** down to the pruning frontier.
- **Files ≥ 1 MiB** individually.
- Files < 1 MiB are rolled up into their parent directory's `small_files_count` /
  `small_files_bytes` and covered by the parent's **dirhash** (below), so change
  detection and backup still see them; they just don't get rows.
- Exception: inside a dataset root's top two levels, all files get rows regardless of
  size (so the UI can show a meaningful tree for any project).

### 2.4 Incremental rescans: mtime+size, dirhash, and the frontier

Full-content hashing of terabytes is off the table. The scanner uses three tiers:

1. **stat pass** (cheap, every scan): for each entry compare `(mtime_ns, size, inode)`
   against the stored row. Unchanged file ⇒ skip. Unchanged directory mtime does *not*
   prove the subtree is unchanged (mtime only reflects direct children), so directories
   are always descended unless tier 2 says otherwise.
2. **dirhash** (change certificate for subtrees): every directory entry stores
   `dirhash = blake3(sorted list of (childName, type, size, mtime_ns, child.dirhash?))`.
   Computed bottom-up during the walk. If a directory's recomputed shallow fingerprint
   — `(own mtime, child count from a single `readdir`)` — matches AND we're in a
   `watch`-confirmed window (FS events have been flowing and none touched this subtree
   since last scan), we trust the stored dirhash and skip descent. Cold scans (post-boot,
   watcher gap) always descend fully; the stat pass makes that ~O(#dirs) syscalls, which
   on an SSD with 500k entries is 10–30 s.
3. **content hash** (`blake3`, chunked): computed lazily, only for (a) files being
   snapshotted to the blob store, (b) duplicate-detection candidates (same size, both
   ≥ 8 MiB), (c) dataset-level dedupe comparisons (§8). Stored in `entries.blake3`,
   nullable.

Scan cadence: full stat-walk of all roots every 6 h (`scan_jobs` cron), plus event-driven
partial scans (below), plus on-demand via API.

### 2.5 Watching: FSEvents / inotify

- **macOS:** spawn a long-lived helper using the FSEvents CLI shim we ship
  (`steward-fswatch`, a ~100-line Swift or `fswatch`-vendored binary) subscribed to each
  root; it emits changed *directory paths* (FSEvents granularity) on stdout as
  NDJSON. Bun reads the stream.
- **Linux:** inotify via Bun FFI (`inotify_init1`/`inotify_add_watch`), recursive-watch
  managed in TS with a watch-descriptor→path map. Cap at `fs.inotify.max_user_watches`;
  if roots exceed the cap, degrade that root to polling (stat-walk every 15 min) and
  surface a UI warning suggesting the sysctl bump.
- Events are **coalesced** into a debounced dirty-set: `Map<path, firstSeenAt>` flushed
  when a path has been quiet for 5 s or dirty for 60 s. Flush enqueues a `partial` scan
  job rooted at each dirty path (deduped by prefix — if `/a` and `/a/b` are both dirty,
  scan `/a` once).
- Watcher restarts, event-queue overflows (inotify `IN_Q_OVERFLOW`, FSEvents
  `kFSEventStreamEventFlagMustScanSubDirs`) mark the whole root cold ⇒ next scan is a
  full descent for that root.

### 2.6 Scan job algorithm

Jobs live in `scan_jobs` (queue table). One scan runs at a time per node (single worker;
IO-bound, and SQLite likes one writer). Pseudocode:

```
runScan(job):                      # job = {root_path, mode: full|partial|cold}
  gen = job.id                     # generation stamp
  stack = [root_path]
  while stack:
    dir = stack.pop()
    rule = classify(dir)           # §4 rule engine, longest-match
    if rule.action == 'prune':
        creditDerivableBytes(dir)  # fast stat-walk w/ 1h cache keyed on (path, mtime)
        markSeen(dir, gen); continue
    children = readdir(dir)        # one syscall batch
    if mode != 'cold' and shallowFingerprintUnchanged(dir, children)
       and watcherCovered(dir):
        markSubtreeSeen(dir, gen); continue     # single UPDATE by path prefix
    for c in children:
        st = lstat(c)
        if isGitRepoRoot(c): enqueueGitJob(c)   # §5, async, separate queue
        upsertEntry(c, st, gen)    # only if changed → touch datasets.dirty
        if st.isDir and not classify(c).prune: stack.push(c)
    recomputeDirhash(dir)
  # deletions: anything under root_path with last_seen_gen < gen, for full/cold scans
  DELETE FROM entries WHERE path GLOB root||'/*' AND last_seen_gen < gen  (full/cold only)
  refreshDatasets(root_path)       # §3: dataset boundaries, rollup sizes
  recomputeRedundancy(dirtyDatasets)
```

All writes go through a batched transaction (commit every 2000 upserts). A scan is
resumable: `scan_jobs.cursor` stores the last committed directory; crash ⇒ resume from
cursor with the same generation.

---

## 3. Datasets: the unit that gets a redundancy score

Dataset boundaries are derived, not hand-drawn:

1. Every **git repo root** is a dataset (`kind='git'`). Nested repos/submodules are
   separate datasets; the parent's rollup excludes them.
2. Every **top-level child of a scan root** that is not inside a git repo is a dataset
   (`kind='dir'`) — e.g. `~/Documents/Taxes`, `~/Pictures/Photos Library.photoslibrary`.
3. Loose files directly in a scan root form a per-root `kind='loose'` dataset
   (`~/Desktop (loose files)`).
4. Single files ≥ 2 GiB become their own dataset (`kind='file'`) so a giant disk image
   isn't invisibly lumped with siblings.
5. Users can split/merge via `dataset_overrides` (path → force-boundary | force-merge).

Each dataset stores rollups maintained by `refreshDatasets`: `total_bytes`,
`novel_bytes`, `derivable_bytes`, `file_count`, `newest_mtime`, `content_fingerprint`
(dirhash of the root, minus pruned dirs), and for git datasets a pointer into `git_repos`.

---

## 4. Novel vs derivable: the classifier

A single ordered rule engine used both at walk time (prune) and at rollup time
(byte attribution). Rules live in `class_rules`; built-ins ship as seed rows so the user
can disable/override any of them in the UI (a user rule with higher `priority` wins).

Matching: rules are evaluated against each entry with **highest priority first,
first match wins**. `match_kind` ∈ `name` (basename glob), `path` (absolute glob),
`sibling` (basename glob + required sibling file, e.g. `target` + `Cargo.toml`),
`gitignored`, `mime`, `ext`.

### 4.1 Built-in rule table (seed data — the contract)

| Pri | Match | Class | Action | Rationale / recovery path |
|---|---|---|---|---|
| 900 | name `.env`, `.env.*`, `*.pem`, `*.key`, `id_*` (ssh) | **novel-secret** | index, never blob w/o vault encryption | Secrets are maximally novel |
| 890 | name `*.sqlite`, `*.db`, `*.sqlite3` outside cache dirs | **novel** | index | Local databases are usually irreplaceable |
| 800 | name in hard-prune list (§2.2): `node_modules`, `dist`, `.next`, … | **derivable** | prune | `bun install` / rebuild |
| 790 | sibling `target` + `Cargo.toml`; `build` + (`CMakeLists.txt`\|`gradle`) | **derivable** | prune | Rebuild |
| 700 | path `~/Library/Caches/**`, `~/.cache/**`, `**/.cache` | **derivable** | prune | Cache |
| 650 | `.git/objects` where §5 says all reachable commits exist on a remote | **derivable-remote** | keep, count derivable | `git clone` re-fetches |
| 640 | `.git/objects` otherwise | **novel** | keep | Unpushed history |
| 600 | path `~/Downloads/**` + ext `.dmg .pkg .iso .zip .tar.* .whl .jar .apk .ipa .exe .msi .deb .rpm .safetensors .gguf .ckpt` | **derivable-refetch** | index, low priority | Re-downloadable; record `where_from` xattr (`com.apple.metadata:kMDItemWhereFroms`) as provenance |
| 590 | path `~/Downloads/**` other | **novel-suspect** | index | Downloads also hold novel exports; default novel, surfaced for triage |
| 500 | `gitignored` (inside a repo, matches effective gitignore) | **derivable** | index, count derivable | Usually build/cache; the 900-band secret rules already outranked this |
| 400 | ext `.o .obj .pyc .class .rlib .a .so.tmp .swp .tmp` | **derivable** | index | Build intermediates |
| 300 | name `Photos Library.photoslibrary`, `*.photoslibrary` | **novel** (whole bundle = one dataset) | index shallow | Irreplaceable |
| 100 | `*` | **novel** | index | Default: unknown data is novel |

`derivable-remote` and `derivable-refetch` are sub-classes of derivable that keep a
**provenance** string (remote URL / download URL) so the UI can say "safe to delete,
re-fetch from X". User-added rules are just rows: e.g. Eric adds
`(pri 810, path ~/Code/**/*.safetensors, derivable-refetch)` once and every model file
across 300 projects reclassifies on next scan.

### 4.2 npm / monorepo junk quantification

Reclaimable bytes are first-class, not an afterthought:

- Every pruned dir contributes to its dataset's `derivable_bytes` and to a per-rule
  breakdown table `derivable_breakdown(dataset_id, rule_id, bytes, dir_count)`.
- The fleet dashboard query "reclaimable now" =
  `SUM(bytes) FROM derivable_breakdown WHERE rule_id IN (prune rules)` grouped by rule ⇒
  "node_modules: 41.2 GB across 212 dirs · rust target/: 18 GB · .next: 3.1 GB".
- Monorepo awareness: a `node_modules` whose parent has `pnpm-workspace.yaml` /
  `workspaces` in `package.json` is tagged `monorepo-root`; nested workspace
  `node_modules` are counted under the same project so the UI shows one number per
  project, not 30.
- One-click reclaim: API `POST /api/reclaim` takes `{rule_id | dataset_id, dry_run}` and
  deletes matched pruned dirs (never anything classified novel), logging to `reclaim_log`.

---

## 5. Git repo intelligence

Detected during scans (`isGitRepoRoot` = has `.git` dir or file). Each repo gets an
async `git_jobs` inspection (separate single-worker queue, shells out to system `git`,
per BRIEF). Per repo we run, with `-C repo` and `--no-optional-locks`:

```
git rev-parse --git-dir --is-bare-repository
git remote -v
git status --porcelain=v2 --branch -z        # dirty, untracked, ahead/behind
git stash list --format=%gd|%at|%s
git for-each-ref --format='%(refname)|%(objectname)|%(upstream)|%(upstream:track)'
git rev-list --max-parents=0 --all --max-count=4   # root commit(s) → repo identity
git log -1 --format=%ct --all
git count-objects -v                          # size-pack for object-store bytes
```

Derived fields stored in `git_repos` (schema §9):

- `dirty` (staged/unstaged changes), `untracked_count`, `untracked_bytes` (from index,
  excluding gitignored), `stash_count` (each stash is novel!), `ahead_total` (sum of
  ahead counts across branches with upstreams), `branches_no_upstream` (local branches
  whose tips aren't reachable from any remote-tracking ref — checked with
  `git rev-list <tip> --not --remotes --max-count=1`), `remoteless` (no remotes at all),
  `last_commit_at`, `head_ref`.
- **Novelty verdict for the object store:** `objects_novel = remoteless OR ahead_total>0
  OR branches_no_upstream>0 OR stash_count>0`. If false, `.git/objects` bytes flip to
  `derivable-remote` (rule 650) with provenance = fetch URL.
- **Working-tree novelty is independent:** dirty files, untracked files, and gitignored
  novel files (`.env`, local DBs) keep the *dataset* novel even when objects are pushed.
  A fully clean, fully pushed repo's dataset has `novel_bytes ≈ untracked-novel bytes ≈ 0`
  and the UI can mark it "safe to delete locally".
- **Repo identity** for cross-fleet matching: `identity = sha1(sorted root-commit ids)`.
  Two clones of the same project share identity even with different remote URLs (fork,
  moved to a new GitHub org). `remote_urls` (normalized: strip scheme, credentials,
  trailing `.git`, lowercase host) are secondary keys.
- **Remote liveness** is *not* assumed: `git ls-remote --heads <remote>` runs at most
  daily per unique remote URL (fleet-wide, coordinated via the sync layer), cached in
  `git_remotes(url, last_ok_at, head_sample)`. A remote counts toward redundancy (§7)
  only if verified within 7 days AND the specific tips we're counting on are present in
  the `ls-remote` output or reachable from an advertised head we've fetched. If liveness
  is stale, the remote copy degrades to "unverified" and the score shows a ⚠ instead of
  silently counting.

---

## 6. Fleet metadata sync

Redundancy is a fleet-global computation. Each node publishes a compact **manifest** of
its datasets over the authenticated node channel (WebSocket, per BRIEF): rows of
`(dataset_id_global, node_id, path, kind, content_fingerprint, git_identity,
git_state_hash, novel_bytes, updated_at)`. `dataset_id_global` for git datasets is the
repo `identity`; for non-git datasets it's `blake3(root-relative path within a named
root)` — so `~/Documents/Taxes` matches across machines by role-path, with
`content_fingerprint` deciding whether the copies are *current*. Manifests are
last-writer-wins per (node, dataset) row, gossiped on connect and on change (debounced
30 s). Every node stores the full fleet manifest in `fleet_datasets` and can therefore
compute every score locally — no coordinator.

---

## 7. The redundancy model

**Score = number of independent, verified, current-enough copies of the novel portion
of a dataset.** Integer 0–3+, computed per dataset, rolled up to project / node / fleet.

What counts as a copy (each +1, max one per node per kind):

| Copy kind | Counts when |
|---|---|
| `live` on another node | Fleet manifest shows the dataset on node B with a `content_fingerprint` match, OR (git) same `identity` and B's repo contains all of A's novel commits (B's tips ⊇ A's tips, checked via manifest `git_state_hash` = hash of sorted `(ref,tip)` pairs; mismatch ⇒ counts as **stale copy**, worth +0 but shown in UI as "copy exists, 12 days behind") |
| `blob` snapshot | A completed Steward blob-store snapshot of the dataset exists on some node, `snapshot.fingerprint == current fingerprint` ⇒ current; else stale (+0, surfaced). Snapshots on the *same* node as the live data count +0 (same-disk death), unless on a distinct physical volume (APFS container / mount device id differs) ⇒ +1 with an "same-machine" annotation. |
| `remote` | Git only. `objects_novel == false` component: the pushed history counts as +1 copy *of the history*, verified per §5 liveness. It does NOT cover dirty/untracked/stash novelty — score is computed on the **weakest component**: `score(dataset) = min(score(history), score(worktree-novel))` for repos with any worktree novelty. |

Scoring semantics (what the UI paints):

- **0 — red:** this is the only copy anywhere. (Also: score of a *component* is 0, e.g.
  pushed repo but a stash exists nowhere else ⇒ dataset shows 0 with reason "stash not
  backed up".)
- **1 — amber:** exactly one other copy. Survives one disk loss.
- **2 — green:** target default. `redundancy_target` is per-dataset-overridable
  (secrets/photos default 3).
- **3+ — deep green.**

`recomputeRedundancy(datasets)` is a pure function over `fleet_datasets` +
`snapshots` + `git_remotes`, runs after every scan and every manifest update, writes
`datasets.score`, `datasets.score_reasons` (JSON array of human strings — every score
must be explainable: `["live copy on mini (current)", "GitHub origin verified 3h ago",
"stash@{0} exists only here"]`).

---

## 8. Projects: taming ~300 dirs in `~/Code`

Grouping is deterministic and cheap, then human-curated:

1. **Same git identity** ⇒ same project. This alone collapses `Seed`, `Seed2`,
   `Seed-worktrees/*`, `SeedCo` clones into one "Seed" project if they share root
   commits. Git worktrees (`.git` file pointing at a common gitdir) trivially join.
2. **Shared normalized remote URL** ⇒ same project (catches re-inits with a fresh root
   commit pushed to the same repo).
3. **Name-stem clustering** for the remainder: normalize dir name (lowercase, strip
   `-copy`, `copy \d`, `-old`, `-legacy`, `-test\d*`, `-v?\d+`, `.zip` twins, trailing
   dates), propose merging stems with edit-distance ≤ 1 or prefix relationship
   (`botical`, `botical-old`, `Botical2`, `botical/` ⇒ project "botical") — but only as
   **suggestions** (`project_suggestions` table) requiring one-click confirm, because
   name similarity lies (`cob2`/`cob3`/`cob4` might be genuinely distinct).
4. **Content overlap** for suggestion ranking: for candidate pairs, compare dataset
   fingerprints; if not equal, sample overlap = fraction of shared `(relpath, size)`
   pairs among files ≥ 1 MiB, and for git repos `git rev-list` intersection size. Shown
   as "87% file overlap, shares 412 commits".

Per project, the UI renders a **dedupe verdict per member dataset**:

- `canonical` — the member with the most recent novel activity (newest unpushed commit /
  dirty mtime), user-overridable.
- `safe-delete` — clean, fully pushed, fingerprint-equal to canonical or strict content
  subset; deleting loses nothing (reclaims live+derivable bytes, shown).
- `push-then-delete` — would be safe-delete after `git push` of N commits / committing
  M dirty files; one-click "push & mark".
- `diverged` — has novel content absent from canonical (lists it: commits, files);
  needs human merge.

This turns the 300-dir problem into a ranked worklist: "You can reclaim 63 GB by
deleting 41 safe-delete clones; 12 dirs need a push first; 9 are diverged."

---

## 9. SQLite schema

`~/.steward/steward.db`, WAL mode, `PRAGMA synchronous=NORMAL`, all timestamps unix ms.

```sql
CREATE TABLE scan_roots (
  id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE,
  policy TEXT NOT NULL DEFAULT 'deep',          -- deep|shallow|metadata
  enabled INTEGER NOT NULL DEFAULT 1, cold INTEGER NOT NULL DEFAULT 1);

CREATE TABLE entries (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,                    -- absolute
  parent_id INTEGER REFERENCES entries(id),
  kind INTEGER NOT NULL,                        -- 0 file,1 dir,2 symlink
  size INTEGER NOT NULL DEFAULT 0, mtime_ns INTEGER, inode INTEGER, dev INTEGER,
  dirhash BLOB, blake3 BLOB,                    -- nullable, lazy
  small_files_count INTEGER DEFAULT 0, small_files_bytes INTEGER DEFAULT 0,
  class TEXT NOT NULL DEFAULT 'novel',          -- novel|novel-secret|novel-suspect|derivable|derivable-remote|derivable-refetch
  rule_id INTEGER, provenance TEXT,             -- rule that matched; refetch URL / remote
  dataset_id INTEGER REFERENCES datasets(id),
  last_seen_gen INTEGER NOT NULL);
CREATE INDEX entries_parent ON entries(parent_id);
CREATE INDEX entries_dataset ON entries(dataset_id);
CREATE INDEX entries_gen ON entries(last_seen_gen);
CREATE INDEX entries_size ON entries(size) WHERE kind=0 AND size>=8388608; -- dup candidates

CREATE TABLE datasets (
  id INTEGER PRIMARY KEY,
  global_id TEXT NOT NULL,                      -- git identity | blake3(root:relpath) ; UNIQUE per node with root_path
  root_path TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,                           -- git|dir|loose|file
  total_bytes INTEGER, novel_bytes INTEGER, derivable_bytes INTEGER,
  file_count INTEGER, newest_mtime INTEGER,
  content_fingerprint BLOB,                     -- dirhash excl. pruned
  git_repo_id INTEGER REFERENCES git_repos(id),
  project_id INTEGER REFERENCES projects(id),
  score INTEGER, score_reasons TEXT,            -- JSON string[]
  redundancy_target INTEGER NOT NULL DEFAULT 2,
  dedupe_verdict TEXT, dirty INTEGER NOT NULL DEFAULT 1, updated_at INTEGER);
CREATE INDEX datasets_global ON datasets(global_id);
CREATE INDEX datasets_project ON datasets(project_id);
CREATE INDEX datasets_score ON datasets(score);

CREATE TABLE dataset_overrides (path TEXT PRIMARY KEY, action TEXT NOT NULL); -- boundary|merge

CREATE TABLE class_rules (
  id INTEGER PRIMARY KEY, priority INTEGER NOT NULL,
  match_kind TEXT NOT NULL,                     -- name|path|sibling|gitignored|ext|mime
  pattern TEXT NOT NULL, sibling TEXT,
  class TEXT NOT NULL, action TEXT NOT NULL DEFAULT 'index',  -- index|prune
  builtin INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, note TEXT);
CREATE INDEX class_rules_prio ON class_rules(enabled, priority DESC);

CREATE TABLE derivable_breakdown (
  dataset_id INTEGER NOT NULL REFERENCES datasets(id),
  rule_id INTEGER NOT NULL, bytes INTEGER NOT NULL, dir_count INTEGER NOT NULL,
  PRIMARY KEY (dataset_id, rule_id));

CREATE TABLE git_repos (
  id INTEGER PRIMARY KEY, root_path TEXT NOT NULL UNIQUE,
  identity TEXT,                                -- sha1(sorted root commits); NULL if empty repo
  state_hash TEXT,                              -- hash of sorted (ref,tip); for fleet copy currency
  remote_urls TEXT,                             -- JSON string[] normalized
  remoteless INTEGER, dirty INTEGER, untracked_count INTEGER, untracked_bytes INTEGER,
  stash_count INTEGER, ahead_total INTEGER, branches_no_upstream INTEGER,
  objects_novel INTEGER, objects_bytes INTEGER,
  is_worktree_of TEXT, head_ref TEXT, last_commit_at INTEGER, inspected_at INTEGER);
CREATE INDEX git_repos_identity ON git_repos(identity);

CREATE TABLE git_remotes (
  url TEXT PRIMARY KEY, last_ok_at INTEGER, last_err TEXT, head_sample TEXT); -- ls-remote cache

CREATE TABLE projects (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, canonical_dataset_global TEXT,
  created_by TEXT NOT NULL DEFAULT 'auto');     -- auto|user
CREATE TABLE project_suggestions (
  id INTEGER PRIMARY KEY, a_dataset TEXT NOT NULL, b_dataset TEXT NOT NULL,
  reason TEXT NOT NULL, overlap REAL, status TEXT NOT NULL DEFAULT 'open'); -- open|accepted|rejected

CREATE TABLE fleet_datasets (                   -- gossiped manifest, all nodes incl. self
  node_id TEXT NOT NULL, global_id TEXT NOT NULL, path TEXT, kind TEXT,
  content_fingerprint BLOB, git_state_hash TEXT, novel_bytes INTEGER, updated_at INTEGER,
  PRIMARY KEY (node_id, global_id, path));

CREATE TABLE snapshots (                        -- blob-store copies (local index of fleet snapshots)
  id INTEGER PRIMARY KEY, dataset_global TEXT NOT NULL, node_id TEXT NOT NULL,
  volume_id TEXT, fingerprint BLOB NOT NULL, bytes INTEGER, completed_at INTEGER);
CREATE INDEX snapshots_ds ON snapshots(dataset_global);

CREATE TABLE scan_jobs (
  id INTEGER PRIMARY KEY, root_path TEXT NOT NULL, mode TEXT NOT NULL, -- full|partial|cold
  status TEXT NOT NULL DEFAULT 'queued',        -- queued|running|done|failed
  cursor TEXT, enqueued_at INTEGER, started_at INTEGER, finished_at INTEGER, error TEXT);
CREATE TABLE git_jobs (LIKE scan_jobs pattern; root_path, status, timestamps);
CREATE TABLE reclaim_log (id INTEGER PRIMARY KEY, path TEXT, bytes INTEGER, rule_id INTEGER, at INTEGER);
```

---

## 10. HTTP API (localhost:4777, Hono)

| Route | Purpose |
|---|---|
| `GET /api/index/summary` | Fleet + node totals: novel/derivable bytes, score histogram, reclaimable-by-rule |
| `GET /api/datasets?score=0&sort=novel_bytes` | Dataset list w/ filters (score, kind, project, node) |
| `GET /api/datasets/:id` | Full detail: rollups, score_reasons, git state, locations, breakdown |
| `GET /api/entries?parent=…` | Tree browsing for the UI file explorer |
| `POST /api/scan` | `{root?, mode?}` enqueue scan; `GET /api/scan/jobs` status (+ WS progress events `scan:progress {root, dirsDone, dirty}`) |
| `GET /api/rules` / `POST /api/rules` / `PATCH /api/rules/:id` | View/extend/disable classifier rules; PATCH triggers reclassify job |
| `POST /api/reclaim` | `{rule_id?, dataset_id?, dry_run}` delete derivable dirs, returns per-path bytes |
| `GET /api/projects` / `POST /api/projects/:id/merge` | Project groups + accept/reject suggestions |
| `GET /api/projects/:id/dedupe` | Verdict list: canonical / safe-delete / push-then-delete / diverged |
| `POST /api/git/:repoId/refresh` | Re-run inspection (and `ls-remote` if `?liveness=1`) |

WebSocket topics: `scan:progress`, `dataset:changed`, `score:changed`, `fleet:manifest`.

---

## 11. File layout (daemon source)

```
src/indexer/
  scanner.ts        # walk loop, stat pass, dirhash, generation logic
  watcher.ts        # FSEvents/inotify adapters, dirty-set coalescer
  classify.ts       # rule engine, compiled matchers (glob → picomatch, cached)
  rules.seed.ts     # built-in rule table (§4.1) as data
  datasets.ts       # boundary derivation, rollups, refreshDatasets
  git.ts            # repo inspection, identity, liveness cache
  redundancy.ts     # recomputeRedundancy, score reasons
  projects.ts       # grouping, suggestions, dedupe verdicts
  jobs.ts           # scan_jobs/git_jobs queue workers
  db.ts             # schema, migrations (user_version), prepared statements
  api.ts            # Hono routes above
native/steward-fswatch/   # macOS FSEvents shim
```

## 12. Performance & correctness invariants

- Cold full scan of 500k entries: < 60 s on SSD; warm (watcher-covered) scan: < 5 s.
- Scanner never follows symlinks out of roots (`lstat`; symlinks are leaf entries).
- Nothing classified `novel*` is ever deleted by any automated path; `reclaim` refuses
  paths whose class isn't `derivable*` at execution time (re-checked, not trusted from
  the request).
- Every score is explainable: `score_reasons` is never empty when `score` is set.
- A remote/clone/snapshot only counts toward redundancy when *verified current*; stale
  copies are displayed but score 0. Optimism is the enemy of backup systems.
