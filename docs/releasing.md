# Releasing

Maintainer notes. Building Aditor for yourself needs none of this -- see
[Build from source](../README.md#build-from-source) in the README and
[CONTRIBUTING.md](../CONTRIBUTING.md#dev-loop). This file
covers cutting a tagged GitHub release with attached macOS artifacts.

## Cutting a release

```bash
npm run release
```

`scripts/release.sh` builds the production bundle and publishes it as a GitHub
release on `lazap/aditor`. Everything cheap is checked up front -- that
`package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` all carry
the same version, that `v<version>` is not already tagged, that the worktree is
clean and HEAD is pushed, and that GitHub auth works -- before minutes go into
the Rust release build.

Auth goes through `gh` when it is on your `PATH`, and otherwise through the REST
API with a `GITHUB_TOKEN` carrying `repo` scope:

```bash
brew install gh && gh auth login    # or:
export GITHUB_TOKEN=...
```

Bumping the version stays manual on purpose: edit the three version fields,
commit, push, then run the script. Flags go after `--`, so npm passes them
through:

| | |
|---|---|
| `--draft` | leave the release a draft instead of publishing it |
| `--prerelease` | mark it a prerelease |
| `--notes FILE` | use FILE as the body instead of the generated notes |
| `--skip-build` | reuse the existing bundle under `src-tauri/target/release` |
| `--allow-dirty` | skip the clean-worktree check |

```bash
npm run release -- --draft
```

### From GitHub Actions

`.github/workflows/release.yml` runs the same script on a clean macOS runner,
which sidesteps every local toolchain problem below. Bump and push the version
as above, then start it from the Actions tab or with:

```bash
gh workflow run release.yml                        # publish
gh workflow run release.yml -f draft=true          # or leave it a draft
```

It is manual rather than tag-triggered because the script creates the tag
itself and refuses to run when it already exists.

The release is created as a draft either way and flipped live only once every
asset has uploaded, so a failed upload never leaves a published release with
missing downloads. Artifacts land in `dist-release/` and are attached to it:

- `Aditor_<version>_aarch64.zip` -- the `.app`, packed with `ditto` rather than
  `zip`, which would lose symlinks and resource forks
- `Aditor_<version>_aarch64.dmg` -- when DMG packaging succeeds (see below)
- `Aditor_<version>_aarch64.app.tar.gz` and its `.sig` -- the self-updater's
  download (see [Self-update](#self-update))
- `SHA256SUMS.txt`
- `latest.json` -- the feed installed copies poll

Builds are ad-hoc signed, not notarized, so macOS blocks them on first launch
on any machine but the one that built them. The generated release notes carry
the unblock instructions for recipients -- see
[Install](../README.md#install).

The ad-hoc signature covers the whole bundle because `tauri.conf.json` sets
`bundle.macOS.signingIdentity` to `"-"`. Without it only the binary carries the
linker's signature, and a quarantined download reports itself as *damaged*
rather than unverified -- a state no Gatekeeper prompt gets past. The script
runs `codesign --verify --deep --strict` on the bundle and refuses to ship one
that fails.

### Self-update

Installed copies check
`https://github.com/lazap/aditor/releases/latest/download/latest.json` at
launch and every six hours, and offer the update in the project-tabs strip
(*Update to x.y.z*, then *Restart to update*). *Check for updates…* in the app
menu checks on demand. GitHub serves `latest/` from the newest release that is
neither a draft nor a prerelease, so prereleases are never offered.

That URL needs no auth, so it only works while `lazap/aditor` is public. While
the repo is private it answers 404: automatic checks stay quiet, and a manual
check reports the failure.

The updater installs only a tarball signed by the key whose public half is
`plugins.updater.pubkey` in `src-tauri/tauri.conf.json`. That key is separate
from Apple code signing and has no password:

- locally, `release.sh` reads it from `~/.tauri/aditor.key`, or from
  `TAURI_SIGNING_PRIVATE_KEY` when that is set
- in CI it is the `TAURI_SIGNING_PRIVATE_KEY` repository secret:

  ```bash
  gh secret set TAURI_SIGNING_PRIVATE_KEY -R lazap/aditor < ~/.tauri/aditor.key
  ```

Back the key up. If it is lost, a release signed with a new key cannot reach
installed copies through the updater. They have to install that release once
by hand or through brew.

The update replaces the `.app` wherever it runs from, and is downloaded by the
app rather than a browser, so it is never quarantined. Because builds are only
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

`release.sh` does that bump itself once the release is live, committing
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
packaging succeeds, `dmg/Aditor_<version>_aarch64.dmg`.

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

`npm run release` detects this and prepends that directory to `PATH` for the
build, so the bare `SetFile` call resolves to the working binary and the DMG
gets built. Nothing global changes. If you want the shims themselves fixed,
either update Xcode to match your macOS, or point them at the Command Line
Tools -- at the cost of anything that genuinely needs full Xcode:

```bash
sudo xcode-select -s /Library/Developer/CommandLineTools
```

Do not reinstall the Command Line Tools to fix this. They are not the problem,
and deleting them removes the one copy of `SetFile` that still works.

If DMG packaging fails for some other reason the `.app` is still built and
fine -- only the disk image is missing, and the zip is a complete substitute,
so `npm run release` warns and ships the zip alone rather than failing.

A failed run can also leave a disk image mounted. `ls /Volumes` will show a
stray `dmg.XXXXXX`; `hdiutil detach /Volumes/dmg.XXXXXX -force` clears it, and
the leftover `rw.*.dmg` under `bundle/macos/` is safe to delete.
