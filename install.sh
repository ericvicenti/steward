#!/usr/bin/env bash
# Steward installer - usage:
#   curl -fsSL https://steward.sh/install | bash          (once hosted)
#   ./install.sh                                          (from a source checkout)
# Idempotent: safe to re-run; updates source, rebuilds, restarts the service.
set -euo pipefail

STEWARD_HOME="${STEWARD_HOME:-$HOME/.steward}"
STEWARD_REPO="${STEWARD_REPO:-}"
DEFAULT_REPO="https://github.com/ericvicenti/steward.git"
SRC="$STEWARD_HOME/src"
OS="$(uname -s)"

log() { printf '\033[1;36msteward\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31msteward\033[0m %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null || fail "git is required. On macOS: xcode-select --install; on Debian/Ubuntu: apt install git"
if [ "$OS" = "Linux" ] && ! command -v unzip >/dev/null && ! command -v bun >/dev/null; then
  fail "unzip is required to install bun. On Debian/Ubuntu: apt install unzip"
fi

# --- bun ---------------------------------------------------------------------
if ! command -v bun >/dev/null && [ ! -x "$HOME/.bun/bin/bun" ]; then
  log "installing bun..."
  curl -fsSL https://bun.sh/install | bash
fi
export PATH="$HOME/.bun/bin:$PATH"
BUN="$(command -v bun)"

# --- ffmpeg (media transcoding; non-fatal if it cannot be installed) --------
if [ -z "${STEWARD_TEST:-}" ] && ! command -v ffmpeg >/dev/null; then
  if [ "$OS" = "Darwin" ]; then
    if ! command -v brew >/dev/null; then
      for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
        [ -x "$b" ] && eval "$("$b" shellenv)" && break
      done
    fi
    if ! command -v brew >/dev/null; then
      log "installing Homebrew (needed for ffmpeg)..."
      NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
        || log "warning: Homebrew install failed; media transcoding will be disabled"
      for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
        [ -x "$b" ] && eval "$("$b" shellenv)" && break
      done
    fi
    if command -v brew >/dev/null; then
      log "installing ffmpeg via Homebrew..."
      brew install -q ffmpeg || log "warning: ffmpeg install failed; media transcoding will be disabled"
    fi
  elif [ "$OS" = "Linux" ]; then
    log "installing ffmpeg..."
    if command -v apt-get >/dev/null; then
      { sudo -n apt-get update -qq && sudo -n apt-get install -y -qq ffmpeg; } 2>/dev/null \
        || { [ "$(id -u)" = "0" ] && apt-get update -qq && apt-get install -y -qq ffmpeg; } \
        || log "warning: could not install ffmpeg (needs sudo); run: sudo apt install ffmpeg"
    elif command -v dnf >/dev/null; then
      sudo -n dnf install -y -q ffmpeg 2>/dev/null || log "warning: could not install ffmpeg; run: sudo dnf install ffmpeg"
    elif command -v apk >/dev/null; then
      apk add --no-progress ffmpeg 2>/dev/null || log "warning: could not install ffmpeg; run: apk add ffmpeg"
    else
      log "warning: unknown package manager; install ffmpeg manually for media transcoding"
    fi
  fi
fi

# --- source ------------------------------------------------------------------
mkdir -p "$STEWARD_HOME/bin"
if [ -d "$SRC/.git" ]; then
  log "updating source in $SRC..."
  git -C "$SRC" pull --ff-only || log "warning: could not fast-forward; keeping current source"
elif [ -n "$STEWARD_REPO" ]; then
  log "cloning $STEWARD_REPO..."
  git clone "$STEWARD_REPO" "$SRC"
elif [ -f "$(dirname "$0")/package.json" ] && grep -q '"name": "steward"' "$(dirname "$0")/package.json"; then
  # Running from a source checkout: clone it locally so the service owns its copy.
  local_src="$(cd "$(dirname "$0")" && pwd)"
  log "installing from local checkout ${local_src}"
  git clone "$local_src" "$SRC"
  git -C "$SRC" remote set-url origin "$local_src"
else
  # curl-piped install: pull from the public repo.
  log "cloning ${DEFAULT_REPO}"
  git clone "$DEFAULT_REPO" "$SRC"
fi

# --- build -------------------------------------------------------------------
log "installing dependencies and building UI..."
(cd "$SRC" && "$BUN" install --frozen-lockfile 2>/dev/null || "$BUN" install)
(cd "$SRC" && "$BUN" run build)

# --- CLI shim ----------------------------------------------------------------
cat > "$STEWARD_HOME/bin/steward" <<EOF
#!/usr/bin/env bash
exec "$BUN" run "$SRC/src/cli/steward.ts" "\$@"
EOF
chmod +x "$STEWARD_HOME/bin/steward"

# Test mode (STEWARD_TEST=1): stop before touching PATH, services, or the browser.
if [ -n "${STEWARD_TEST:-}" ]; then
  log "test mode: skipping PATH link, service registration, and browser open"
  exit 0
fi

for dir in "$HOME/.local/bin" /usr/local/bin; do
  if [ -d "$dir" ] && [ -w "$dir" ]; then
    ln -sf "$STEWARD_HOME/bin/steward" "$dir/steward" && break
  fi
done
command -v steward >/dev/null || log "add $STEWARD_HOME/bin to your PATH to use the 'steward' CLI"

# --- service -----------------------------------------------------------------
if [ "$OS" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/sh.steward.daemon.plist"
  mkdir -p "$HOME/Library/LaunchAgents" "$STEWARD_HOME/logs"
  sed -e "s|@BUN@|$BUN|g" -e "s|@SRC@|$SRC|g" -e "s|@HOME@|$STEWARD_HOME|g" \
    "$SRC/service/sh.steward.daemon.plist.tmpl" > "$PLIST"
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  log "launchd service installed (sh.steward.daemon)"
elif [ "$OS" = "Linux" ]; then
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR" "$STEWARD_HOME/logs"
  sed -e "s|@BUN@|$BUN|g" -e "s|@SRC@|$SRC|g" -e "s|@HOME@|$STEWARD_HOME|g" \
    "$SRC/service/steward.service.tmpl" > "$UNIT_DIR/steward.service"
  systemctl --user daemon-reload
  systemctl --user enable --now steward.service
  log "systemd user service installed (steward.service)"
else
  fail "unsupported OS: $OS"
fi

# --- open --------------------------------------------------------------------
sleep 1.5
"$STEWARD_HOME/bin/steward" open || true
log "done. UI: http://127.0.0.1:4777  .  CLI: steward status"
