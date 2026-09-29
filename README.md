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
pane never spawns. `npm start` goes through `scripts/dev.sh`, which exists
because neither toolchain is reliably on `PATH` in a plain shell: it runs
`fnm use --install-if-missing` to honor `.node-version`, and finds `cargo` under
Homebrew's keg-only rustup prefix, which is not linked into `/opt/homebrew/bin`.
Both failures otherwise surface far from their cause.

If you do not use fnm, just make sure `node -v` is 22 or newer and `cargo` is on
your `PATH` before running `npm start`; the script checks both and tells you
which one is missing.

## Building a release

```bash
npm run tauri build
```

Output lands in `src-tauri/target/release/bundle/`: `macos/Aditor.app` and, when
DMG packaging succeeds, `dmg/Aditor_<version>_aarch64.dmg`.

To hand the app to someone else, zip the bundle rather than copying it raw --
`.app` is a directory, and a plain `zip` loses symlinks and resource forks:

```bash
ditto -c -k --sequesterRsrc --keepParent \
  src-tauri/target/release/bundle/macos/Aditor.app \
  Aditor-macos-arm64.zip
```

Builds are ad-hoc signed, not notarized, so macOS blocks them on first launch on
any machine but the one that built them. Recipients should right-click the app
and choose **Open**, or clear the quarantine flag:

```bash
xattr -dr com.apple.quarantine /Applications/Aditor.app
```

### If the DMG step fails

`bundle_dmg.sh` shells out to `SetFile` to set the volume icon. A mismatched
Xcode and Command Line Tools pair makes that abort:

```
dlopen(@rpath/libxcodebuildLoader.dylib): Symbol not found: _XPCTypeBool
xcode-select: Failed to locate 'SetFile'
```

The `.app` itself is already built and fine at that point -- only the disk image
is missing, so the zip above is a complete workaround. To actually fix it,
reinstall the Command Line Tools:

```bash
sudo rm -rf /Library/Developer/CommandLineTools
xcode-select --install
```

A failed run can also leave a disk image mounted. `ls /Volumes` will show a
stray `dmg.XXXXXX`; `hdiutil detach /Volumes/dmg.XXXXXX -force` clears it, and
the leftover `rw.*.dmg` under `bundle/macos/` is safe to delete.

## Layout

```
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
