# Steward — agent notes

Bun + TypeScript daemon (Hono, bun:sqlite) with a React/Vite/Tailwind UI. No Node, no npm —
use `bun` for everything.

- `src/daemon/` — the service. Entry: `main.ts`. HTTP+WS on 127.0.0.1:4777, bearer-token
  auth (`~/.steward/token`). SQLite at `~/.steward/steward.db`.
- `src/daemon/indexer/` — fs/git scanning and risk scoring.
- `src/cli/steward.ts` — CLI; installed as a shim by `install.sh`.
- `ui/` — Vite root; builds to `dist/ui`, served by the daemon.
- `docs/` — the knowledgebase. `docs/BRIEF.md` is the authoritative vision;
  `docs/ARCHITECTURE.md` is canonical for schema/API; `docs/ROADMAP.md` tracks milestones.
  Keep docs in sync when changing schema or routes.

Verify changes with `bun run typecheck`, `bun run build`, and `bun run test`
(63+ tests: unit + API + PTY + a sandboxed install.sh run + Playwright e2e that boots a
real daemon and drives the built UI in headless Chromium — run `bun run build` first so
e2e tests the current UI). `bun run test:unit` is the fast subset.

Fleet nodes auto-update: each daemon checks origin hourly (and 90s after boot),
sweeps peers every 15 min, and nudges any node on a different commit to update
(`autoUpdate` in config; POST /api/system/update). A `git push` to main is a
fleet-wide deploy within the hour, or within ~30s of any UI being open.

Gotchas:
- bun:sqlite named params need `$`-prefixed keys at bind time.
- `~/Code` is itself a stray git repo; the scanner special-cases roots that contain `.git`.
- The installed service runs from `~/.steward/src` (a clone), not this checkout.
  Public repo: https://github.com/ericvicenti/steward — both this checkout and
  `~/.steward/src` track it as origin. Deploy = commit + `git push`, then
  `git -C ~/.steward/src pull && (cd ~/.steward/src && bun install && bun run build)
  && steward restart`. Servers install via the curl one-liner in README.md.
- Shell scripts must be pure ASCII (bash parses multibyte chars into variable names under
  `set -u`); tests/install.test.ts enforces this.
- node-pty does not work under Bun; the web terminal uses `bun-pty`.
- Playwright e2e needs `bunx playwright install chromium` once per machine.
