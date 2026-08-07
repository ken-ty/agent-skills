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

# Git Bash / MSYS2 / Cygwin run this script happily and then produce something
# that cannot work: `ln -s` there either copies or needs a privilege the user
# does not have (#32), and neither cmd.exe nor PowerShell reads the shebang, so
# the result is never executable as `agent-skills`. Send them to the PowerShell
# installer rather than leaving a broken link behind.
case "$(uname -s 2>/dev/null || echo unknown)" in
  MINGW*|MSYS*|CYGWIN*)
    echo "install: this is a Windows shell — symlinks and the shebang do not work here." >&2
    echo "  Use the PowerShell installer instead:" >&2
    echo >&2
    echo "    powershell -ExecutionPolicy Bypass -File install.ps1" >&2
    exit 1
    ;;
esac

if [ ! -f "$SRC" ]; then
  echo "install: $SRC not found — run from the repo root" >&2
  exit 1
fi

# Node version gate (same floor as scripts/run.js). Only ever a warning — the
# command itself re-checks and prints the full fix.
#
# Everything here has to survive a node that is on PATH but cannot run: a
# version manager with no version selected prints its own error and exits
# non-zero, and under `set -e` that would kill the install before a single
# symlink got made — leaving the user with an asdf/nvm message and no hint that
# this tool wanted Node >= 22.18. Probing must not be fatal.
if command -v node >/dev/null 2>&1; then
  NODE_V=$(node -p 'process.versions.node' 2>/dev/null || true)
  case "$NODE_V" in
    [0-9]*.[0-9]*)
      MAJOR=${NODE_V%%.*}
      NODE_REST=${NODE_V#*.}
      MINOR=${NODE_REST%%.*}
      if [ "$MAJOR" -lt 22 ] || { [ "$MAJOR" -eq 22 ] && [ "$MINOR" -lt 18 ]; }; then
        echo "install: warning — Node $NODE_V < 22.18; the command needs >= 22.18 to run." >&2
      fi
      ;;
    *)
      echo "install: warning — node is on PATH but would not report a version." >&2
      echo "  (a version manager with nothing selected does this). Needs Node >= 22.18." >&2
      ;;
  esac
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
