# Aditor

A lightweight editor whose main pane is an agent CLI.

Aditor wraps a coding agent running in a real PTY, and puts the things you
reach for mid-turn around it: the workspace file tree, a read-only file viewer,
the current git diff, the agent's own session history and token spend, and a
switcher for the Claude account it runs under.

Only Claude Code is implemented today. `agent_sessions` in `src-tauri/src/agents.rs`
is the single dispatch point -- another agent is a new arm there plus a reader
module.

## Requirements

| | |
|---|---|
| **Node ≥ 22** | `.node-version` pins 24.18.0. Vite 8's rolldown imports `styleText` from `node:util`, which landed in Node 22. |
| **Rust** | A stable toolchain, via [rustup](https://rustup.rs). |
| **Xcode Command Line Tools** | macOS, for linking: `xcode-select --install`. |
| **The `claude` CLI** | [Claude Code](https://claude.com/claude-code), on your `PATH`. |

Claude Code is a genuine runtime dependency, not just a nice-to-have: the main
pane has nothing to run without it, and the sessions panel reads `~/.claude.json`
and `~/.claude/` directly, so it stays empty until you have used Claude Code at
least once in the project you open.

**macOS is the only platform this has been built and run on.** The bundle
targets say `all`, but nothing here has been exercised on Linux or Windows.
Account switching in `src-tauri/src/accounts.rs` is the least portable part: the
credential half is behind `cfg(target_os = "macos")` for the login Keychain and
`cfg(unix)` for the lock files, with no Windows arms at all.
Apple Silicon only for the prebuilt binaries; building from source on an Intel
Mac should work but is untested.

## Running it

```bash
git clone git@github.com:lazap/aditor.git
cd aditor
npm install
npm start
```

Use `npm start`, not `npm run dev`. `dev` starts Vite alone, which gives you the
frontend with no Tauri backend behind it -- every command fails and the terminal
pane never spawns. `npm start` goes through `scripts/dev.sh`, which sources
`scripts/toolchain.sh` because neither toolchain is reliably on `PATH` in a
plain shell: it runs `fnm use --install-if-missing` to honor `.node-version`,
and finds `cargo` under Homebrew's keg-only rustup prefix, which is not linked
into `/opt/homebrew/bin`. Both failures otherwise surface far from their cause.
`npm run release` sources the same file.

If you do not use fnm, just make sure `node -v` is 22 or newer and `cargo` is on
your `PATH` before running `npm start`; the script checks both and tells you
which one is missing.

## Building a release

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
- `Aditor_<version>_aarch64.dmg` -- only when DMG packaging succeeded (see below)
- `SHA256SUMS.txt`

Builds are ad-hoc signed, not notarized, so macOS blocks them on first launch on
any machine but the one that built them. The generated release notes tell
recipients to right-click the app and choose **Open**, or to clear the
quarantine flag:

```bash
xattr -dr com.apple.quarantine /Applications/Aditor.app
```

To build without releasing, `npm run tauri build` still works on its own. Output
lands in `src-tauri/target/release/bundle/`: `macos/Aditor.app` and, when DMG
packaging succeeds, `dmg/Aditor_<version>_aarch64.dmg`.

### If the DMG step fails

`bundle_dmg.sh` shells out to `SetFile` to set the volume icon. A mismatched
Xcode and Command Line Tools pair makes that abort:

```
dlopen(@rpath/libxcodebuildLoader.dylib): Symbol not found: _XPCTypeBool
xcode-select: Failed to locate 'SetFile'
```

The `.app` itself is already built and fine at that point -- only the disk image
is missing, so the zip is a complete substitute; `npm run release` warns and
ships the zip alone rather than failing. To actually fix it, reinstall the
Command Line Tools:

```bash
sudo rm -rf /Library/Developer/CommandLineTools
xcode-select --install
```

A failed run can also leave a disk image mounted. `ls /Volumes` will show a
stray `dmg.XXXXXX`; `hdiutil detach /Volumes/dmg.XXXXXX -force` clears it, and
the leftover `rw.*.dmg` under `bundle/macos/` is safe to delete.

## Layout

```
scripts/              dev.sh, release.sh, and the toolchain.sh both source
src/                  React frontend
  components/         panes and pickers
  pty/ fs/ git/       typed wrappers over the Tauri commands
  agents/ accounts/
  shortcuts/          keybinding system
src-tauri/src/
  pty.rs              agent processes, in their own process groups
  fs.rs               gitignore-aware listing, guarded reads, fs watcher
  git.rs              status and diffs via git2; read-only by design
  agents.rs           session history and token counters, read off disk
  accounts.rs         account switching: login Keychain + ~/.claude.json
```

The Rust side makes no network calls and spawns no subprocesses to gather agent
state -- everything in `agents.rs` is read from the agent's own on-disk files,
so the panel can refresh as often as the frontend likes.
