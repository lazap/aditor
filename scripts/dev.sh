#!/usr/bin/env bash
#
# Start Aditor in dev mode.
#
# The toolchain resolution this needs -- and why it needs it -- lives in
# scripts/toolchain.sh, shared with release.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=scripts/toolchain.sh
source scripts/toolchain.sh

echo "aditor: node $(node -v), $(cargo --version)"
exec npm run tauri dev -- "$@"
