# Steward — Web UI/UX Design

Authoritative design spec for the Steward web UI (React + Vite + Tailwind, served by the
daemon at `http://localhost:4777`). Companion to `docs/BRIEF.md`. A developer should be able
to build every screen from this document without mockups.

---

## 1. Product feel

Three words, in priority order: **calm, legible, trustworthy.**

- Steward is a guardian, not a dashboard toy. No gauges, no gradients-for-decoration, no
  confetti. The UI's job is to answer one question instantly — *"is everything safe?"* —
  and then get out of the way.
- **Green is earned.** The interface is mostly neutral gray. Color appears only to carry
  meaning: safety status, diff semantics, destructive actions. When the whole fleet is
  healthy the dominant accent on screen is a single quiet green summary — not a wall of
  green checkmarks.
- **Density with hierarchy.** Power-user tool: tables and monospace where data lives,
  generous whitespace where judgment happens (the Fleet summary, the commit box).
- **Never lie about staleness.** Every remote-sourced panel shows when its data was
  captured. A disconnected node is visually "cooled," never silently frozen.

---

## 2. Design language

### 2.1 Color tokens (dark-first)

Implemented as CSS custom properties on `:root` (dark is the default; `.light` class flips
them). Tailwind v4 `@theme` maps them to utilities. All pairs meet WCAG AA against their
intended surface.

```css
/* ui/src/styles/tokens.css */
:root {
  /* Surfaces — cool near-black, stepped, never pure #000 */
  --bg-base:     #0b0d10;  /* app background */
  --bg-sunken:   #07090b;  /* wells: code, diffs, terminal */
  --bg-surface:  #12151a;  /* cards, nav rail */
  --bg-raised:   #1a1e25;  /* popovers, modals, command palette */
  --bg-hover:    #1e232b;  /* row/list hover */
  --bg-active:   #252b35;  /* selected row, pressed */

  /* Borders */
  --border-subtle: #1f242c; /* card edges, table rules */
  --border-strong: #2e3540; /* inputs, focused cards */
  --border-focus:  #4f8ef7; /* focus ring color */

  /* Text */
  --text-primary:   #e6e9ef;
  --text-secondary: #9aa3b2;
  --text-tertiary:  #626b7a;  /* timestamps, captions, disabled */
  --text-invert:    #0b0d10;  /* text on filled accent buttons */

  /* Accent (interactive, links, focus) — calm blue, NOT a status color */
  --accent:        #4f8ef7;
  --accent-hover:  #6ba1f9;
  --accent-muted:  #1a2c4d;  /* accent-tinted fills, selected nav item bg */

  /* Status — the semantic core of Steward */
  --ok:        #3fb970;  --ok-muted:    #10281c;  /* safe / redundant / clean */
  --warn:      #d9a03f;  --warn-muted:  #2c2312;  /* at risk / dirty / drifted */
  --danger:    #e5534b;  --danger-muted:#2d1513;  /* single-copy / failed / destructive */
  --info:      #58a6ff;  --info-muted:  #142338;  /* syncing / in progress */
  --neutral:   #768090;  --neutral-muted:#1b1f26; /* junk / ignored / offline */

  /* Diff (git) */
  --diff-add-bg:  #12261a;  --diff-add-text:  #56d364;
  --diff-del-bg:  #2d1517;  --diff-del-text:  #f47067;
  --diff-hunk-bg: #131c2b;

  /* Charts / sparklines (disk usage, sync throughput) */
  --chart-1: #4f8ef7; --chart-2: #3fb970; --chart-3: #d9a03f; --chart-4: #a371f7;
}
.light {
  --bg-base: #f7f8fa; --bg-sunken: #eef0f3; --bg-surface: #ffffff;
  --bg-raised: #ffffff; --bg-hover: #f0f2f5; --bg-active: #e6eaf0;
  --border-subtle: #e3e6eb; --border-strong: #c9cfd8; --border-focus: #2f6fe4;
  --text-primary: #171b21; --text-secondary: #5a6372; --text-tertiary: #8b94a3;
  --text-invert: #ffffff;
  --accent: #2f6fe4; --accent-hover: #245bc4; --accent-muted: #e3ecfc;
  --ok: #1a7f4b; --ok-muted: #e2f5ea; --warn: #9a6b0c; --warn-muted: #faf0d8;
  --danger: #c93c34; --danger-muted: #fbe7e5; --info: #2f6fe4; --info-muted: #e3ecfc;
  --neutral: #6b7484; --neutral-muted: #eef0f3;
  --diff-add-bg: #e6f7ea; --diff-add-text: #1a7f4b;
  --diff-del-bg: #fbe9e8; --diff-del-text: #c93c34; --diff-hunk-bg: #eaf1fb;
}
```

Rules:
- Status colors are used for **badges, dots, thin left-border card accents, and text** —
  never as full card backgrounds (muted variants may fill badges/pills only).
- The blue `--accent` is exclusively interactive (buttons, links, selection, focus). Never
  use it to mean "healthy"; that's `--ok`.
- Exactly one primary (filled) button per screen region; everything else is ghost/outline.

### 2.2 Typography

- **UI face:** `Inter Variable` (bundled woff2, `font-display: swap`), fallback
  `-apple-system, "Segoe UI", sans-serif`. Enable `ss01` (open digits) and tabular numbers
  (`font-variant-numeric: tabular-nums`) on all tables, counters, and timestamps.
- **Mono face:** `"Berkeley Mono", "JetBrains Mono", ui-monospace, monospace` for paths,
  hashes, branch names, diffs, code, vault secrets, terminal output.

Type scale (rem, 16px root; line-height beside):

| Token | Size / LH | Weight | Use |
|---|---|---|---|
| `text-2xs` | 11px / 16 | 500 | badge labels, table column headers (uppercase, +0.06em tracking) |
| `text-xs`  | 12px / 18 | 400 | captions, timestamps, breadcrumbs |
| `text-sm`  | 13px / 20 | 400 | **default UI + table body size** |
| `text-base`| 15px / 22 | 400 | prose, forms, detail panes |
| `text-lg`  | 18px / 26 | 600 | card titles, section headers |
| `text-xl`  | 22px / 30 | 600 | page titles |
| `text-3xl` | 32px / 38 | 650 | hero numbers (Fleet safety count) |
| `text-num` | 44px / 48 | 650, tabular | dashboard big stats only |

The default UI size is deliberately 13px: this is a dense operator tool. Nothing below 11px,
ever.

### 2.3 Spacing, radius, elevation

- **4px base grid.** Allowed steps: 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64.
- Page gutter 24px; card padding 16px (20px for the Fleet hero); table row height 36px
  (compact 28px in diff/file lists); nav rail item height 36px.
- Radii: `r-sm` 4px (badges, inputs), `r-md` 8px (cards, buttons), `r-lg` 12px (modals,
  command palette). No pill-shaped buttons; pills only for count badges.
- Elevation: dark UIs get elevation from **lighter surface + 1px border**, not shadows.
  Shadows only on floating layers: popover `0 4px 16px rgb(0 0 0 / .4)`, modal
  `0 12px 40px rgb(0 0 0 / .5)` plus a full-screen scrim `rgb(4 6 8 / .6)`.

### 2.4 Iconography

- **Lucide** (`lucide-react`), stroke width 1.75, sizes 16px (inline/table) and 20px (nav).
  No emoji anywhere in the UI. No filled icon style except status dots.
- Canonical assignments (do not improvise): Fleet `radar`, Data `database`, Repos
  `git-branch`, Files `folder`, Docker `container`, Vault `lock` / unlocked `lock-open`,
  Setup `sliders-horizontal`, Steward `shield`, node-mac `laptop`, node-linux `server`,
  offline `plug-zap` (dimmed), sync `refresh-cw` (spins while active), redundancy
  `copy-check`, junk `trash-2`, push `arrow-up`, pull `arrow-down`, dirty `circle-dot`.
- Status is **never icon-only**: every status icon/dot pairs with a text label or tooltip.

### 2.5 Motion

- Durations: 120ms (hover/press), 180ms (popover, row expand), 240ms (drawer/modal). Easing
  `cubic-bezier(0.2, 0, 0, 1)`. Respect `prefers-reduced-motion` (disable all but opacity).
- Live-updating numbers change with a 150ms crossfade, no counting animations.
- Exactly one ambient animation permitted at a time: the spinning sync icon during active
  transfers. Progress bars are determinate whenever byte totals are known.

---

## 3. Application shell & information architecture

### 3.1 Shell layout

```
┌──────┬──────────────────────────────────────────────────────────┐
│      │ TopBar (48px): breadcrumb · node scope pill · ⌘K search  │
│ Nav  │          · vault lock state · connection dot             │
│ rail ├──────────────────────────────────────────────────────────┤
│ 224px│                                                          │
│      │   Page content (max-width 1440px, centered, 24px gutter) │
│      │                                                          │
└──────┴──────────────────────────────────────────────────────────┘
```

**Nav rail** (`--bg-surface`, right border `--border-subtle`), top to bottom:

1. Wordmark block: `shield` icon + "Steward" + current node hostname in `text-xs`
   `--text-tertiary`.
2. Sections (icon 20px + label `text-sm`; active item gets `--accent-muted` bg,
   `--accent` 2px left bar, `--text-primary`):
   - **Fleet** `/` — home dashboard
   - **Data** `/data` — novel-data explorer + junk reclaim
   - **Repos** `/repos` — git board + git client
   - **Files** `/files` — raw file browser (child of Data conceptually, but promoted:
     browsing is frequent)
   - **Docker** `/docker`
   - **Vault** `/vault`
   - **Setup** `/setup` — convergence/facets
3. Spacer, then pinned bottom:
   - **Steward** `/steward` — self-management (version, update, logs, pairing, this node)
   - Theme toggle + collapse-rail button (collapsed rail = 56px, icons + tooltips).

Nav badges: small count pills on sections needing attention — Fleet shows at-risk count
(`--danger` pill), Repos shows dirty+unpushed count (`--warn`), Setup shows drifted-facet
count (`--warn`). Zero = no pill. This makes the rail itself a status summary.

**TopBar**, left to right:
- Breadcrumb (route path, `text-sm`, segments clickable).
- **Node scope pill**: `All nodes ▾` or `mira ▾`. Global filter — Data/Repos/Files/Docker
  list views re-scope to the selected node. Stored in URL as `?node=`.
- Search button showing `⌘K` kbd hint (opens command palette).
- Vault state: `lock` icon + "Locked" (tertiary) or `lock-open` + auto-lock countdown
  ("Unlocked · 9m") in `--warn` when < 2m.
- Connection dot: `--ok` "Live", `--warn` "Reconnecting…", `--danger` "Offline" — reflects
  this browser's WS to the local daemon.

### 3.2 Route table

```
/                       Fleet dashboard
/nodes/:nodeId          Node detail
/data                   Data overview (all nodes)
/data/sets/:setId       Dataset detail (a tracked root, e.g. ~/Code/foo)
/data/junk              Junk reclaim view
/files/:nodeId/*path    File browser
/repos                  Fleet git board
/repos/:nodeId/:repoId              Repo detail → default tab "changes"
/repos/:nodeId/:repoId/changes      Stage / diff / commit
/repos/:nodeId/:repoId/history      Log + commit detail
/repos/:nodeId/:repoId/branches     Branches + remotes
/docker                 Docker overview
/docker/:nodeId/containers/:id      Container detail (logs, inspect)
/vault                  Vault (locked → unlock screen; unlocked → item list)
/vault/items/:itemId    Item detail (route guarded by unlock state)
/setup                  Convergence matrix (facets × machines)
/setup/facets/:facetId  Facet definition + per-node drift
/setup/nodes/:nodeId    One machine's checklist
/steward                Self view: version, update, daemon log, pairing, identity
```

Deep-linkable state (selected file in a diff, filter chips, node scope) lives in query
params so URLs are shareable between your own machines.

---

## 4. Core components (shared vocabulary)

Built on Radix primitives + Tailwind; live in `ui/src/components/ui/`.

- **`StatusDot`** — 8px circle, colors from status tokens; `pulse` prop for in-progress
  (info) only.
- **`Badge`** — `text-2xs` uppercase pill, muted bg + status text color. Variants:
  `ok | warn | danger | info | neutral`.
- **`RedundancyBadge`** — the signature component. Shows `×N` copy count:
  `×1` danger, `×2` warn, `×3+` ok, `synced-cloud` adds a small `cloud` glyph (e.g. repo
  pushed to GitHub counts as a copy). Tooltip lists where each copy lives
  ("mira · vault-server · GitHub").
- **`NodeChip`** — hostname + OS icon + online dot; click navigates to node detail.
- **`StatCard`** — label (`text-2xs` uppercase), big number (`text-num`), delta caption.
- **`DataTable`** — TanStack Table: sticky header, column sort, `text-2xs` uppercase
  headers, 36px rows, hover `--bg-hover`, selected `--bg-active` + accent left bar.
  Right-aligned numeric columns, tabular figures. Virtualized past 200 rows
  (`@tanstack/react-virtual`).
- **`TreeList`** — file/dataset tree; 28px rows, chevron 16px, lazy-loads children.
- **`DiffView`** — unified by default, split toggle; mono 12px/18, line numbers in
  `--text-tertiary`, backgrounds from diff tokens, per-hunk header row (`--diff-hunk-bg`)
  with stage/discard buttons. Word-level intra-line highlight at 30% stronger bg.
- **`Drawer`** — right-side panel, 480px (640px for diffs), for detail-in-context; the
  list stays visible behind it. Preferred over navigation for "peek" actions.
- **`ConfirmDialog`** — destructive confirms; danger-filled confirm button; actions that
  delete data or force-push additionally require typing the target name.
- **`EmptyState`**, **`Skeleton`**, **`ErrorPanel`** — see §12.
- **`CommandPalette`** — see §11.
- **`Toast`** — bottom-right, max 3 stacked, auto-dismiss 5s except errors (sticky with
  "Details" link opening the relevant log).

---

## 5. Fleet dashboard (`/`) — the "is everything safe?" view

Answers safety in **under 3 seconds** via a strict top-to-bottom hierarchy: verdict →
what's at risk → who's serving it.

### Region A — Safety verdict (hero band)

Full-width card, 20px padding, thin left accent bar in the verdict color.

- **Left:** verdict line in `text-xl`:
  - All safe → `shield-check` in `--ok` + "Everything is safe." + caption
    "142 GB novel data · 3+ copies of everything · verified 4m ago".
  - Issues → `shield-alert` in `--danger`/`--warn` + "3 things need attention." No score
    numbers, no percentages — a count of actionable problems is more honest than "94%".
- **Right:** three inline `StatCard`s: **Novel data** (bytes + item count), **At risk**
  (bytes existing in <2 places; `--danger` when >0), **Reclaimable junk** (bytes; neutral;
  links to `/data/junk`).

### Region B — At-risk list (the queue)

Card titled "At risk — ranked by irreplaceability". `DataTable`, max 8 rows +
"View all in Data →".

Columns: item (icon: repo/dataset/vault), path (mono), node chips holding it,
`RedundancyBadge`, size, **risk reason** (plain-language: "Only copy · repo has no
remote", "Dirty for 12 days", "Unpushed 4 commits"), and a per-row primary action button
(**Back up now**, **Push**, **Add remote…**). Actions run inline with the row entering an
info "in progress" state (spinner replaces button, row stays put), then resolves: the row
fades out over 400ms when the item becomes safe.

**Ranking algorithm** (computed server-side, returned as `riskScore`):

```
riskScore = irreplaceability * exposure
irreplaceability: vault=100, repo novel work=80 (uncommitted 90), documents/media=70,
                  configs=40, unknown novel=60
exposure = copyDeficit * ageFactor * sizeFactor
  copyDeficit: copies=1 → 3.0, copies=2 → 1.0, else 0
  ageFactor:   1 + log10(days since last safe copy + 1)
  sizeFactor:  clamp(log10(bytes)/10, 0.5, 1.5)
```

Sorted descending; ties broken by bytes. The list shows the reasoning ("risk reason"), not
the number.

### Region C — Node health cards (grid)

Responsive grid (min card width 320px, `auto-fill`). One card per node:

```
┌─────────────────────────────────────────┐
│ ● mira            laptop · macOS 15     │  ← StatusDot + hostname + OS caption
│ Disk ▓▓▓▓▓▓▓░░ 412 / 994 GB             │  ← thin bar, --chart-1; --warn >85%, --danger >95%
│ Novel 96 GB · Junk 71 GB · Repos 214    │
│ ⚠ 2 at risk · ↻ syncing 1.2 GB → hub    │  ← status line, only if noteworthy
│ Steward v0.4.2 · seen just now          │
└─────────────────────────────────────────┘
```

- Online: normal. **Offline: card content at 55% opacity, StatusDot neutral, footer
  "last seen 2d ago" in `--warn` if >24h** — cooled, not hidden.
- Header ⋯ menu: Browse files, Open node detail, Sync now, Rename, Forget node (danger).
- Last card in grid: dashed-border "+ Add node" → pairing dialog (shows this node's short
  code + QR, and an input for a remote code).

### Region D — Activity feed (right column on ≥1280px, bottom otherwise)

Reverse-chron event list, 20 items, `text-xs`: "backed up `~/Code/aria` → vault-server
(2.1 GB)", "pushed `steward` main → origin", "node `deck` came online". Each row has a
timestamp and links to the object. Live-prepends via WS with a subtle 240ms slide-in.

---

## 6. Data view (`/data`)

### 6.1 Overview

- **Header strip:** segmented control `Novel | All | Junk` (default Novel) + node scope
  (inherits TopBar) + filter chips: `×1 copies`, `×2`, `>1 GB`, `untracked by git`,
  `stale >90d`.
- **Main table** of *datasets* — Steward's unit of tracked data (a root directory it has
  classified, e.g. one project dir under `~/Code`, `~/Documents`, a photo library).
  Columns: name, path (mono), classification `Badge` (`novel | derivable | junk | mixed`),
  size, `RedundancyBadge`, nodes holding copies (NodeChips, deduped), last-verified time,
  ⋯ menu (Back up to…, Verify checksums, Reclassify, Exclude).
- Clicking a row opens the **dataset Drawer**: classification rationale ("contains git
  repo with unpushed commits; 61% of bytes are `node_modules` → marked derivable"),
  copy-location list with per-copy checksum status and verify times, size treemap-lite
  (top 10 child dirs as horizontal bars, `--chart-1`), action buttons. "Open in Files" and
  "Open repo" cross-links when applicable.
- **Duplicate detection panel** (collapsible, above table, appears only when relevant):
  "5 near-duplicate project groups found" — groups directories with matching git origin or
  >90% content-hash overlap (the `aven-legacy copy 2` problem). Each group shows members
  ranked by freshness with a suggested keeper; actions: "Keep newest, junk the rest"
  (marks others reclaimable, never auto-deletes) or "Dismiss group".

### 6.2 Junk reclaim (`/data/junk`)

Layout: summary header + grouped table.

- Header: "**71.4 GB reclaimable on mira**" (`text-3xl`) + caption "All items are
  derivable — they can be rebuilt or re-downloaded." + primary button **Reclaim selected**.
- Table grouped by junk class with group subtotals and group-level checkboxes:
  `node_modules` (n dirs, size), build output (`dist/`, `target/`, `.next/`), caches,
  downloaded artifacts, duplicate datasets (from 6.1). Rows: checkbox, path (mono), size,
  last-touched, parent project link.
- Safety rules: rows inside a **dirty or unpushed repo's working tree** show a `--warn`
  shield-off glyph and are excluded from Select-all (still individually checkable with a
  confirm). Reclaim runs as a job with a determinate progress toast; finished items show
  in the activity feed. Deletions go to OS trash when available; the confirm dialog states
  which ("Moves 214 directories to Trash").

---

## 7. Repos view

### 7.1 Fleet git board (`/repos`)

The "what needs pushing?" screen.

- **Header:** stat strip — `212 repos · 9 dirty · 6 unpushed · 3 remote-less · 194 clean`;
  each stat is a click-to-filter chip. Search input (fuzzy on name/path). Sort: attention
  (default), name, last commit, size.
- **Attention sort:** remote-less+dirty → dirty → unpushed(ahead>0) → behind → clean;
  within a bucket, by staleness of dirtiness.
- **Table** columns:
  - name (repo icon + name, `text-sm` 500) with path caption below (mono `text-xs`)
  - node `NodeChip`
  - branch (mono, `git-branch` 14px)
  - **state cell** — the core glyph cluster: `● 3` dirty-file count (`--warn`),
    `↑4` ahead (`--info`), `↓2` behind (`--info`), `no remote` badge (`--danger`),
    `✓ clean` (`--ok`, tertiary text). Cluster order fixed: dirty, ahead, behind, remote.
  - last commit (relative time + subject, truncated, tooltip full)
  - `RedundancyBadge` (a pushed remote counts as a copy)
  - quick actions: **Push** (visible when ahead & remote exists), **Pull** (behind,
    fast-forwardable), ⋯ (Fetch, Open, Add remote…, Back up bare mirror)
- Clean repos render at reduced emphasis (name `--text-secondary`) so the eye lands on
  work.
- Row click → `/repos/:nodeId/:repoId/changes`.

### 7.2 Repo detail — full git client

Persistent **repo header** across tabs: repo name (`text-xl`) + node chip + path (mono) ·
branch switcher button (current branch, mono, chevron → branch popover) · sync cluster
(`↑`/`↓` counts + **Fetch / Pull / Push** buttons) · tabs: **Changes · History ·
Branches**. Push with no remote swaps the Push button for **Add remote…**.

#### Changes tab — three-pane (VS Code-style, web-native)

```
┌───────────────┬──────────────────────────────────────────────┐
│ Unstaged  (7) │                                              │
│  M src/a.ts   │            DiffView of selected file         │
│  ?? new.md    │   (unified default; split toggle; per-hunk   │
│ ─────────────│    [Stage hunk] [Discard hunk] buttons; drag  │
│ Staged    (2) │    or click line-number gutter to select     │
│  M src/b.ts   │    lines → [Stage lines])                    │
│ ─────────────│                                              │
│ Commit box    │                                              │
└───────────────┴──────────────────────────────────────────────┘
   300px file column          fluid diff column
```

- **File lists:** 28px rows: status letter (mono, colored: `M` warn, `A` ok, `D` danger,
  `??` info, `R` neutral), filename (mono), +/− line counts (`text-2xs`). Hover reveals
  row actions: stage/unstage (`arrow-down`/`arrow-up` between lists), discard
  (`undo-2`, confirm required). Section headers have **Stage all / Unstage all**. Keyboard:
  `j/k` move, `space` stage-toggle, `enter` focus diff.
- **Commit box** (bottom of left column): summary input (1 line, live counter turns
  `--warn` past 72 chars), optional body textarea (auto-grow, mono), amend checkbox,
  primary **Commit** button showing staged count ("Commit 2 files"); `⌘Enter` commits.
  After commit: toast "Committed `a1b2c3d`" with **Push** action button — the
  commit-then-push flow is two clicks total.
- Empty working tree → EmptyState in the left column: "Working tree clean" + last commit
  card + hint "Nothing to commit. `↑3` commits ready to push." with Push button when
  relevant.

#### History tab

- Left 40%: commit list — graph lane column (SVG, max 6 lanes, `--chart-*` colors), short
  hash (mono), subject, author avatar-less initials chip, relative date. Branch/tag refs
  as small mono badges on their commits. Infinite scroll (`git log` paginated 50).
- Right 60%: selected commit — full message, metadata, changed-file list; clicking a file
  shows its diff inline (reuses `DiffView`, read-only). Actions: copy hash, checkout
  (detached warning), revert…, create branch here.

#### Branches tab

Two tables: **Local** (name mono, upstream, ahead/behind cluster, last commit, ⋯: switch,
rename, merge into current…, delete — delete of unmerged requires typed confirm) and
**Remotes** (grouped by remote; remote header row shows URL (mono) + fetch time + ⋯:
edit URL, remove). Header buttons: **New branch…** (dialog: name + base ref), **Add
remote…** (name + URL). Switching branches with a dirty tree offers: stash & switch /
bring changes / cancel.

All git mutations stream their real command output into a collapsible mono footer strip
("Console") on the repo screen — Steward never hides what git actually said; errors expand
it automatically.

---

## 8. File browser (`/files/:nodeId/*path`)

- **Header:** node picker + breadcrumb path (segments clickable, editable on click-into as
  a mono text input) + view toggle (list/columns) + hidden-files toggle.
- **List view** (default): `DataTable` 32px rows — icon, name, size, modified,
  classification `Badge` (inherited from Data indexing: novel/derivable/junk), inline
  `RedundancyBadge` on dataset roots. Directories first, then files; natural sort.
- **Columns view:** Miller columns, 3 panes, for fast drill-down (keyboard `←/→`).
- **Right Drawer** on file select: preview (text ≤1MB syntax-highlighted via Shiki with
  the same token palette; images inline; else metadata only), checksum, copies list,
  actions: download, rename, move…, delete (trash, confirm), "Send to node…" (per-file
  sync → job toast).
- Directories inside a git repo show the repo's dirty markers on affected files (dot in
  `--warn` next to name) with an "Open repo" affordance in the breadcrumb.
- Remote nodes: listings fetched over the node channel; header shows "browsing **deck**"
  with the node's color-coded chip and a staleness caption; offline node → ErrorPanel with
  "last cached listing" option if index data exists.

---

## 9. Docker view (`/docker`)

- **Header stats:** containers running/total, images count + total size, reclaimable
  (dangling images + stopped containers) with **Prune…** button (confirm lists exactly
  what dies).
- **Tabs: Containers · Compose · Images · Volumes.** All tables scoped by TopBar node pill;
  "All nodes" adds a node column.
- **Containers table:** state dot (`--ok` running / neutral exited / `--danger`
  restarting-loop), name, node, image (mono, truncated tag), ports (mono, host→container),
  CPU% and Mem (live via WS, tabular, sparkline 30-sample), uptime, actions:
  start/stop/restart (icon buttons), ⋯ (logs, shell†, inspect, remove). †Shell is an
  xterm.js pane in a full-height Drawer, mono 12px on `--bg-sunken`.
- **Container detail** (`/docker/:nodeId/containers/:id`): header (name, state, image) +
  tabs **Logs** (follow-toggle, since-selector, search, ANSI colors mapped to the palette)
  · **Inspect** (pretty key/value tree + raw JSON toggle) · **Stats** (CPU/mem/net area
  charts, 5-min window, `--chart-*`).
- **Compose tab:** one card per compose project (name, node, file path mono, N services
  with per-service state dots, buttons **Up / Down / Restart / Pull & up**); expanding
  lists services as rows linking to their containers. Compose file viewable read-only
  (Shiki YAML) with "edit in repo" link when the file lives in a tracked repo.
- **Images:** repo:tag (mono), node, size, created, used-by count (0 = neutral "dangling"
  badge), actions: pull latest, remove. **Volumes:** name, node, size (if computable),
  used-by, remove (typed confirm if in use is impossible — button disabled with tooltip).

---

## 10. Vault (`/vault`)

### 10.1 Locked state (unlock flow)

Whole route renders a centered card (max-width 380px) on `--bg-base`:

- `lock` icon 32px `--text-tertiary`, title "Vault locked", caption "Master password never
  leaves this device."
- Password input (mono, reveal toggle) + **Unlock** primary button. Argon2id runs in a
  Web Worker (WASM); during derivation (~1s by design) the button shows an indeterminate
  spinner + "Deriving key…" — this delay is presented as intentional, not lag.
- Wrong password: input shakes 2px×2 (respecting reduced-motion → red flash instead),
  inline error "Incorrect master password", no attempt counter (local-only threat model),
  200ms input lockout.
- Below the fold: "Auto-lock after **10 min** idle ▾" (5/10/30/never-this-session) and a
  tertiary "What is stored where?" link → explainer popover: items are ciphertext in
  SQLite, synced between nodes as ciphertext; the derived key lives only in page memory
  and is zeroed on lock.
- First-run variant: "Create your vault" — password + confirm, entropy meter, and an
  offered generated 6-word diceware passphrase (SECURITY.md §7.1). No recovery mechanism
  exists by design; the copy says so plainly ("There is no reset. Store this password.").

### 10.2 Unlocked — item list

Two-pane: 320px list column + detail pane.

- List column: search input (fuzzy, instant), type filter chips (`Login · Note · SSH key ·
  API token · Env file`), then item rows (36px): type icon, title, subtitle
  (username/host, `--text-secondary`), and a `RedundancyBadge` variant showing ciphertext
  sync state (`synced ×3` ok / `local only` danger). **+ New item** button pinned top.
- Detail pane (selected item): title (inline-editable), fields as label/value rows.
  Secret fields render as `••••••••` with reveal (eye) and copy buttons; **copy puts the
  secret on the clipboard and schedules a clear after 30s** (toast: "Copied — clears in
  30s" with countdown). Reveal auto-re-hides after 20s. TOTP fields show the live 6-digit
  code (mono `text-lg`) with a 30s radial-sweep ring in `--accent`. Field-level history
  ("previous password") in a collapsed section. Footer: created/modified times, "stored on
  N nodes", delete (typed confirm).
- Auto-lock: at T-60s a `--warn` toast offers "Stay unlocked"; on lock the route swaps to
  the unlock card and all decrypted state (including detail pane) is discarded from memory.

### 10.3 Generator

Slide-down panel from **+ New item** and via ⌘K "Generate password":
- Mode toggle **Characters | Passphrase**. Characters: length slider 8–64 (default 24),
  toggles for symbols/digits/ambiguous-exclusion. Passphrase: word count 3–8, separator
  select.
- Output box: mono `text-lg`, per-character coloring (digits `--info`, symbols `--warn`,
  letters primary) for verifiability; **Regenerate** (`dice-5` icon) and **Copy** buttons;
  entropy caption ("142 bits — excellent") with `Badge` coloring (ok ≥ 80, warn ≥ 60,
  danger below).

---

## 11. Setup / convergence view (`/setup`)

Mental model shown to the user: **"Your profile is the recipe; each machine either matches
it or has drift."**

### 11.1 Convergence matrix (landing)

- **Header:** "Profile: eric-default" + facet/node counts + primary **Converge all…**
  (per-node confirm) + **New facet…**.
- **Matrix table:** rows = facets (grouped by category: Shell, Editors, CLI tools, Apps,
  System prefs, Dotfiles, Keys), columns = machines (NodeChip headers). Cell states,
  rendered as 16px glyph + tooltip:
  - `✓` `--ok` in sync
  - `△` `--warn` **drifted** (machine differs from profile) — click → drift Drawer
  - `−` neutral not applicable (e.g. `launchd` facet on Linux; auto-derived from facet
    `platforms`)
  - `✕` `--danger` failed last apply — click → error + log
  - `○` `--text-tertiary` never applied
  - spinner `--info` applying now
- Column header click → `/setup/nodes/:nodeId` (that machine's checklist). Row click →
  facet detail.

### 11.2 Drift Drawer

Opens from any `△` cell. Contents: facet name + node, "expected vs actual" as a
`DiffView` (profile state on the left/red, machine state on the right/green — labeled
"Profile" / "On mira" to avoid git-diff confusion; unified with explicit labels), and
three actions: **Apply profile → machine** (primary), **Adopt machine's value into
profile** (updates the facet definition — this is how you *capture* config), **Ignore on
this machine** (adds a per-node exemption, shown as a small `slash` glyph thereafter).
Adopt is the key interaction: convergence is bidirectional capture, not just enforcement.

### 11.3 Per-machine checklist (`/setup/nodes/:nodeId`)

The "new laptop" screen: ordered checklist of applicable facets with state glyphs,
estimated actions ("installs 12 brew packages, writes 4 dotfiles, imports 2 SSH keys"),
and one primary **Converge this machine** button. Running convergence shows a live
step-by-step log pane (mono, `--bg-sunken`, auto-scroll with pin-to-bottom toggle); each
step gets ✓/✕ as it completes; failures don't halt subsequent independent facets. Finish
state summarizes: "31 applied · 2 failed · 1 skipped" with failure rows expanded.

### 11.4 Facet detail (`/setup/facets/:facetId`)

Definition card (its type: `brew | dotfile | defaults-write | script | file-sync`; its
declarative spec rendered as syntax-highlighted source with "edit in repo" — facets live
as files in the profile repo, stewarded like any repo), per-node status table, and change
history (git log of the facet file, reusing History components).

---

## 12. Empty, loading, and error states

Every list/detail screen must implement all four states; PRs adding a screen without them
are incomplete.

### Empty (first-run / no data)

`EmptyState` component: 24px icon (`--text-tertiary`), one-line headline, one-line body,
≤1 primary action. Never a blank pane. Canonical copy:

| Screen | Headline | Action |
|---|---|---|
| Fleet, 1 node | "Just this machine so far." | "Pair another node" |
| Data, unindexed | "Indexing your data…" (live progress: "38,412 files · 61 GB scanned") | — |
| Repos, none | "No git repos found under tracked roots." | "Add a tracked root" |
| Junk, clean | "No junk found. Tidy." (`--ok` sparkle icon — the one permitted moment of charm) | — |
| Vault, empty | "Your vault is empty." | "New item" |
| Docker, no daemon | "Docker isn't running on mira." | "How to install" link |
| Setup, no facets | "No facets yet. Capture this machine's config to start." | "Capture from this machine" |

### Loading

- **Skeletons, not spinners, for layout-known content**: gray-`--bg-hover` shimmer blocks
  matching final geometry (table = header + 8 rows; cards = title + 3 lines). Shimmer is
  a 1.6s opacity pulse, not a moving gradient.
- Spinners only for indeterminate *actions* (button-internal) and never larger than 20px.
- Show skeletons only if data isn't ready within **150ms** (avoid flash); after **5s**,
  add caption "Still loading from deck…" with the responsible node named.
- Cached-then-fresh: render cached data instantly at full opacity with a `text-xs`
  "updated 3m ago" caption; swap in place when fresh data lands (no flicker, no skeleton).

### Errors

- **Panel-scoped, never page-scoped** when possible: a failed card shows `ErrorPanel`
  (danger left-bar, `circle-alert`, one-line cause, "Retry" + "Details" expanding raw
  error in mono) while sibling panels stay live.
- Unreachable node: its data panels get the cooled treatment + "deck is unreachable —
  showing data from 14:32" banner (warn, not danger; danger is reserved for data-safety
  problems).
- WS lost: TopBar dot goes `--warn` "Reconnecting…" with exponential backoff (1s→30s
  cap); after 3 failures a slim top banner appears; on reconnect, full state resync (see
  §13) and the banner resolves with a brief `--ok` "Live" flash.
- Mutation failure: optimistic change rolls back visibly (row flashes `--danger-muted`
  once) + sticky error toast with the server's actual message and a "Retry" action.
- Route-level crash: React error boundary per route renders a centered panel with the
  error, "Reload view", and "Copy diagnostics" (version, route, stack) — never a white
  screen.

---

## 13. Interaction principles

### 13.1 Live updates over WebSocket

Single multiplexed WS at `/api/ws`, speaking the protocol defined in ARCHITECTURE.md
§6.3 (canonical). Envelope:

```ts
type WsMsg =
  | { t: "auth"; token: string }                       // client → server, first message
  | { t: "sub"; topics: string[]; since?: number }     // glob topics; since = event seq replay
  | { t: "unsub"; topics: string[] }
  | { t: "event"; seq: number; topic: string; payload: unknown }
  | { t: "err"; code: "AUTH_REQUIRED" | "SEQ_TOO_OLD" };
```

Topics follow the daemon's dot taxonomy (ARCHITECTURE §7): `job.*`, `scan.*`, `repo.*`,
`node.*`, `backup.*`, `redundancy.changed`, `vault.changed`, `system.*` — payloads carry
object ids, and the client filters/fans out to query keys. Job-tray state is driven by
`job.queued|started|progress|done|failed` events. The client (TanStack Query) fetches a
REST snapshot, reads its `X-Steward-Seq` header, then subscribes `since` that seq —
nothing is missed across reconnects; `SEQ_TOO_OLD` triggers a full refetch. Everything
on screen is live; there are **no refresh buttons anywhere in the app**.

### 13.2 Optimistic UI — tiered by risk

- **Tier 1 (instant, optimistic):** local metadata edits — rename, reclassify, filter
  prefs, vault item edits, stage/unstage. Applied to cache immediately, rolled back with
  the danger flash on failure.
- **Tier 2 (pending-state, not optimistic):** operations with real external effects —
  commit, push, container start/stop, backup, converge. The initiating control enters an
  inline pending state (spinner-in-button, row stays interactive elsewhere) and resolves
  from the `job` stream. Never fake success for these.
- **Tier 3 (confirmed + typed):** destructive/irreversible — discard hunks/files, delete
  unmerged branch, reclaim junk, remove volume, forget node, delete vault item.
  `ConfirmDialog`; the worst (forget node, delete unmerged branch, empty trash-bypass)
  require typing the name.
- All Tier-2/3 operations are **jobs**: they appear in a global job tray (TopBar `↻` icon
  with count pill when active; popover lists jobs with progress bars and per-job log
  expanders), survive navigation, and complete into the activity feed.

### 13.3 Command palette (⌘K)

Radix Dialog on `--bg-raised`, 560px wide, top-aligned at 20vh; `cmdk` library.

- **Sources**, fuzzy-matched and grouped: Navigation (all routes), Nodes ("browse deck"),
  Repos (all repos fleet-wide → their Changes tab), Datasets, Containers ("restart
  seed-web"), Vault items (title only while locked; selecting prompts unlock, then copies),
  Actions ("Sync now", "Back up …", "Lock vault", "Converge mira", "Generate password",
  "Toggle theme").
- Result rows: icon + title + right-aligned context (`text-xs`: node name / path) + kbd
  hint if bound. Enter runs; `⌘Enter` opens in background where meaningful (starts job
  without navigating).
- Recents-first when the query is empty. Palette is the primary power path; every palette
  action must also exist as a visible UI control (discoverability rule).

### 13.4 Keyboard

Global: `⌘K` palette, `g` then `f/d/r/o/v/s` go-to section (vim-style chords, shown in
palette footer), `?` shortcut overlay, `Esc` closes topmost layer. Lists: `j/k` or arrows,
`Enter` open, `space` select/stage. Diff: `n/p` next/prev hunk, `s` stage hunk. Focus is
always visible: 2px `--border-focus` ring, 2px offset, on every interactive element.

### 13.5 Copy & formatting rules

- Sentence case everywhere; no exclamation marks; no "please"; no blame ("Incorrect
  master password", not "You entered the wrong password").
- Bytes: binary-ish human units, one decimal max ("2.1 GB", "412 MB"); counts localized
  with thin-space thousands only past 10,000.
- Times: relative under 7 days ("4m ago", "2d ago"), absolute after ("Aug 11"); tooltip
  always shows the full ISO local timestamp. Durations in jobs: "1m 12s".
- Paths, hashes, branches, hostnames-in-tables: always mono. Hashes 7 chars, click-to-copy.

---

## 14. Frontend architecture & file layout

The UI lives at `ui/` in the repo (ARCHITECTURE.md §2), built to `dist/ui`:

```
ui/
  index.html
  vite.config.ts            # dev proxy → http://localhost:4777
  src/
    main.tsx                # router + QueryClient + WsProvider + ThemeProvider
    styles/tokens.css       # §2.1 custom properties
    styles/app.css          # Tailwind v4 @theme mapping tokens → utilities
    lib/
      api.ts                # typed fetch client (hono/client RPC types from daemon)
      ws.ts                 # WS singleton: sub/unsub, seq tracking, resync, job stream
      queries/              # TanStack Query hooks per domain (fleet.ts, repos.ts, …)
      format.ts             # bytes/time/count formatters (§13.5)
      keys.ts               # keyboard chord registry
    components/
      ui/                   # §4 primitives (Badge, StatusDot, DataTable, DiffView, …)
      shell/                # NavRail, TopBar, NodeScopePill, JobTray, CommandPalette
    routes/
      fleet/  (index.tsx, NodeCard.tsx, AtRiskTable.tsx, ActivityFeed.tsx)
      data/   (index.tsx, junk.tsx, DatasetDrawer.tsx, DuplicateGroups.tsx)
      files/  (browser.tsx, PreviewDrawer.tsx, MillerColumns.tsx)
      repos/  (board.tsx, repo/[changes|history|branches].tsx, CommitBox.tsx)
      docker/ (index.tsx, container.tsx, ComposeCard.tsx, LogPane.tsx)
      vault/  (index.tsx, Unlock.tsx, ItemDetail.tsx, Generator.tsx, vault.worker.ts)
      setup/  (matrix.tsx, node.tsx, facet.tsx, DriftDrawer.tsx)
      steward/(index.tsx, Pairing.tsx, DaemonLog.tsx)
```

Libraries (final): React 19, `react-router` (data routers), `@tanstack/react-query` +
`react-virtual` + `react-table`, Radix primitives, `cmdk`, `lucide-react`, Shiki
(singleton highlighter, custom theme from tokens), `xterm` (docker shell), libsodium
WASM (argon2id + XChaCha20, per SECURITY.md §2) in `vault.worker.ts`. No CSS-in-JS;
Tailwind utilities + the token sheet only. Charts are
hand-rolled SVG sparklines/bars using `--chart-*` (no chart library; nothing here needs
one).

State rules: server state lives exclusively in TanStack Query (WS-invalidated); UI state
(drawers, selection) in component state or URL params; the only global client stores are
`useVaultKey` (in-memory key material, zeroed on lock) and `useJobTray`.

---

## 15. Definition of "done" for any screen

1. Renders all four states (loading skeleton, empty, error, populated) — verified in a
   Storybook-style route `/dev/states` that forces each.
2. Live-updates from WS without refresh; survives WS reconnect with correct resync.
3. Fully keyboard-operable; visible focus; palette entries registered.
4. Dark and light themes; AA contrast; reduced-motion respected.
5. Every timestamped panel shows data age; every destructive action tiered per §13.2.
