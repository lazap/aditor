# Releasing

Maintainer notes. Building Aditor for yourself needs none of this -- see
[Build from source](../README.md#build-from-source) in the README and
[CONTRIBUTING.md](../CONTRIBUTING.md#dev-loop). This file covers cutting a
tagged GitHub release for macOS, Windows and Linux.

## Cutting a release

Bump the version in `package.json`, `src-tauri/tauri.conf.json` and
`src-tauri/Cargo.toml`, commit, push, then:

```bash
npm run release
```

Windows and Linux cannot be built from a Mac, so a release is always built by
`.github/workflows/release.yml`. `npm run release` checks everything cheap
first -- that the three version fields agree, that `v<version>` is not already
tagged, that the worktree is clean and HEAD is pushed, and that GitHub auth
works -- and then starts that workflow on the current branch. Starting it from
the Actions tab, or with `gh workflow run release.yml`, does the same without
the local checks.

Auth goes through `gh` when it is on your `PATH`, and otherwise through the REST
API with a `GITHUB_TOKEN` carrying `repo` scope:

```bash
brew install gh && gh auth login    # or:
export GITHUB_TOKEN=...
```

Flags go after `--`, so npm passes them through:

| | |
|---|---|
| `--draft` | leave the release a draft instead of publishing it |
| `--prerelease` | mark it a prerelease |
| `--allow-dirty` | skip the clean-worktree check |

```bash
npm run release -- --draft
gh workflow run release.yml -f draft=true          # the same, without the checks
```

It is manual rather than tag-triggered because the workflow creates the tag
itself and refuses to run when it already exists.

### The workflow

`scripts/release.sh` does the work, one stage per job:

1. **preflight**, on Linux: the checks above, plus that the updater key secret
   is set, before three builds start.
2. **build**, on macOS (Apple Silicon), Ubuntu 22.04 and Windows at once:
   builds and signs that platform's bundles and collects them in
   `dist-release/` under versioned names, with `assets-<os>.txt` listing them
   and `feed-<os>.json` holding that platform's part of `latest.json`. One
   failing stops the others: a release ships every platform or none.
3. **publish**, on Linux: merges the three, writes the notes, `latest.json` and
   `SHA256SUMS.txt`, creates the release as a draft, uploads everything,
   flips it live, and bumps the Homebrew cask.

Any stage runs on its own too, which is how to debug one:
`scripts/release.sh build` on a Mac builds and collects the macOS assets, and
`scripts/release.sh publish --dry-run` assembles the notes, checksums and
`latest.json` from whatever is in `dist-release/` and uploads nothing.
`--notes FILE` on `publish` replaces the generated notes.

The release is created as a draft either way and flipped live only once every
asset has uploaded, so a failed upload never leaves a published release with
missing downloads. It carries:

- `Aditor_<version>_aarch64.zip` -- the macOS `.app`, packed with `ditto`
  rather than `zip`, which would lose symlinks and resource forks
- `Aditor_<version>_aarch64.dmg` -- when DMG packaging succeeds (see below)
- `Aditor_<version>_aarch64.app.tar.gz` and its `.sig` -- macOS's self-update
- `Aditor_<version>_x64-setup.exe` and its `.sig` -- the Windows installer,
  which is also Windows' self-update
- `Aditor_<version>_amd64.AppImage` and `Aditor_<version>_amd64.deb`, each with
  a `.sig` -- each Linux package is also its own update
- `SHA256SUMS.txt`
- `latest.json` -- the feed installed copies poll

macOS builds are ad-hoc signed, not notarized, so macOS blocks them on first
launch on any machine but the one that built them. The Windows installer is not
code-signed, so SmartScreen stops it the first time. The generated release
notes carry the way past both -- see [Install](../README.md#install).

The ad-hoc signature covers the whole macOS bundle because `tauri.conf.json`
sets `bundle.macOS.signingIdentity` to `"-"`. Without it only the binary carries
the linker's signature, and a quarantined download reports itself as *damaged*
rather than unverified -- a state no Gatekeeper prompt gets past. The build
stage runs `codesign --verify --deep --strict` on the bundle and refuses to
ship one that fails.

### Self-update

Installed copies check
`https://github.com/lazap/aditor/releases/latest/download/latest.json` at
launch and every six hours, and offer the update in the project-tabs strip
(*Update to x.y.z*, then *Restart to update*). *Check for updates…* in the app
menu checks on demand. GitHub serves `latest/` from the newest release that is
neither a draft nor a prerelease, so prereleases are never offered.

Each copy looks itself up in `latest.json` as `<os>-<arch>-<bundle type>`, then
as `<os>-<arch>`, so the feed names every package that can update:
`darwin-aarch64`; `windows-x86_64` and `windows-x86_64-nsis`; `linux-x86_64`
and `linux-x86_64-appimage` for the AppImage, and `linux-x86_64-deb` for the
`.deb`. The AppImage replaces itself; the Windows installer runs quietly over
the installed copy; the `.deb` installs through `dpkg`, after a `pkexec`
password prompt.

That URL needs no auth, so it only works while `lazap/aditor` is public. While
the repo is private it answers 404: automatic checks stay quiet, and a manual
check reports the failure.

The updater installs only a tarball signed by the key whose public half is
`plugins.updater.pubkey` in `src-tauri/tauri.conf.json`. That key is separate
from Apple code signing and has no password:

- in CI it is the `TAURI_SIGNING_PRIVATE_KEY` repository secret, which every
  build job signs with:

  ```bash
  gh secret set TAURI_SIGNING_PRIVATE_KEY -R lazap/aditor < ~/.tauri/aditor.key
  ```
- `scripts/release.sh build` run by hand reads it from `~/.tauri/aditor.key`,
  or from `TAURI_SIGNING_PRIVATE_KEY` when that is set

Back the key up. If it is lost, a release signed with a new key cannot reach
installed copies through the updater. They have to install that release once
by hand or through brew.

On macOS the update replaces the `.app` wherever it runs from, and is
downloaded by the app rather than a browser, so it is never quarantined. Because builds are only
ad-hoc signed, macOS may ask again for permissions it already granted
(folders, notifications) after an update.

### Homebrew

A cask in a separate tap repo installs from these releases, so treat the zip as
a contract and change none of it without updating the cask:

- the asset is named `Aditor_<version>_aarch64.zip`, attached to tag
  `v<version>`
- it unpacks to `Aditor.app` at its root (`ditto --keepParent`)
- its hash is the matching line in `SHA256SUMS.txt`

The cask declares `auto_updates true`, since the app updates itself:
`brew upgrade` and `brew outdated` skip it unless given `--greedy`. Brew still
records the version it installed, so after a self-update `brew list --versions`
is behind the app; nothing acts on that. The cask's `version` and `sha256` are
still bumped for each release, since new installs come from it.

The publish stage does that bump itself once the release is live, committing
`Update aditor to <version>` to `Casks/aditor.rb` in `<owner>/homebrew-aditor`
through the GitHub API. Drafts and prereleases leave the cask alone. The token
needs push access to the tap:

- locally, your `gh` login (or `GITHUB_TOKEN`) usually has it already
- in CI, `github.token` is scoped to this repo only, so the step uses the
  `HOMEBREW_TAP_TOKEN` repository secret: a fine-grained token with
  *Contents: read and write* on `homebrew-aditor`

  ```bash
  gh secret set HOMEBREW_TAP_TOKEN -R lazap/aditor
  ```

If the bump fails, the release still stands. The script prints the `version`
and `sha256` to set by hand.

The cask points at the zip, not the DMG, because the DMG is optional -- a failed
`SetFile` ships the zip alone. Since builds are not notarized, the cask clears
the quarantine flag itself in a `postflight` step.

To build without releasing, `npm run tauri build` still works on its own. Output
lands in `src-tauri/target/release/bundle/`: `macos/Aditor.app` and, when DMG
packaging succeeds, `dmg/Aditor_<version>_aarch64.dmg`. CI's `bundle-linux` and
`bundle-windows` jobs build the AppImage, `.deb` and Windows installer on every
push to master, unsigned for the updater, as downloadable artifacts.

## If the DMG step fails

`bundle_dmg.sh` shells out to `SetFile` twice to set the volume icon, and both
calls abort:

```
dlopen(@rpath/libxcodebuildLoader.dylib): Symbol not found: _XPCTypeBool
  Referenced from: .../CoreDevice.framework/Versions/A/CoreDevice
  Expected in:     /Library/Apple/.../Mercury.framework/Versions/A/Mercury
```

`/usr/bin/SetFile` is not the tool -- it is one of Apple's shims that forwards
through whatever `xcode-select -p` points at. When that is an Xcode older than
the running macOS, the shim routes through `xcodebuild`, which crashes on a
symbol the OS no longer provides where Xcode expects it. The `SetFile` binary
under the Command Line Tools is untouched by this and runs fine:

```bash
xcode-select -p                                          # the broken Xcode
/Library/Developer/CommandLineTools/usr/bin/SetFile -h    # works
```

The macOS build stage detects this and prepends that directory to `PATH` for
the build, so the bare `SetFile` call resolves to the working binary and the
DMG gets built. Nothing global changes. If you want the shims themselves fixed,
either update Xcode to match your macOS, or point them at the Command Line
Tools -- at the cost of anything that genuinely needs full Xcode:

```bash
sudo xcode-select -s /Library/Developer/CommandLineTools
```

Do not reinstall the Command Line Tools to fix this. They are not the problem,
and deleting them removes the one copy of `SetFile` that still works.

If DMG packaging fails for some other reason the `.app` is still built and
fine -- only the disk image is missing, and the zip is a complete substitute,
so the build stage warns and ships the zip alone rather than failing.

A failed run can also leave a disk image mounted. `ls /Volumes` will show a
stray `dmg.XXXXXX`; `hdiutil detach /Volumes/dmg.XXXXXX -force` clears it, and
the leftover `rw.*.dmg` under `bundle/macos/` is safe to delete.
