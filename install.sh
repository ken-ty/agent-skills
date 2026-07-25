#!/bin/sh
#
# Install the `agent-skills` command onto PATH by symlinking bin/ into
# ~/.local/bin. No npm install: the scripts run via Node's type stripping.
#
#   sh install.sh                 # links `agent-skills` and `skill`
#   BIN_DIR=~/bin sh install.sh   # choose a different PATH dir
#
# Idempotent. Re-run after moving the repo.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SRC="$SCRIPT_DIR/bin/agent-skills"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"

if [ ! -f "$SRC" ]; then
  echo "install: $SRC not found — run from the repo root" >&2
  exit 1
fi

# Node version gate (same floor as scripts/run.js). Only a warning here — the
# command itself re-checks and prints the full fix.
if command -v node >/dev/null 2>&1; then
  NODE_V=$(node -p 'process.versions.node')
  MAJOR=$(printf '%s' "$NODE_V" | cut -d. -f1)
  MINOR=$(printf '%s' "$NODE_V" | cut -d. -f2)
  if [ "$MAJOR" -lt 22 ] || { [ "$MAJOR" -eq 22 ] && [ "$MINOR" -lt 18 ]; }; then
    echo "install: warning — Node $NODE_V < 22.18; the command needs >= 22.18 to run." >&2
  fi
else
  echo "install: warning — node not found on PATH; install Node >= 22.18." >&2
fi

mkdir -p "$BIN_DIR"

link_one() {
  name="$1"
  dest="$BIN_DIR/$name"
  if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$SRC" ]; then
    echo "  ok    $dest -> $SRC"
    return
  fi
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    echo "  skip  $dest already exists (not created by this script) — remove it and re-run" >&2
    return
  fi
  ln -s "$SRC" "$dest"
  echo "  link  $dest -> $SRC"
}

echo "install: linking into $BIN_DIR"
link_one agent-skills
link_one skill

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo
    echo "note: $BIN_DIR is not on PATH. Add to your shell rc:"
    echo "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

echo
echo "Done. Try: agent-skills doctor  (or: skill doctor)"
