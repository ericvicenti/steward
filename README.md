# 🛡️ Steward

Self-hosted fleet-and-data guardian. Steward runs as a background service on every machine
you own and makes sure all novel data is known, synced, and redundantly backed up — and that
every machine converges to your desired setup.

## Install (one line)

```sh
curl -fsSL https://steward.sh/install | bash   # once hosted
./install.sh                                   # from this checkout
```

This installs bun if needed, clones the source to `~/.steward/src`, builds the UI, registers
a launchd (macOS) or systemd (Linux) service, and opens the web UI at
`http://127.0.0.1:4777`.

## Develop

```sh
bun install
bun run dev        # daemon with hot reload on :4777
bun run dev:ui     # vite dev server for the UI (proxies /api to :4777)
bun run build      # build UI into dist/ui (daemon serves it)
```

## CLI

`steward status | open | scan | restart | stop | start | logs | update`

`steward update` pulls Steward's own source, rebuilds, and restarts the service —
Steward manages itself.

## Docs

Start at [docs/OVERVIEW.md](docs/OVERVIEW.md). The vision is in
[docs/BRIEF.md](docs/BRIEF.md), the milestone plan in [docs/ROADMAP.md](docs/ROADMAP.md).
