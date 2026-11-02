#!/usr/bin/env bash
#
# Release Aditor for macOS, Windows and Linux as one GitHub release.
#
# Three platforms means three machines, so the work comes in stages, which
# .github/workflows/release.yml runs in turn:
#
#   preflight  everything that can fail cheaply -- version agreement, a free
#              tag, a pushed HEAD, auth, the updater key -- before minutes go
#              into any build
#   build      this machine's bundles, signed for the updater and collected in
#              dist-release/ under versioned names, with the list of them and
#              the part of latest.json that points at them
#   publish    every platform's collected assets as one release: notes,
#              latest.json, checksums, a draft flipped live only once every
#              asset has uploaded, then the Homebrew cask
#
# Run locally without a stage, it does the preflight and starts the workflow:
# Windows and Linux cannot be built from a Mac.
set -euo pipefail
cd "$(dirname "$0")/.."

die() { echo "aditor: $*" >&2; exit 1; }
say() { echo "aditor: $*"; }

# --- Stage and flags ----------------------------------------------------
STAGE=dispatch
case "${1:-}" in
  preflight|build|publish) STAGE=$1; shift ;;
esac

DRAFT=0
PRERELEASE=0
NOTES_FILE=""
ALLOW_DIRTY=0
DRY_RUN=0

usage() {
  cat <<'USAGE'
Usage: npm run release [-- <flags>]                 preflight, then start the workflow
       scripts/release.sh preflight|build|publish   one stage, as the workflow runs it

  --draft         leave the release as a draft instead of publishing it
  --prerelease    mark the release as a prerelease
  --notes FILE    publish: use FILE as the release body instead of the generated one
  --allow-dirty   skip the clean-worktree check
  --dry-run       publish: assemble the notes, checksums and latest.json, upload nothing
  -h, --help      show this

Auth: uses `gh` when it is on PATH, otherwise the REST API with $GITHUB_TOKEN.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --draft)       DRAFT=1 ;;
    --prerelease)  PRERELEASE=1 ;;
    --notes)       NOTES_FILE="${2:-}"; [ -n "$NOTES_FILE" ] || die "--notes needs a file"; shift ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --dry-run)     DRY_RUN=1 ;;
    -h|--help)     usage; exit 0 ;;
    *)             usage >&2; die "unknown flag: $1" ;;
  esac
  shift
done

if [ -n "$NOTES_FILE" ]; then
  [ "$STAGE" = publish ] || die "--notes is for the publish stage; the workflow generates its own notes."
  [ -f "$NOTES_FILE" ] || die "notes file not found: $NOTES_FILE"
fi

command -v jq >/dev/null 2>&1 || die "jq not found (brew install jq)."

# --- The version, which all three fields must agree on ------------------
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

# Left in place across runs on purpose. Only the assets each build lists are
# ever uploaded, so anything stale sitting here is inert.
OUT=dist-release

# --- Where we are publishing to -----------------------------------------
REMOTE_URL=$(git remote get-url origin)
SLUG=$(printf '%s' "$REMOTE_URL" | sed -E 's#^git@[^:]+:##; s#^https?://[^/]+/##; s#\.git$##')
case "$SLUG" in
  */*) ;;
  *) die "could not parse a GitHub owner/repo out of origin: $REMOTE_URL" ;;
esac

SHA=$(git rev-parse HEAD)

# --- GitHub auth --------------------------------------------------------
auth() {
  if command -v gh >/dev/null 2>&1; then
    BACKEND=gh
    gh auth status >/dev/null 2>&1 || die "gh is installed but not authenticated. Run: gh auth login"
  else
    BACKEND=curl
    command -v curl >/dev/null 2>&1 || die "neither gh nor curl found."
    [ -n "${GITHUB_TOKEN:-}" ] \
      || die "gh is not installed and GITHUB_TOKEN is unset. Either 'brew install gh && gh auth login', or export a token with 'repo' scope."
  fi
}

gh_api() {
  curl --fail-with-body -sS \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "$@"
}

# `shasum` on macOS, `sha256sum` on Linux and in Git Bash; same output.
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum -- "$@"; else shasum -a 256 -- "$@"; fi
}

# ======================================================================
# preflight
# ======================================================================
preflight() {
  if [ "$ALLOW_DIRTY" -eq 0 ] && [ -n "$(git status --porcelain)" ]; then
    die "working tree is dirty. Commit or stash first, or pass --allow-dirty."
  fi

  BRANCH=$(git rev-parse --abbrev-ref HEAD)
  # A workflow checkout is a detached HEAD; it builds what it was started on.
  if [ "$BRANCH" != HEAD ]; then
    # One fetch covers both remote checks below. Its failure is the first sign
    # of an unreachable origin (no SSH key, no network), so report it as such
    # rather than letting a later check quietly read a stale ref.
    git fetch --quiet --tags origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" \
      || die "could not reach origin ($REMOTE_URL). Check your network and SSH keys."
    # GitHub creates the tag from a SHA, and the workflow builds what is on
    # GitHub, so it has to already have this commit.
    git merge-base --is-ancestor "$SHA" "refs/remotes/origin/$BRANCH" \
      || die "HEAD ($(git rev-parse --short HEAD)) is not on origin/$BRANCH. Push first."
  else
    git fetch --quiet --tags origin || die "could not reach origin ($REMOTE_URL)."
  fi

  if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
    die "tag $TAG already exists. Bump the version in package.json, src-tauri/tauri.conf.json and src-tauri/Cargo.toml."
  fi

  auth

  # In the workflow the updater key comes from a repository secret. Checked
  # here, so a missing one fails in seconds rather than after three builds.
  if [ "$STAGE" = preflight ] && [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
    die "TAURI_SIGNING_PRIVATE_KEY is empty -- set the repository secret. See docs/releasing.md."
  fi
  say "$TAG ($SLUG) from $(git rev-parse --short HEAD) is clear to release"
}

# ======================================================================
# dispatch: preflight here, build and publish in the workflow
# ======================================================================
dispatch() {
  preflight
  local ref
  ref=$(git rev-parse --abbrev-ref HEAD)
  [ "$ref" != HEAD ] || die "check out a branch to release from; the workflow runs on a branch."
  local draft=false prerelease=false
  [ "$DRAFT" -eq 0 ] || draft=true
  [ "$PRERELEASE" -eq 0 ] || prerelease=true

  say "starting the release workflow on $ref"
  if [ "$BACKEND" = gh ]; then
    gh workflow run release.yml -R "$SLUG" --ref "$ref" -f draft="$draft" -f prerelease="$prerelease"
    say "follow it with: gh run watch -R $SLUG \$(gh run list -R $SLUG -w release.yml -L 1 --json databaseId -q '.[0].databaseId')"
  else
    gh_api -X POST "https://api.github.com/repos/$SLUG/actions/workflows/release.yml/dispatches" \
      -d "$(jq -n --arg ref "$ref" --arg d "$draft" --arg p "$prerelease" \
        '{ref: $ref, inputs: {draft: $d, prerelease: $p}}')" >/dev/null \
      || die "could not start the workflow."
  fi
  echo "https://github.com/$SLUG/actions/workflows/release.yml"
}

# ======================================================================
# build: this machine's bundles
# ======================================================================

# The list of this platform's assets, and its part of latest.json.
ASSET_LIST=""
FEED_PART=""

collect() {
  cp "$1" "$OUT/"
  basename "$1" >> "$ASSET_LIST"
}

# feed KEY FILE: point the updater's KEY at FILE, which collect() has copied
# and which has a .sig beside it.
feed() {
  local name
  name=$(basename "$2")
  jq --arg key "$1" --arg file "$name" --rawfile sig "$OUT/$name.sig" \
    '. + {($key): {file: $file, signature: $sig}}' "$FEED_PART" > "$FEED_PART.tmp"
  mv "$FEED_PART.tmp" "$FEED_PART"
}

# The one bundle matching GLOB, with its .sig, or die naming what is missing.
# Matching the version in the name means a bundle left over from an earlier
# build cannot be shipped under this tag.
signed_bundle() {
  local found
  # shellcheck disable=SC2086
  found=$(ls -1 $1 2>/dev/null | head -1 || true)
  [ -n "$found" ] || die "no bundle matching $1 -- the build did not produce one."
  [ -f "$found.sig" ] || die "no updater signature at $found.sig -- check bundle.createUpdaterArtifacts in src-tauri/tauri.conf.json."
  printf '%s' "$found"
}

build() {
  # shellcheck source=scripts/toolchain.sh
  source scripts/toolchain.sh

  # `createUpdaterArtifacts` makes the build sign what the updater downloads,
  # and the app refuses an update whose signature does not match the pubkey in
  # tauri.conf.json -- so a missing key fails the build only after minutes of
  # compiling. The workflow passes the key in the environment; locally it is
  # read from the file `tauri signer generate` wrote. Losing that key means
  # shipping a release with a new pubkey, which installed copies cannot update
  # to by themselves.
  local key_file="$HOME/.tauri/aditor.key"
  if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
    [ -f "$key_file" ] \
      || die "no updater signing key: set TAURI_SIGNING_PRIVATE_KEY or put the key at $key_file. See docs/releasing.md."
    TAURI_SIGNING_PRIVATE_KEY=$(cat "$key_file")
  fi
  # The key has no password; unset, the build would stop to ask for one.
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD-}"
  export TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD

  local os arch bundles
  case "$(uname -s)" in
    Darwin)               os=darwin;  bundles=app,dmg ;;
    Linux)                os=linux;   bundles=appimage,deb ;;
    MINGW*|MSYS*|CYGWIN*) os=windows; bundles=nsis ;;
    *) die "cannot build releases on $(uname -s)" ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch=aarch64 ;;
    x86_64|amd64)  arch=x86_64 ;;
    *) die "cannot build releases for $(uname -m)" ;;
  esac

  mkdir -p "$OUT"
  ASSET_LIST="$OUT/assets-$os.txt"
  FEED_PART="$OUT/feed-$os.json"
  : > "$ASSET_LIST"
  echo '{}' > "$FEED_PART"

  [ "$os" != darwin ] || fix_setfile

  say "building $TAG for $os-$arch ($bundles)"
  npm ci
  npm run tauri build -- --bundles "$bundles"

  "package_$os" "$arch"
  say "collected for $os-$arch:"
  sed 's/^/  /' "$ASSET_LIST"
}

BUNDLE=src-tauri/target/release/bundle

# Tauri's bundle_dmg.sh calls bare `SetFile` twice to set the disk image's
# volume icon. /usr/bin/SetFile is not the tool -- it is an Apple shim that
# forwards through whatever `xcode-select -p` points at, so when that is an
# Xcode too old for the running macOS the shim aborts (dlopen: Symbol not
# found: _XPCTypeBool, Xcode's CoreDevice expecting it in the OS's Mercury)
# and takes the whole DMG step down with it. The real binary shipped with the
# Command Line Tools is unaffected, so putting it first on PATH makes the bare
# call resolve to something that works.
fix_setfile() {
  local clt=/Library/Developer/CommandLineTools/usr/bin
  if ! SetFile -h >/dev/null 2>&1; then
    if [ -x "$clt/SetFile" ] && "$clt/SetFile" -h >/dev/null 2>&1; then
      PATH="$clt:$PATH"
      export PATH
      say "/usr/bin/SetFile is broken; using $clt/SetFile so DMG packaging works."
    else
      say "warning: SetFile is broken and no working copy sits under the Command Line"
      say "         Tools -- expect DMG packaging to fail. See docs/releasing.md."
    fi
  fi
}

package_darwin() {
  local arch=$1
  local app="$BUNDLE/macos/Aditor.app"
  [ -d "$app" ] || die "no app bundle at $app -- the build did not produce one."

  # Nothing above clears the previous build, so check rather than assume: the
  # bundle has to carry the version being released.
  local app_version
  app_version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist" 2>/dev/null || true)
  [ "$app_version" = "$VERSION" ] || die \
    "$app is version ${app_version:-unknown}, not $VERSION -- it is left over from an earlier build. Move $BUNDLE aside and build again."

  # A bundle signed only by the linker passes for a local build but reads as
  # "damaged" once a download quarantines it, and no Gatekeeper prompt gets
  # past that. Tauri signs the whole bundle ad-hoc via
  # bundle.macOS.signingIdentity; refuse to ship anything whose signature does
  # not hold up.
  codesign --verify --deep --strict "$app" 2>/dev/null \
    || die "$app has an invalid code signature -- check bundle.macOS.signingIdentity in src-tauri/tauri.conf.json."

  # `ditto`, not `zip`: .app is a directory, and plain zip loses symlinks and
  # resource forks. The Homebrew cask installs from this zip.
  local zip="$OUT/Aditor_${VERSION}_${arch}.zip"
  say "packaging $zip"
  ditto -c -k --sequesterRsrc --keepParent "$app" "$zip"
  basename "$zip" >> "$ASSET_LIST"

  # The self-updater's download: the same .app as a tarball, and its
  # signature. Renamed to carry the version, like every other asset.
  local tar="$BUNDLE/macos/Aditor.app.tar.gz"
  [ -f "$tar" ] && [ -f "$tar.sig" ] \
    || die "no updater artifact at $tar(.sig) -- check bundle.createUpdaterArtifacts in src-tauri/tauri.conf.json."
  [ ! "$tar" -ot "$app/Contents/Info.plist" ] \
    || die "$tar is older than $app -- it is left over from an earlier build."
  local named="$OUT/Aditor_${VERSION}_${arch}.app.tar.gz"
  cp "$tar" "$named"
  cp "$tar.sig" "$named.sig"
  basename "$named" >> "$ASSET_LIST"
  basename "$named.sig" >> "$ASSET_LIST"
  feed "darwin-$arch" "$named"

  local dmg
  dmg=$(ls -1 "$BUNDLE"/dmg/Aditor_"${VERSION}"_*.dmg 2>/dev/null | head -1 || true)
  if [ -n "$dmg" ]; then
    collect "$dmg"
  else
    say "warning: no .dmg was produced -- shipping the zip only."
    say "         See 'If the DMG step fails' in docs/releasing.md (SetFile / Command Line Tools)."
    local stray
    stray=$(ls -d /Volumes/dmg.* 2>/dev/null | head -1 || true)
    [ -z "$stray" ] || say "         A stray image is still mounted: hdiutil detach '$stray' -force"
  fi
}

# The AppImage and the .deb each update themselves, so each gets a key of its
# own -- the updater looks for `linux-<arch>-<bundle type>` first. Plain
# `linux-<arch>` goes to the AppImage, for any copy that cannot tell.
package_linux() {
  local arch=$1 appimage deb
  appimage=$(signed_bundle "$BUNDLE/appimage/Aditor_${VERSION}_*.AppImage")
  deb=$(signed_bundle "$BUNDLE/deb/Aditor_${VERSION}_*.deb")
  for f in "$appimage" "$appimage.sig" "$deb" "$deb.sig"; do collect "$f"; done
  feed "linux-$arch" "$appimage"
  feed "linux-$arch-appimage" "$appimage"
  feed "linux-$arch-deb" "$deb"
}

package_windows() {
  local arch=$1 setup
  setup=$(signed_bundle "$BUNDLE/nsis/Aditor_${VERSION}_*-setup.exe")
  collect "$setup"
  collect "$setup.sig"
  feed "windows-$arch" "$setup"
  feed "windows-$arch-nsis" "$setup"
}

# ======================================================================
# publish: every platform's assets as one release
# ======================================================================
publish() {
  [ "$DRY_RUN" -eq 1 ] || auth
  git fetch --quiet --tags origin || true
  if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
    [ "$DRY_RUN" -eq 1 ] || die "tag $TAG already exists -- another release got there first."
    say "warning: tag $TAG already exists; a real publish would stop here."
  fi

  # Every platform, or none: a release missing one would leave that
  # platform's installed copies on the old version with no word why.
  local os
  for os in darwin linux windows; do
    [ -f "$OUT/assets-$os.txt" ] && [ -f "$OUT/feed-$os.json" ] \
      || die "no $os build in $OUT -- every platform has to be built before publishing."
  done

  local assets=() name
  for os in darwin linux windows; do
    while IFS= read -r name; do
      [ -n "$name" ] || continue
      [ -f "$OUT/$name" ] || die "$name is listed for $os but missing from $OUT."
      assets+=("$OUT/$name")
    done < "$OUT/assets-$os.txt"
  done

  # Checksum exactly the assets collected -- not a glob, which would race
  # with the file it is writing.
  local sums="$OUT/SHA256SUMS.txt" sum_names=() asset
  for asset in "${assets[@]}"; do sum_names+=("$(basename "$asset")"); done
  ( cd "$OUT" && sha256 "${sum_names[@]}" > "$(basename "$sums")" )
  assets+=("$sums")

  local zip="$OUT/Aditor_${VERSION}_aarch64.zip"
  local setup appimage deb
  setup=$(basename "$(ls -1 "$OUT"/Aditor_"${VERSION}"_*-setup.exe | head -1)")
  appimage=$(basename "$(ls -1 "$OUT"/Aditor_"${VERSION}"_*.AppImage | head -1)")
  deb=$(basename "$(ls -1 "$OUT"/Aditor_"${VERSION}"_*.deb | head -1)")

  # --- Release notes ----------------------------------------------------
  local prev changes feed_notes
  prev=$(git describe --tags --abbrev=0 2>/dev/null || true)
  if [ -n "$prev" ]; then
    changes=$(git log "$prev..HEAD" --pretty='- %s')
  else
    changes=$(git log --pretty='- %s')
  fi

  if [ -z "$NOTES_FILE" ]; then
    NOTES_FILE=$(mktemp)
    trap 'rm -f "$NOTES_FILE"' EXIT
    # The release body adds install steps, which mean nothing in-app.
    feed_notes="$changes"
    release_notes "$changes" "$setup" "$appimage" "$deb" > "$NOTES_FILE"
  else
    feed_notes=$(cat "$NOTES_FILE")
  fi

  # --- Updater feed -----------------------------------------------------
  # The app polls releases/latest/download/latest.json, which GitHub resolves
  # to the newest release that is neither a draft nor a prerelease -- so a
  # prerelease is never offered to installed copies. The app shows `notes`
  # before installing: --notes FILE as given, otherwise just the change list.
  local feed="$OUT/latest.json"
  jq -s \
    --arg version "$VERSION" \
    --arg notes "$feed_notes" \
    --arg date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg base "https://github.com/$SLUG/releases/download/$TAG/" \
    '{version: $version, notes: $notes, pub_date: $date,
      platforms: (add | map_values({signature, url: ($base + .file)}))}' \
    "$OUT/feed-darwin.json" "$OUT/feed-linux.json" "$OUT/feed-windows.json" > "$feed"
  assets+=("$feed")

  if [ "$DRY_RUN" -eq 1 ]; then
    say "dry run: would release $TAG with"
    for asset in "${assets[@]}"; do echo "  $(basename "$asset")"; done
    say "notes:"
    sed 's/^/  | /' "$NOTES_FILE"
    say "latest.json:"
    jq . "$feed"
    return
  fi

  # --- Publish ----------------------------------------------------------
  # Always created as a draft and flipped live at the end, so a failed upload
  # never leaves a published release with missing assets.
  say "creating draft release $TAG"
  local url
  if [ "$BACKEND" = gh ]; then
    local create_args=(release create "$TAG" --target "$SHA" --title "Aditor $VERSION" --notes-file "$NOTES_FILE" --draft)
    [ "$PRERELEASE" -eq 0 ] || create_args+=(--prerelease)
    gh "${create_args[@]}" >/dev/null

    for asset in "${assets[@]}"; do
      say "uploading $(basename "$asset")"
      gh release upload "$TAG" "$asset" --clobber
    done

    if [ "$DRAFT" -eq 0 ]; then
      gh release edit "$TAG" --draft=false >/dev/null
    fi
    url=$(gh release view "$TAG" --json url -q .url)
  else
    local body created release_id upload_url out published
    body=$(jq -n \
      --arg tag "$TAG" \
      --arg sha "$SHA" \
      --arg name "Aditor $VERSION" \
      --rawfile notes "$NOTES_FILE" \
      --argjson pre "$PRERELEASE" \
      '{tag_name: $tag, target_commitish: $sha, name: $name, body: $notes, draft: true, prerelease: ($pre == 1)}')

    created=$(gh_api -X POST "https://api.github.com/repos/$SLUG/releases" -d "$body") \
      || die "creating the release failed: $created"

    release_id=$(printf '%s' "$created" | jq -r '.id')
    upload_url=$(printf '%s' "$created" | jq -r '.upload_url' | sed 's/{.*}$//')
    [ "$release_id" != "null" ] || die "GitHub did not return a release id: $created"

    for asset in "${assets[@]}"; do
      say "uploading $(basename "$asset")"
      out=$(gh_api -X POST \
        -H "Content-Type: application/octet-stream" \
        --data-binary "@$asset" \
        "$upload_url?name=$(basename "$asset")") \
        || die "uploading $(basename "$asset") failed (the draft release was left in place): $out"
    done

    if [ "$DRAFT" -eq 0 ]; then
      published=$(gh_api -X PATCH "https://api.github.com/repos/$SLUG/releases/$release_id" -d '{"draft": false}') \
        || die "publishing the release failed: $published"
      url=$(printf '%s' "$published" | jq -r '.html_url')
    else
      url=$(printf '%s' "$created" | jq -r '.html_url')
    fi
  fi

  git fetch --quiet --tags origin || true

  local zip_sha
  zip_sha=$(sha256 "$zip" | cut -d' ' -f1)
  if [ "$DRAFT" -eq 1 ] || [ "$PRERELEASE" -eq 1 ]; then
    say "not a live release, so the Homebrew cask stays as it is"
  elif ! bump_cask "$zip_sha"; then
    say "warning: could not bump the Homebrew cask. Set version \"$VERSION\" and"
    say "         sha256 \"$zip_sha\" in Casks/aditor.rb by hand. See docs/releasing.md."
  fi

  if [ "$DRAFT" -eq 1 ]; then
    say "draft release ready -- publish it from the GitHub UI:"
  else
    say "published $TAG:"
  fi
  echo "$url"
}

# release_notes CHANGES SETUP APPIMAGE DEB
release_notes() {
  cat <<NOTES
## Changes

$1

## Installation

Aditor needs the [\`claude\`](https://claude.com/claude-code) CLI on your
\`PATH\`; the main pane has nothing to run without it. Every build below
updates itself after that.

### macOS (Apple Silicon)

With [Homebrew](https://brew.sh):

\`\`\`bash
brew tap ${SLUG%%/*}/aditor
brew install --cask aditor
\`\`\`

The cask clears the quarantine flag after installing, so the app opens without
a Gatekeeper prompt.

Or unzip \`Aditor_${VERSION}_aarch64.zip\` (or open the \`.dmg\`) and move
\`Aditor.app\` into \`/Applications\`. Builds are ad-hoc signed and not
notarized, so macOS blocks a downloaded copy on first launch. Try to open the
app once, then approve it under System Settings > Privacy & Security >
**Open Anyway**, or clear the quarantine flag:

\`\`\`bash
xattr -dr com.apple.quarantine /Applications/Aditor.app
\`\`\`

### Windows (x64)

Run \`$2\`. It installs for your user only, with no administrator prompt.
The installer is not code-signed, so SmartScreen stops it the first time:
choose **More info**, then **Run anyway**.

### Linux (x64)

Needs WebKitGTK 4.1: Ubuntu 22.04, Debian 12, Fedora 36 or newer.

- **AppImage**: \`chmod +x $3\` and run it. It updates itself in place.
- **Debian and Ubuntu**: \`sudo apt install ./$4\`. Updates install
  through the same package, after an administrator password prompt.
NOTES
}

# --- Homebrew cask ------------------------------------------------------
# The cask in the tap repo pins one version and the zip's hash, and new brew
# installs come from it, so it is bumped for every live release. A draft or a
# prerelease is not what `brew install` should get, so those leave it alone.
# Written through the contents API rather than a checkout, so it runs the same
# in CI. The release is already public by now: a failure here only warns.
#
# The default token (gh's login, or GITHUB_TOKEN) has to be able to push to the
# tap. CI's github.token cannot reach another repo, so CI passes a separate
# HOMEBREW_TAP_TOKEN.
TAP="${SLUG%%/*}/homebrew-aditor"
CASK_PATH=Casks/aditor.rb

# tap_api METHOD PATH [BODY]
tap_api() {
  if [ "$BACKEND" = gh ]; then
    local token="${HOMEBREW_TAP_TOKEN:-${GH_TOKEN:-}}"
    if [ -n "${3:-}" ]; then
      printf '%s' "$3" | GH_TOKEN="$token" gh api -X "$1" "$2" --input -
    else
      GH_TOKEN="$token" gh api -X "$1" "$2"
    fi
  else
    local data=()
    [ -z "${3:-}" ] || data=(--data-binary "$3")
    GITHUB_TOKEN="${HOMEBREW_TAP_TOKEN:-$GITHUB_TOKEN}" \
      gh_api -X "$1" ${data[@]+"${data[@]}"} "https://api.github.com/$2"
  fi
}

# Every step returns on failure by hand: called as an `if` condition, the
# function runs with `set -e` suspended.
bump_cask() {
  local zip_sha=$1 current blob old new body
  current=$(tap_api GET "repos/$TAP/contents/$CASK_PATH") || return 1
  blob=$(printf '%s' "$current" | jq -r '.sha')
  old=$(printf '%s' "$current" | jq -r '.content' | tr -d '\n' | base64 --decode) || return 1
  new=$(printf '%s\n' "$old" | sed -E \
    -e "s/^(  version )\"[^\"]*\"/\\1\"$VERSION\"/" \
    -e "s/^(  sha256 )\"[^\"]*\"/\\1\"$zip_sha\"/")
  # Both lines must have been there to rewrite; a cask reshaped by hand would
  # otherwise get a half-applied bump.
  printf '%s\n' "$new" | grep -q "^  version \"$VERSION\"$" || return 1
  printf '%s\n' "$new" | grep -q "^  sha256 \"$zip_sha\"$" || return 1
  if [ "$new" = "$old" ]; then
    say "the cask in $TAP is already at $VERSION"
    return 0
  fi
  body=$(jq -n \
    --arg message "Update aditor to $VERSION" \
    --arg content "$(printf '%s\n' "$new" | base64 | tr -d '\n')" \
    --arg sha "$blob" \
    '{message: $message, content: $content, sha: $sha}')
  tap_api PUT "repos/$TAP/contents/$CASK_PATH" "$body" >/dev/null || return 1
  say "bumped the cask in $TAP to $VERSION"
}

"$STAGE"
