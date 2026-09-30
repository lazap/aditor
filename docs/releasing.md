# Releasing

Maintainer notes. Building Aditor for yourself needs none of this -- see
[Build from source](../README.md#build-from-source) in the README. This file
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

The release is created as a draft either way and flipped live only once every
asset has uploaded, so a failed upload never leaves a published release with
missing downloads. Artifacts land in `dist-release/` and are attached to it:

- `Aditor_<version>_aarch64.zip` -- the `.app`, packed with `ditto` rather than
  `zip`, which would lose symlinks and resource forks
- `Aditor_<version>_aarch64.dmg` -- when DMG packaging succeeds (see below)
- `SHA256SUMS.txt`

Builds are ad-hoc signed, not notarized, so macOS blocks them on first launch
on any machine but the one that built them. The generated release notes carry
the unblock instructions for recipients -- see
[Install](../README.md#install).

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
