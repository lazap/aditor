#!/usr/bin/env bash
#
# Switch the app icon between the designs in src-tauri/icons/variants/.
#
#   npm run icon            list variants, marking the active one
#   npm run icon -- pair    make variants/pair.svg the app icon
#
# Renders the SVG to a 1024px PNG, runs `tauri icon` into a temp dir, and copies
# back only the files src-tauri/icons already has -- `tauri icon` also emits
# Android/iOS sets this desktop app doesn't ship.
set -euo pipefail
cd "$(dirname "$0")/.."

icons=src-tauri/icons
variants=$icons/variants
active_file=$variants/.active

if [ $# -eq 0 ]; then
  active=$(cat "$active_file" 2>/dev/null || true)
  for svg in "$variants"/*.svg; do
    name=$(basename "$svg" .svg)
    if [ "$name" = "$active" ]; then echo "* $name"; else echo "  $name"; fi
  done
  exit 0
fi

name=$1
svg=$variants/$name.svg
if [ ! -f "$svg" ]; then
  echo "aditor: no icon variant '$name' (see: npm run icon)" >&2
  exit 1
fi

# shellcheck source=scripts/toolchain.sh
source scripts/toolchain.sh

tmp=$(mktemp -d)
swift scripts/render-svg.swift "$svg" "$tmp/source.png" 1024
npx tauri icon "$tmp/source.png" --output "$tmp/out" >/dev/null 2>&1

for f in "$icons"/*.png "$icons"/icon.icns "$icons"/icon.ico; do
  cp "$tmp/out/$(basename "$f")" "$f"
done
echo "$name" > "$active_file"
echo "aditor: app icon is now '$name' (rebuild the app to see it)"
