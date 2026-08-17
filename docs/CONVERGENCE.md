# Machine Convergence & the Facet Framework

Status: design, implementation-ready
Depends on: BRIEF.md (authoritative), vault (BRIEF §8), node identity (BRIEF §identity)

This document specifies how `steward setup` converges a fresh Mac/Linux box to the user's
profile, and how the same machinery continuously detects and repairs drift on every machine
in the fleet.

---

## 1. Core concept: the facet

A **facet** is a declarative unit of machine configuration with three verbs:

- **capture** — read the machine's *current* state for this facet (pure read, never mutates).
- **diff** — compare current state against *desired* state (from the profile repo) and
  produce a list of discrete `Change`s.
- **apply** — execute a subset of those changes to move the machine toward desired state.

Two directions of reconciliation exist, and both are first-class:

- **apply**: machine ← profile (converge the machine).
- **adopt**: profile ← machine (absorb what you did by hand into the profile; this is how
  the profile stays alive instead of rotting).

Design principles (these resolve most later arguments; treat as normative):

1. **Scoped capture.** A facet captures only what the profile declares interest in.
   `macos-defaults` reads only the domains/keys listed in desired state; `dotfiles` hashes
   only the listed files. Unscoped capture (e.g. all of `defaults read`) produces unusable
   drift noise. The one exception is bootstrap capture (§5), which uses a facet-specific
   heuristic to propose an initial scope.
2. **Additive by default.** Convergence installs/sets what the profile wants. Things on the
   machine that the profile doesn't mention are reported as *unmanaged*, not deleted.
   A facet instance can opt into `strict: true` to also remove extras (sensible for
   e.g. VS Code extensions, dangerous for brew formulae).
3. **Idempotent apply, verified by recapture.** After apply, Steward re-runs capture and
   re-diffs. Residual changes ⇒ the run is marked `partial` with the remainder listed.
   `apply` must be safe to run twice.
4. **Every change is discrete, previewable, and individually selectable.** No facet applies
   as an opaque blob. The UI and CLI both show the change list before mutation.
5. **Honest about the un-automatable.** Changes a program cannot make (TCC permission
   grants, App Store sign-in, FileVault, GUI installers) are modeled as `manual` changes:
   they appear in the plan as a human checklist and count as drift until confirmed done.

---

## 2. Facet definition format (TypeScript)

Facets are TypeScript modules. **Builtin facets ship inside the Steward source tree**
(`~/.steward/src/src/facets/builtin/*.ts`) so they update with Steward itself. **Custom
facets live in the profile repo** (`~/.steward/profile/facets/<name>/facet.ts`). Both use
the same API, imported from the Steward source (the profile depends on `steward` as a
workspace/path dependency; see §3).

### 2.1 Types

```ts
// steward/src/facets/types.ts

export type Platform = "darwin" | "linux";
export type Role = "laptop" | "desktop" | "server" | "backup";  // shared node-role enum (ARCHITECTURE §10, FLEET §2.4)
export type Danger = "safe" | "caution" | "destructive";

export interface Change {
  /** Stable within a facet across runs, e.g. "install:ripgrep", "set:NSGlobalDomain/KeyRepeat". */
  id: string;
  kind: "add" | "remove" | "update" | "manual";
  /** JSON-pointer-ish path into the state object, for UI grouping. */
  path: string;
  current?: unknown;   // redacted for secret-bearing values (see §8)
  desired?: unknown;
  summary: string;     // one line, human: "brew install ripgrep"
  danger: Danger;      // safe: auto-appliable; caution: confirm; destructive: explicit opt-in
  needsSudo: boolean;
  /** For kind:"manual" — instructions for the human, markdown. */
  instructions?: string;
  /** Post-apply hint surfaced in UI: "logout required", "restart Dock", … */
  postNote?: string;
}

export interface FacetCtx {
  platform: Platform;
  role: Role;
  nodeId: string;          // "stw1…" pubkey-derived node id (FLEET.md §2.2)
  hostname: string;
  home: string;            // absolute $HOME
  profileDir: string;      // ~/.steward/profile
  facetDataDir: string;    // ~/.steward/profile/facets/<name>/
  /** Run a command; capture must only use it read-only (enforced by convention + review). */
  exec(cmd: string[], opts?: { sudo?: boolean; stdin?: string; timeoutMs?: number }):
    Promise<{ code: number; stdout: string; stderr: string }>;
  vault: {
    /** Resolve a vault reference to plaintext. Throws VaultLockedError if locked. */
    get(ref: string): Promise<string>;
    /** sha256 of the plaintext without exposing it; usable for diffing. */
    hash(ref: string): Promise<string>;
    isUnlocked(): boolean;
  };
  log(msg: string): void;  // streamed to run log (SQLite + UI)
}

export interface Facet<S = unknown> {
  name: string;                 // kebab-case, unique; builtin names are reserved
  description: string;
  version: 1;                   // format version of the state schema, for migrations
  platforms: Platform[];
  roles?: Role[];               // omit = all roles
  /** Hard deps: these facets must be applied (clean or converged) first. */
  requires?: string[];          // e.g. ["homebrew"]
  /** never = capture/apply fully unprivileged; perChange = Change.needsSudo decides. */
  sudo: "never" | "perChange";
  /** Drift-check cadence; default "6h". Cheap facets may use "15m". */
  driftInterval?: string;
  /** Zod schema for desired-state files; validated on profile load. */
  stateSchema: ZodType<S>;

  capture(desired: S, ctx: FacetCtx): Promise<S>;
  /** Optional; default is the structural differ of §6. */
  diff?(current: S, desired: S, ctx: FacetCtx): Change[];
  apply(changes: Change[], ctx: FacetCtx): Promise<void>;
  /** Optional; default writes `current` verbatim over the desired-state file (§5.3). */
  adopt?(current: S, desired: S, ctx: FacetCtx): Promise<S>;
  /** Bootstrap heuristic: propose an initial desired state on a virgin profile (§5.1). */
  bootstrap?(ctx: FacetCtx): Promise<S>;
}

export function defineFacet<S>(f: Facet<S>): Facet<S> { return f; }
```

Note `capture(desired, ctx)`: capture receives desired state so it can scope itself
(principle 1). For a fresh profile, `bootstrap()` is the unscoped variant.

### 2.2 Example: the homebrew facet (builtin, abridged but real shape)

```ts
// steward/src/facets/builtin/homebrew.ts
import { z } from "zod";
import { defineFacet } from "../types";

const State = z.object({
  taps: z.array(z.string()).default([]),
  formulae: z.array(z.string()).default([]),   // leaves only
  casks: z.array(z.string()).default([]),
  strict: z.boolean().default(false),          // remove unlisted leaves/casks
});

export default defineFacet<z.infer<typeof State>>({
  name: "homebrew",
  description: "Homebrew taps, formulae (leaves), and casks",
  version: 1,
  platforms: ["darwin", "linux"],
  sudo: "perChange",
  driftInterval: "6h",
  stateSchema: State,

  async bootstrap(ctx) {
    const leaves = (await ctx.exec(["brew", "leaves"])).stdout.trim().split("\n");
    const casks  = (await ctx.exec(["brew", "list", "--cask"])).stdout.trim().split("\n");
    const taps   = (await ctx.exec(["brew", "tap"])).stdout.trim().split("\n");
    return { taps, formulae: leaves.filter(Boolean), casks: casks.filter(Boolean), strict: false };
  },

  async capture(desired, ctx) {
    if ((await ctx.exec(["which", "brew"])).code !== 0)
      return { taps: [], formulae: [], casks: [], strict: desired.strict };
    // full lists; the differ scopes against `desired` unless strict
    const leaves = (await ctx.exec(["brew", "leaves"])).stdout.trim().split("\n").filter(Boolean);
    const casks  = (await ctx.exec(["brew", "list", "--cask"])).stdout.trim().split("\n").filter(Boolean);
    const taps   = (await ctx.exec(["brew", "tap"])).stdout.trim().split("\n").filter(Boolean);
    return { taps, formulae: leaves, casks, strict: desired.strict };
  },

  diff(current, desired) {
    const changes: Change[] = [];
    if (current.formulae.length === 0 && current.casks.length === 0 && desired.formulae.length > 0) {
      // brew itself may be missing
      changes.push({
        id: "install:homebrew", kind: "add", path: "/", danger: "caution", needsSudo: true,
        summary: "Install Homebrew (runs official installer; prompts for password)",
      });
    }
    for (const f of desired.formulae) if (!current.formulae.includes(f))
      changes.push({ id: `install:${f}`, kind: "add", path: `/formulae/${f}`,
        desired: f, summary: `brew install ${f}`, danger: "safe", needsSudo: false });
    for (const c of desired.casks) if (!current.casks.includes(c))
      changes.push({ id: `cask:${c}`, kind: "add", path: `/casks/${c}`,
        desired: c, summary: `brew install --cask ${c}`, danger: "safe",
        needsSudo: true /* many casks prompt for admin via installer */ });
    if (desired.strict) {
      for (const f of current.formulae) if (!desired.formulae.includes(f))
        changes.push({ id: `uninstall:${f}`, kind: "remove", path: `/formulae/${f}`,
          current: f, summary: `brew uninstall ${f}`, danger: "destructive", needsSudo: false });
    }
    return changes;
  },

  async apply(changes, ctx) {
    for (const ch of changes) {
      if (ch.id === "install:homebrew") { /* curl installer, NONINTERACTIVE=1 */ }
      else if (ch.id.startsWith("install:")) await ctx.exec(["brew", "install", ch.desired as string]);
      else if (ch.id.startsWith("cask:"))    await ctx.exec(["brew", "install", "--cask", ch.desired as string]);
      else if (ch.id.startsWith("uninstall:")) await ctx.exec(["brew", "uninstall", ch.current as string]);
    }
  },
});
```

---

## 3. Profile repo layout (`~/.steward/profile`)

The profile is a **git repo** (usually with a private remote, but node-to-node sync works
too — it's just another repo Steward stewards). Everything in it is plaintext-safe:
secrets are vault references, never values.

```
~/.steward/profile/
  package.json               # { "dependencies": { "steward": "file:../src" } } — types only
  steward.profile.ts         # manifest (below)
  machines.json              # nodeId → machine record (below)
  facets/
    homebrew/
      state.json             # base desired state (validated by facet.stateSchema)
      state.role-server.json # role overlay
      state.machine-m4max.json  # machine overlay (by machine name, not nodeId, for readability)
    macos-defaults/state.json
    dotfiles/
      state.json             # list of managed entries
    my-custom-thing/
      facet.ts               # custom facet implementation
      state.json
  dotfiles/                  # file payloads for the dotfiles facet, mirroring $HOME
    .zshrc
    .config/ghostty/config
    .gitconfig.tmpl          # template: {{vault:...}}, {{machine.*}} substitution
  fonts/                     # font payloads (or vault/URL refs for licensed fonts)
```

### 3.1 `steward.profile.ts`

```ts
import { defineProfile, builtin, local } from "steward/profile";

export default defineProfile({
  facets: [
    builtin("homebrew"),
    builtin("dotfiles"),
    builtin("macos-defaults"),
    builtin("git-config"),
    builtin("ssh-keys"),
    builtin("runtime-versions"),
    builtin("fonts"),
    builtin("vscode"),
    local("./facets/my-custom-thing/facet.ts"),
  ],
});
```

`builtin(name)` references a facet shipped with Steward; `local(path)` imports from the
profile. The manifest is the single source of *which facets are active*; a facet with no
manifest entry is inert even if its state files exist.

### 3.2 `machines.json`

```json
{
  "m4max": {
    "nodeId": "stw1k7f3q2xa...",
    "role": "laptop",
    "platform": "darwin",
    "tags": ["personal", "primary"]
  },
  "hetzner1": { "nodeId": "stw1abc...", "role": "server", "platform": "linux", "tags": [] }
}
```

New machines are appended by `steward setup` (§7) and the file is committed/pushed like any
profile change.

### 3.3 State overlays and merging

Effective desired state for a facet on a machine =
`state.json` ⊕ `state.role-<role>.json` ⊕ `state.machine-<name>.json` (later wins).

Merge algorithm (deterministic, no facet involvement):

- Objects: deep merge, key by key.
- Arrays: **set-union by canonical-JSON identity** (this is what you want for package
  lists, fonts, extensions).
- Overlay removal/replacement directives, valid at any object level:
  - `"$remove": { "formulae": ["mysql"] }` — remove these array items from the merged result.
  - `"$replace": ["casks"]` — for the listed sibling keys, overlay value replaces instead
    of unioning/merging.
- Scalars: overlay wins.

The merged object is validated against `facet.stateSchema` (zod) at load time; a schema
error blocks that facet with a clear UI error, not the whole profile.

---

## 4. Runtime: how facets execute

### 4.1 Runner process

The daemon never `import()`s profile code in-process (a bad facet must not take down the
daemon, and apply needs its own lifecycle). Each facet action runs in a spawned Bun
subprocess:

```
bun ~/.steward/src/src/facets/runner.ts \
  --profile ~/.steward/profile --facet homebrew --action capture --machine m4max
```

Protocol: runner writes NDJSON events to stdout —
`{"t":"log","msg":...}`, `{"t":"result","state":...}` / `{"t":"changes",...}` /
`{"t":"error","message":...,"stack":...}` — and exits 0/1. The daemon supervises with a
timeout (capture: 120s default; apply: 30min). Vault access is brokered: the runner does
**not** get the vault key; `ctx.vault.get()` calls back to the daemon over a unix socket
(`~/.steward/facet.sock`, mode 0600) with a per-run token, so plaintext secrets exist only
in the runner's memory during apply.

### 4.2 Ordering and dependencies

- Build a DAG from `requires`. Cycle ⇒ profile load error.
- Additionally there are two implicit phases before the DAG:
  - **phase 0 — prerequisites** (macOS: Xcode Command Line Tools; Linux: `build-essential`
    presence check). CLT install is `kind:"manual"` on macOS pre-Ventura; on modern macOS
    we run `xcode-select --install` and wait, which still pops a GUI confirm — modeled as
    a `manual`-flavored change with a waiting loop.
  - **phase 1 — package managers** (`homebrew` on darwin, `apt-packages`/`dnf-packages`
    on linux). Any facet may `requires: ["homebrew"]`; most builtin ones do implicitly by
    platform.
- Execution order: Kahn topological sort; ties broken by manifest order.
- **Apply is serial** across facets (package managers hate concurrency; sudo prompts must
  not interleave). **Capture is parallel**, max 4 runners.
- A facet whose `requires` failed is **skipped** (status `blocked`), but independent
  branches of the DAG continue.

### 4.3 The converge algorithm (used by `steward setup`, `steward apply`, and UI "Converge")

```
load profile (git pull first unless --offline)
resolve machine record (nodeId → machines.json); compute role/platform
facets = manifest facets filtered by platform + roles
order  = toposort(facets)
plans  = []
for f in order (capture phase, parallel):
    desired = mergeOverlays(f)
    current = run(f.capture, desired)
    changes = f.diff ? f.diff(current, desired) : structuralDiff(current, desired, f)
    plans.push({facet: f, changes})
present full plan (CLI table / UI review screen), grouped by facet, flagged by danger
selection policy:
    --yes / auto-converge: include danger=safe only
    interactive: safe pre-checked; caution unchecked; destructive requires typing facet name
    manual changes: always shown as checklist, never "applied" by steward
if any selected change needsSudo:
    CLI: `sudo -v` once up front + keepalive `sudo -v` every 60s during apply
    UI-initiated run on the local node: daemon has no TTY → sudo-needing changes are
    deferred into a "terminal required" bundle; UI shows `steward apply --pending` to run
for f in order (apply phase, serial):
    if any of f.requires ended failed → mark blocked, continue
    run(f.apply, selectedChanges) with live log streaming
    recapture + rediff → residual changes ⇒ status partial, else converged
persist run + resulting state to SQLite (§5.4 schema)
print/emit summary + manual checklist
```

Sudo honesty: we never store the sudo password, never pipe it, never configure NOPASSWD.
Sudo-needing changes are only possible from a terminal session (or a server with
passwordless sudo the user configured themselves, which `sudo -n true` detects).

---

## 5. Capture-from-existing-machine (bootstrapping the profile)

This is the first-run story on the *current, already-configured* Mac.

### 5.1 `steward profile init`

```
steward profile init [--remote git@github.com:eric/steward-profile.git]
```

1. Create `~/.steward/profile`, `git init`, scaffold `package.json`,
   `steward.profile.ts` with all platform-applicable builtin facets, `machines.json`
   with this machine (name defaults to lowercased short hostname; prompt to confirm).
2. For each builtin facet that implements `bootstrap()`, run it (parallel, read-only) and
   write the proposed state to `facets/<name>/state.json`.
3. Interactive review (CLI checklist per facet): show item counts
   (`homebrew: 47 formulae, 12 casks`), let the user open each proposed state in `$EDITOR`
   or accept. Facets can be deselected (removed from the manifest).
4. Special cases during bootstrap:
   - **dotfiles**: proposes a candidate list (`.zshrc`, `.zprofile`, `.gitconfig`,
     `.config/ghostty/**`, `.config/nvim/**`, `.ssh/config` — a curated allowlist, not a
     $HOME scan). Accepted files are **moved into the repo and symlinked back**
     immediately (`adopt` semantics), so the machine is converged from second zero.
   - **ssh-keys**: private keys are imported into the **vault** (prompts to create/unlock
     vault first), state.json gets `{ "$vault": "ssh/<name>" }` refs + public keys inline.
     Nothing secret touches the repo.
   - **macos-defaults**: proposes a curated set of ~40 well-known keys (key repeat, Dock
     autohide, Finder prefs, screenshot location, …) read from the live system — not a
     full `defaults` dump.
5. `git add -A && git commit -m "bootstrap from <machine>"`; push if `--remote` given.

### 5.2 Continuous adoption

`steward capture <facet>` (CLI) or UI "Adopt" on a drift item runs `adopt`: default
implementation overwrites the machine-appropriate state file — base `state.json` if the
value isn't overridden anywhere, otherwise the most specific overlay that currently defines
it — then commits to the profile repo (`steward: adopt <facet> on <machine>` message).
Push is a separate explicit step (`steward profile sync` = pull --rebase, then push).

### 5.3 Adopt granularity

Adoption is per-change, like apply: adopting `install:fd` adds `"fd"` to `formulae` without
touching other pending changes. The default `adopt` handles this via the structural differ's
path info; custom facets with custom diffs must implement `adopt` if they want partial
adoption (else it's all-or-nothing with a warning).

### 5.4 SQLite schema (daemon DB, `~/.steward/steward.db`)

```sql
CREATE TABLE facet_state (          -- latest capture per facet per node
  facet       TEXT NOT NULL,
  node_id     TEXT NOT NULL,        -- fleet-wide: peers gossip their rows (§9)
  captured_at INTEGER NOT NULL,     -- unixtime
  state_hash  TEXT NOT NULL,        -- sha256 of canonical JSON, secrets redacted
  state_json  TEXT NOT NULL,        -- redacted state
  PRIMARY KEY (facet, node_id)
);

CREATE TABLE facet_drift (
  id          INTEGER PRIMARY KEY,
  facet       TEXT NOT NULL,
  node_id     TEXT NOT NULL,
  change_id   TEXT NOT NULL,        -- Change.id
  change_json TEXT NOT NULL,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  status      TEXT NOT NULL CHECK (status IN
              ('open','applying','applied','adopted','dismissed','manual_done')),
  UNIQUE (facet, node_id, change_id)
);

CREATE TABLE facet_runs (
  id          INTEGER PRIMARY KEY,
  facet       TEXT NOT NULL,
  node_id     TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('capture','apply','adopt','bootstrap')),
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  status      TEXT NOT NULL CHECK (status IN
              ('running','converged','partial','failed','blocked','skipped')),
  log         TEXT NOT NULL DEFAULT '',   -- NDJSON event stream
  profile_rev TEXT                        -- git rev of profile at run time
);
```

---

## 6. Diffing

### 6.1 Structural differ (default)

Input: `current`, `desired` (both schema-validated), plus per-facet hints.

```
diff(cur, des, path="/"):
  if both objects: recurse over union of keys
  if both arrays:  treat as sets by canonicalJSON(item);
                   items only in desired → Change{kind:add}
                   items only in current → Change{kind:remove} ONLY IF facet state has
                     strict:true at the nearest ancestor; otherwise recorded as
                     "unmanaged" (informational, not drift)
  if scalars and unequal: Change{kind:update, current, desired}
  missing in current, present in desired → add; inverse → remove (strict-gated)
```

- `Change.id` = `<kind>:<path>` (stable across runs → dedupe in `facet_drift` works).
- Danger defaults: `add`/`update` → safe; `remove` → destructive. Facet diffs override.
- Vault references diff by `ctx.vault.hash(ref)` vs a machine-side hash the facet computes
  (e.g. sha256 of the installed private key file) — plaintext never enters the differ.

### 6.2 Drift detection loop

The daemon scheduler (same subsystem as data-indexing jobs) enqueues per-facet capture on
`driftInterval` (default 6h; jittered ±10%), plus immediately after: profile git change
(pull or local commit), `steward apply`, machine wake from sleep (>1h asleep), and manual
"Check now".

Cheap optimization: capture writes `state_hash`; if unchanged from last capture **and** the
profile rev is unchanged, skip diffing entirely.

Drift lifecycle: new `Change.id` ⇒ insert `open` row; re-seen ⇒ bump `last_seen`; absent
in latest diff ⇒ row deleted (resolved outside Steward counts as resolved). `dismissed`
rows persist and suppress the change until the profile rev changes (dismiss = "not now",
not "never"). `manual` changes stay open until the user marks `manual_done` in the UI,
after which recapture usually confirms them resolved anyway.

UI: fleet dashboard shows a **drift badge per node** (count, worst danger color); node →
facet → change drill-down; every change row has Apply / Adopt / Dismiss. Drift on the
BRIEF's "green fleet" screen: a node is green only if backups are green **and** drift = 0
open non-manual changes.

---

## 7. `steward setup` — fresh machine flow

Precondition: the one-line installer (BRIEF §1) has run; daemon is up; browser opened.
`steward setup` is a **terminal** flow by design (sudo, vault password).

```
steward setup
  1. Profile source — one of:
     a. git URL (prompt; clone to ~/.steward/profile)
     b. pair with an existing node (short code / QR, per BRIEF identity):
        the peer streams the profile repo over the node channel (git bundle),
        no external remote required
  2. Register machine: prompt name + role (laptop/desktop/server) → append to
     machines.json, commit. (Push later; fresh box may lack credentials — the profile
     sync facet or paired peer handles propagation.)
  3. Vault: prompt master password → unlock (vault ciphertext arrives via the profile's
     paired peer or is created empty if none). Secret-bearing facets are blocked
     (not failed) while locked.
  4. Converge (algorithm §4.3) with --interactive default:
     phase 0: CLT/GUI prerequisites (manual-ish, waits)
     phase 1: homebrew / apt
     DAG: everything else
  5. Print summary: converged/partial/blocked per facet + the manual checklist
     (also persisted; UI shows it until checked off):
       [ ] Sign into App Store (mas), then re-run: steward apply app-store
       [ ] Grant Full Disk Access to Steward (System Settings → Privacy)
       [ ] Sign into Tailscale: tailscale up
       [ ] Log out/in for keyboard settings to fully take effect
```

Target: on a fresh Mac, everything automatable lands in one sitting with ~2 password
prompts (login password for sudo once, master password once) plus the GUI checklist.
"Imperfect at first; iterate" (BRIEF) — partial convergence is a normal, visible state,
not an error.

---

## 8. Secrets: vault integration rules

- Desired-state files may contain `{ "$vault": "<path/in/vault>" }` wherever the schema
  says `vaultRef()` (a zod helper). The profile repo therefore never needs encryption.
- Runner secret access is brokered by the daemon (§4.1); the daemon logs every
  `vault.get` (facet, ref, run id) to the audit table — never values.
- Capture/diff must be secret-free: facets compare hashes/fingerprints
  (ssh: `ssh-keygen -lf`; files: sha256). Lint rule in the runner: the `state` result is
  scanned for high-entropy strings > 32 chars matching key/token patterns; matches fail the
  run with a "facet leaked a probable secret into state" error rather than persisting it.
- Templates in dotfiles (`.gitconfig.tmpl` → `{{vault:github/token}}`) are rendered at
  apply into the target file; the target is then diffed against the *rendered* content
  hash, and such targets are always `copy` mode (never symlink a secret-bearing render
  back into the repo).

---

## 9. Fleet API & CLI surface

All routes on the Hono server (localhost:4777); remote nodes reached via the canonical
proxy route `/api/nodes/:id/proxy/*` over the authenticated node channel (ARCHITECTURE.md
§6.2 — pattern shared with the rest of Steward).

```
GET  /api/facets                     → [{name, platform-applicable, status, driftCount,
                                        lastCaptureAt, lastRun}]
GET  /api/facets/:name               → {desiredEffective, currentRedacted, changes, runs[]}
POST /api/facets/:name/capture       → run capture now; returns run id
POST /api/facets/:name/plan          → capture + diff, returns Change[]
POST /api/facets/:name/apply         body {changeIds?: string[]}   → run id (sudo-needing
                                      changes are rejected with 409 {pendingTerminal:true})
POST /api/facets/:name/adopt         body {changeIds?: string[]}   → run id
GET  /api/facets/:name/runs/:id/log  → NDJSON stream (WebSocket upgrade for live tail)
GET  /api/drift                      → fleet summary: per-node {open, byDanger, manualOpen}
                                       (peers gossip facet_state/facet_drift summaries on
                                       the node channel every 5m + on change)
POST /api/drift/:id/dismiss
POST /api/drift/:id/manual-done
GET  /api/profile                    → {rev, dirty, remote, machines}
POST /api/profile/sync               → pull --rebase + push; returns conflicts if any
```

CLI (thin wrappers over the same code paths, but with TTY powers):

```
steward setup                     # §7
steward profile init|sync|status
steward plan [facet…]             # capture+diff, print table, no mutation
steward apply [facet…] [--yes] [--pending] [--strict-ok]
steward capture [facet…]          # a.k.a. adopt --all for the facet
steward adopt <facet> [changeId…]
steward drift [--node <name>] [--json]
```

---

## 10. Starter facet library

Shipped as builtins, in rough implementation order. Sudo/interaction honesty inline.

| Facet | Platforms | What it manages | Sudo / interaction reality |
|---|---|---|---|
| `homebrew` | darwin, linux | taps, leaf formulae, casks | Brew install itself: sudo once. Many casks invoke GUI installers or ask admin; run per-cask, tolerate failure. |
| `apt-packages` / `dnf-packages` | linux | manually-installed package set (`apt-mark showmanual` filtered) | Always sudo. Fine on servers with NOPASSWD; terminal otherwise. |
| `dotfiles` | both | listed files: symlink (default) or copy or template | No sudo. Symlink mode makes machine edits = repo edits (drift shows as dirty profile git). |
| `git-config` | both | `~/.gitconfig` keys (user, aliases, signing key from vault) | None. |
| `ssh-keys` | both | keys from vault → `~/.ssh` (0600), `~/.ssh/config` via dotfiles | None; agent/keychain add is best-effort (`ssh-add --apple-use-keychain` prompts on first use). |
| `macos-defaults` | darwin | curated `defaults write` set | No sudo for user domains; some need `killall Dock/Finder/SystemUIServer` (postNote); a few (e.g. some accessibility/TCC-adjacent) simply cannot be set programmatically → `manual`. Some need logout. |
| `runtime-versions` | both | node/bun versions via `mise` (installs mise if absent) | None. |
| `fonts` | both | files → `~/Library/Fonts` / `~/.local/share/fonts` (+ `fc-cache`) | None. Licensed fonts referenced from vault as base64 blobs, not committed. |
| `vscode` | both | settings.json, keybindings.json (via dotfiles engine), extension list (`code --list-extensions`), strict-friendly | None; needs `code` CLI on PATH (else `manual`). |
| `shell` | both | default shell (`chsh`), listed as one change | `chsh` prompts for the *user's* password — terminal-only change. |
| `hostname` | both | ComputerName/LocalHostName / `hostnamectl` | sudo (`scutil`, `hostnamectl`). |
| `login-items` | darwin | login items via `osascript`/SMAppService list | May trigger Automation TCC prompt on first run (`manual`-flavored, once). |
| `app-store` | darwin | `mas` app ids | Requires App Store sign-in — cannot automate; blocked → `manual` until signed in. |
| `dock` | darwin | dock apps/order via `defaults write com.apple.dock persistent-apps` + `killall Dock` | No sudo; fiddly plist format; ship late. |
| `launchd-agents` / `systemd-user` | darwin / linux | user-level services (files + enable state) | No sudo for user scope; system scope out of scope v1. |
| `crontab` | both | user crontab content | None. |
| `tailscale` | both | installed + logged-in state check | Login is interactive browser auth → `manual`. |

Explicit non-goals for facets v1: browser profiles/extensions, TCC/privacy grants
(programmatically impossible by design), FileVault, licensed-app activation, System
Settings panes without a `defaults` surface. These get `manual` checklist entries where
they matter and are otherwise out of scope.

---

## 11. File layout summary (Steward source side)

```
~/.steward/src/src/facets/
  types.ts          # §2.1
  runner.ts         # subprocess entrypoint (§4.1)
  merge.ts          # overlay merge (§3.3)
  differ.ts         # structural diff (§6.1)
  scheduler.ts      # drift loop hooks into daemon scheduler
  store.ts          # SQLite access (§5.4)
  routes.ts         # Hono routes (§9)
  converge.ts       # plan/apply orchestration (§4.3), shared by CLI + API
  sudo.ts           # sudo -v keepalive, sudo -n detection
  builtin/
    homebrew.ts  apt-packages.ts  dotfiles.ts  git-config.ts  ssh-keys.ts
    macos-defaults.ts  runtime-versions.ts  fonts.ts  vscode.ts  shell.ts
    hostname.ts  login-items.ts  app-store.ts  dock.ts  crontab.ts
    launchd-agents.ts  systemd-user.ts  tailscale.ts
```

## 12. Open questions (tracked, not blocking)

1. Facet state schema migrations (`version` bumps) — proposal: facets ship `migrate(old)`
   per version; deferred until a builtin actually needs it.
2. Multi-user machines — out of scope (single power-user per BRIEF).
3. Conflict when two machines adopt divergent values for the same base key — currently
   resolved by git (profile sync surfaces the conflict); consider auto-splitting into
   machine overlays later.
