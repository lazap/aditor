#!/usr/bin/env bash
#
# Start Aditor in dev mode.
#
# Exists because neither toolchain is reliably on PATH in a plain shell:
# `node` may be an older default than .node-version pins, and Homebrew's rustup
# is keg-only so its cargo/rustc shims are not linked into the main bin dir.
# Both failures surface far from their cause -- a missing `styleText` export
# from deep inside rolldown, or "command not found: cargo" only after Vite has
# already started -- so resolve them up front and say so plainly.
set -euo pipefail
cd "$(dirname "$0")/.."

# --- Node ---------------------------------------------------------------
# Vite 8's rolldown imports node:util's styleText, which lands in Node 22.
if command -v fnm >/dev/null 2>&1; then
  eval "$(fnm env --shell bash)"
  fnm use --install-if-missing >/dev/null   # reads .node-version
fi

node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$node_major" -lt 22 ]; then
  echo "aditor: need Node >= 22 (.node-version pins $(cat .node-version)); found $(node -v 2>/dev/null || echo 'no node')." >&2
  exit 1
fi

# --- Rust ---------------------------------------------------------------
if ! command -v cargo >/dev/null 2>&1; then
  for dir in "$HOME/.cargo/bin" /opt/homebrew/opt/rustup/bin /usr/local/opt/rustup/bin; do
    if [ -x "$dir/cargo" ]; then
      PATH="$dir:$PATH"
      export PATH
      break
    fi
  done
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "aditor: cargo not found. With Homebrew's rustup it lives in \$(brew --prefix rustup)/bin, which is not linked into /opt/homebrew/bin." >&2
  exit 1
fi

echo "aditor: node $(node -v), $(cargo --version)"
exec npm run tauri dev -- "$@"
