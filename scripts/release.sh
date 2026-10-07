#!/usr/bin/env bash
#
# Build a production Aditor bundle and publish it as a GitHub release.
#
# Everything that can fail cheaply -- version agreement, tag availability, a
# clean pushed worktree, GitHub auth -- is checked before the Rust release
# build, which takes minutes. The release itself is created as a draft and
# flipped live only after every asset has uploaded, so a failed upload never
# leaves a published release with missing downloads.
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=scripts/toolchain.sh
source scripts/toolchain.sh

die() { echo "aditor: $*" >&2; exit 1; }
say() { echo "aditor: $*"; }

# --- Flags --------------------------------------------------------------
DRAFT=0
PRERELEASE=0
NOTES_FILE=""
SKIP_BUILD=0
ALLOW_DIRTY=0

usage() {
  cat <<'USAGE'
Usage: npm run release [-- <flags>]

  --draft         leave the release as a draft instead of publishing it
  --prerelease    mark the release as a prerelease
  --notes FILE    use FILE as the release body instead of the generated one
  --skip-build    reuse the existing bundle under src-tauri/target/release
  --allow-dirty   skip the clean-worktree check
  -h, --help      show this

Auth: uses `gh` when it is on PATH, otherwise the REST API with $GITHUB_TOKEN.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --draft)       DRAFT=1 ;;
    --prerelease)  PRERELEASE=1 ;;
    --notes)       NOTES_FILE="${2:-}"; [ -n "$NOTES_FILE" ] || die "--notes needs a file"; shift ;;
    --skip-build)  SKIP_BUILD=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    -h|--help)     usage; exit 0 ;;
    *)             usage >&2; die "unknown flag: $1" ;;
  esac
  shift
done

[ -z "$NOTES_FILE" ] || [ -f "$NOTES_FILE" ] || die "notes file not found: $NOTES_FILE"

command -v jq >/dev/null 2>&1 || die "jq not found (brew install jq)."

# --- Preflight: the three version fields must agree ---------------------
PKG_VERSION=$(jq -r '.version' package.json)
CONF_VERSION=$(jq -r '.version' src-tauri/tauri.conf.json)
CARGO_VERSION=$(awk '/^\[package\]/{p=1;next} /^\[/{p=0} p && /^version[[:space:]]*=/{gsub(/[",]/,"",$3); print $3; exit}' src-tauri/Cargo.toml)

if [ "$PKG_VERSION" != "$CONF_VERSION" ] || [ "$PKG_VERSION" != "$CARGO_VERSION" ]; then
  echo "aditor: version fields disagree -- bump all three before releasing:" >&2
  echo "  package.json               $PKG_VERSION" >&2
  echo "  src-tauri/tauri.conf.json  $CONF_VERSION" >&2
  echo "  src-tauri/Cargo.toml       $CARGO_VERSION" >&2
  exit 1
fi

VERSION="$PKG_VERSION"
TAG="v$VERSION"

# --- Preflight: where we are publishing to ------------------------------
REMOTE_URL=$(git remote get-url origin)
SLUG=$(printf '%s' "$REMOTE_URL" | sed -E 's#^git@[^:]+:##; s#^https?://[^/]+/##; s#\.git$##')
case "$SLUG" in
  */*) ;;
  *) die "could not parse a GitHub owner/repo out of origin: $REMOTE_URL" ;;
esac

# --- Preflight: clean worktree ------------------------------------------
if [ "$ALLOW_DIRTY" -eq 0 ] && [ -n "$(git status --porcelain)" ]; then
  die "working tree is dirty. Commit or stash first, or pass --allow-dirty."
fi

SHA=$(git rev-parse HEAD)
BRANCH=$(git rev-parse --abbrev-ref HEAD)

# One fetch covers both remote checks below. Its failure is the first sign of
# an unreachable origin (no SSH key, no network), so report it as such rather
# than letting a later check quietly read a stale ref.
git fetch --quiet --tags origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" \
  || die "could not reach origin ($REMOTE_URL). Check your network and SSH keys."

# --- Preflight: the tag must be free ------------------------------------
BUMP_HINT="Bump the version in package.json, src-tauri/tauri.conf.json and src-tauri/Cargo.toml."
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  die "tag $TAG already exists. $BUMP_HINT"
fi

# --- Preflight: HEAD must be on the remote ------------------------------
# GitHub creates the tag from a SHA, so it has to already have that commit.
git merge-base --is-ancestor "$SHA" "refs/remotes/origin/$BRANCH" \
  || die "HEAD ($(git rev-parse --short HEAD)) is not on origin/$BRANCH. Push first."

# --- Preflight: GitHub auth ---------------------------------------------
if command -v gh >/dev/null 2>&1; then
  BACKEND=gh
  gh auth status >/dev/null 2>&1 || die "gh is installed but not authenticated. Run: gh auth login"
else
  BACKEND=curl
  command -v curl >/dev/null 2>&1 || die "neither gh nor curl found."
  [ -n "${GITHUB_TOKEN:-}" ] \
    || die "gh is not installed and GITHUB_TOKEN is unset. Either 'brew install gh && gh auth login', or export a token with 'repo' scope."
fi

say "releasing $TAG ($SLUG) from $(git rev-parse --short HEAD) via $BACKEND"

# --- SetFile ------------------------------------------------------------
# Tauri's bundle_dmg.sh calls bare `SetFile` twice to set the disk image's
# volume icon. /usr/bin/SetFile is not the tool -- it is an Apple shim that
# forwards through whatever `xcode-select -p` points at, so when that is an
# Xcode too old for the running macOS the shim aborts (dlopen: Symbol not
# found: _XPCTypeBool, Xcode's CoreDevice expecting it in the OS's Mercury)
# and takes the whole DMG step down with it. The real binary shipped with the
# Command Line Tools is unaffected, so putting it first on PATH makes the bare
# call resolve to something that works.
CLT_BIN=/Library/Developer/CommandLineTools/usr/bin
if ! SetFile -h >/dev/null 2>&1; then
  if [ -x "$CLT_BIN/SetFile" ] && "$CLT_BIN/SetFile" -h >/dev/null 2>&1; then
    PATH="$CLT_BIN:$PATH"
    export PATH
    say "/usr/bin/SetFile is broken; using $CLT_BIN/SetFile so DMG packaging works."
  else
    say "warning: SetFile is broken and no working copy sits under the Command Line"
    say "         Tools -- expect DMG packaging to fail. See README.md."
  fi
fi

# --- Build --------------------------------------------------------------
BUNDLE=src-tauri/target/release/bundle
APP="$BUNDLE/macos/Aditor.app"

if [ "$SKIP_BUILD" -eq 0 ]; then
  say "installing dependencies (npm ci)"
  npm ci
  say "building (npm run tauri build)"
  npm run tauri build
else
  say "--skip-build: reusing $BUNDLE"
fi

[ -d "$APP" ] || die "no app bundle at $APP -- the build did not produce one."

# Nothing above clears the previous build, so check rather than assume: the
# bundle has to carry the version being released. A leftover .app fails here
# instead of being quietly shipped under the wrong tag.
APP_VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist" 2>/dev/null || true)
[ "$APP_VERSION" = "$VERSION" ] || die \
  "$APP is version ${APP_VERSION:-unknown}, not $VERSION -- it is left over from an earlier build. Move $BUNDLE aside, then re-run without --skip-build."

# A bundle signed only by the linker passes for a local build but reads as
# "damaged" once a download quarantines it, and no Gatekeeper prompt gets past
# that. Tauri signs the whole bundle ad-hoc via bundle.macOS.signingIdentity;
# refuse to ship anything whose signature does not hold up.
codesign --verify --deep --strict "$APP" 2>/dev/null \
  || die "$APP has an invalid code signature -- check bundle.macOS.signingIdentity in src-tauri/tauri.conf.json."

# --- Package ------------------------------------------------------------
case "$(uname -m)" in
  arm64) ARCH=aarch64 ;;   # match Tauri's own DMG naming
  *)     ARCH=$(uname -m) ;;
esac

# Left in place across runs on purpose. Only the assets collected below are
# ever uploaded, so anything stale sitting here is inert.
OUT=dist-release
mkdir -p "$OUT"

ZIP="$OUT/Aditor_${VERSION}_${ARCH}.zip"
say "packaging $ZIP"
# `ditto`, not `zip`: .app is a directory, and plain zip loses symlinks and
# resource forks.
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"

ASSETS=("$ZIP")

# Match the version in the filename: an older image still sitting in the
# bundle directory must not be mistaken for this build's.
DMG=$(ls -1 "$BUNDLE"/dmg/Aditor_"${VERSION}"_*.dmg 2>/dev/null | head -1 || true)
if [ -n "$DMG" ]; then
  cp "$DMG" "$OUT/"
  ASSETS+=("$OUT/$(basename "$DMG")")
  say "including $(basename "$DMG")"
else
  say "warning: no .dmg was produced -- shipping the zip only."
  say "         See 'If the DMG step fails' in README.md (SetFile / Command Line Tools)."
  STRAY=$(ls -d /Volumes/dmg.* 2>/dev/null | head -1 || true)
  [ -z "$STRAY" ] || say "         A stray image is still mounted: hdiutil detach '$STRAY' -force"
fi

# Checksum exactly the assets collected above -- not a glob, which would race
# with the file it is writing.
SUMS="$OUT/SHA256SUMS.txt"
sum_names=()
for asset in "${ASSETS[@]}"; do sum_names+=("$(basename "$asset")"); done
( cd "$OUT" && shasum -a 256 -- "${sum_names[@]}" > "$(basename "$SUMS")" )
ASSETS+=("$SUMS")

# --- Release notes ------------------------------------------------------
if [ -z "$NOTES_FILE" ]; then
  NOTES_FILE=$(mktemp -t aditor-release-notes)
  trap 'rm -f "$NOTES_FILE"' EXIT

  PREV=$(git describe --tags --abbrev=0 2>/dev/null || true)
  {
    echo "## Changes"
    echo
    if [ -n "$PREV" ]; then
      git log "$PREV..HEAD" --pretty='- %s'
    else
      git log --pretty='- %s'
    fi
    cat <<'NOTES'

## Installation

Apple Silicon (`aarch64`) only. Unzip and move `Aditor.app` into
`/Applications`.

Builds are ad-hoc signed and not notarized, so macOS blocks them on first
launch on any machine but the one that built them. Try to open the app once,
then approve it under System Settings > Privacy & Security > **Open Anyway**,
or clear the quarantine flag:

```bash
xattr -dr com.apple.quarantine /Applications/Aditor.app
```

Aditor needs the [`claude`](https://claude.com/claude-code) CLI on your `PATH`;
the main pane has nothing to run without it.
NOTES
  } > "$NOTES_FILE"
fi

# --- Publish ------------------------------------------------------------
# Always created as a draft and flipped live at the end, so a failed upload
# never leaves a published release with missing assets.
gh_api() {
  curl --fail-with-body -sS \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "$@"
}

say "creating draft release $TAG"

if [ "$BACKEND" = gh ]; then
  create_args=(release create "$TAG" --target "$SHA" --title "Aditor $VERSION" --notes-file "$NOTES_FILE" --draft)
  [ "$PRERELEASE" -eq 0 ] || create_args+=(--prerelease)
  gh "${create_args[@]}" >/dev/null

  for asset in "${ASSETS[@]}"; do
    say "uploading $(basename "$asset")"
    gh release upload "$TAG" "$asset" --clobber
  done

  if [ "$DRAFT" -eq 0 ]; then
    gh release edit "$TAG" --draft=false >/dev/null
  fi
  URL=$(gh release view "$TAG" --json url -q .url)
else
  body=$(jq -n \
    --arg tag "$TAG" \
    --arg sha "$SHA" \
    --arg name "Aditor $VERSION" \
    --rawfile notes "$NOTES_FILE" \
    --argjson pre "$PRERELEASE" \
    '{tag_name: $tag, target_commitish: $sha, name: $name, body: $notes, draft: true, prerelease: ($pre == 1)}')

  created=$(gh_api -X POST "https://api.github.com/repos/$SLUG/releases" -d "$body") \
    || die "creating the release failed: $created"

  RELEASE_ID=$(printf '%s' "$created" | jq -r '.id')
  UPLOAD_URL=$(printf '%s' "$created" | jq -r '.upload_url' | sed 's/{.*}$//')
  [ "$RELEASE_ID" != "null" ] || die "GitHub did not return a release id: $created"

  for asset in "${ASSETS[@]}"; do
    say "uploading $(basename "$asset")"
    out=$(gh_api -X POST \
      -H "Content-Type: application/octet-stream" \
      --data-binary "@$asset" \
      "$UPLOAD_URL?name=$(basename "$asset")") \
      || die "uploading $(basename "$asset") failed (the draft release was left in place): $out"
  done

  if [ "$DRAFT" -eq 0 ]; then
    published=$(gh_api -X PATCH "https://api.github.com/repos/$SLUG/releases/$RELEASE_ID" -d '{"draft": false}') \
      || die "publishing the release failed: $published"
    URL=$(printf '%s' "$published" | jq -r '.html_url')
  else
    URL=$(printf '%s' "$created" | jq -r '.html_url')
  fi
fi

git fetch --quiet --tags origin || true

if [ "$DRAFT" -eq 1 ]; then
  say "draft release ready -- publish it from the GitHub UI:"
else
  say "published $TAG:"
fi
echo "$URL"
