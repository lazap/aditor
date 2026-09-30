<h1 align="center">
  <img src="public/aditor.svg" width="72" height="72" alt=""><br>
  Aditor
</h1>

<p align="center">
  A lightweight editor whose main pane is an agent CLI.<br>
  <sub>macOS · Apple Silicon · <a href="LICENSE">MIT</a></sub>
</p>

<!-- Drop a window shot at docs/screenshot.png (⌘⇧4 then Space, over the
     Aditor window), then delete these two comment lines to show it. -->
<!--
<p align="center">
  <img src="docs/screenshot.png" alt="Aditor: the file tree on the left, a Claude Code session running in the main pane, and the current git diff below.">
</p>
-->

## What it is

Aditor wraps a coding agent running in a real PTY, and puts the things you
reach for mid-turn around it:

- the workspace **file tree**, gitignore-aware
- a read-only **file viewer** with syntax highlighting
- the current **git diff**, as a side-by-side view
- the agent's own **session history** and token spend
- a **switcher** for the Claude account it runs under

The agent is not a sidebar here. It is the main pane, and everything else exists
to answer the questions that come up while it works.

Only Claude Code is implemented today. `agent_sessions` in
`src-tauri/src/agents.rs` is the single dispatch point -- another agent is a new
arm there plus a reader module.

## Install

Grab the latest `.dmg` or `.zip` from
[Releases](https://github.com/lazap/aditor/releases), and drag `Aditor.app` into
`/Applications`.

Builds are ad-hoc signed and not notarized, so macOS blocks them on first
launch. Right-click the app and choose **Open**, or clear the quarantine flag:

```bash
xattr -dr com.apple.quarantine /Applications/Aditor.app
```

You also need the [`claude` CLI](https://claude.com/claude-code) on your `PATH`.
It is a genuine runtime dependency, not just a nice-to-have: the main pane has
nothing to run without it, and the sessions panel reads `~/.claude.json` and
`~/.claude/` directly, so it stays empty until you have used Claude Code at
least once in the project you open.

**macOS is the only platform this has been built and run on.** The bundle
targets say `all`, but nothing here has been exercised on Linux or Windows.
Account switching in `src-tauri/src/accounts.rs` is the least portable part: the
credential half is behind `cfg(target_os = "macos")` for the login Keychain and
`cfg(unix)` for the lock files, with no Windows arms at all.
Apple Silicon only for the prebuilt binaries; building from source on an Intel
Mac should work but is untested.

## Keyboard shortcuts

| | |
|---|---|
| <kbd>⌘</kbd><kbd>1</kbd> | Focus file tree |
| <kbd>⌘</kbd><kbd>2</kbd> | Focus agent |
| <kbd>⌘</kbd><kbd>⇧</kbd><kbd>A</kbd> | Next Claude Code account |
| <kbd>⌘</kbd><kbd>O</kbd> | Open project… |
| <kbd>⌘</kbd><kbd>,</kbd> | Keyboard shortcuts… |

Every one of these is rebindable from the shortcuts panel. Chords bound to the
app are held back from the agent; everything else goes straight through to the
terminal. `src/shortcuts/registry.ts` is the source of truth for both halves.

## Build from source

```bash
git clone https://github.com/lazap/aditor.git
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

### Requirements

| | |
|---|---|
| **Node ≥ 22** | `.node-version` pins 24.18.0. Vite 8's rolldown imports `styleText` from `node:util`, which landed in Node 22. |
| **Rust** | A stable toolchain, via [rustup](https://rustup.rs). |
| **Xcode Command Line Tools** | macOS, for linking: `xcode-select --install`. |
| **The `claude` CLI** | [Claude Code](https://claude.com/claude-code), on your `PATH`. |

To build a bundle without cutting a release, `npm run tauri build` works on its
own; output lands in `src-tauri/target/release/bundle/`.

<details>
<summary><b>If the build dies with "Failed to locate 'clang'"</b></summary>

An Xcode older than the running macOS cannot load its own libraries, so any
build script that shells out to `cc` fails. The standalone Command Line Tools
are healthy in this situation, so point the toolchain at those. Create
`src-tauri/.cargo/config.toml` -- it is gitignored, because the right value is
per-machine:

```toml
[env]
DEVELOPER_DIR = "/Library/Developer/CommandLineTools"
```

If linking then fails on an SDK instead -- `unknown architecture
arm64e.x1-macos`, `tapi error: malformed file` -- the toolchain has picked an
SDK newer than the clang reading it (an `SDKs/` directory can hold several).
Pin a known-good one alongside the first key:

```toml
[env]
DEVELOPER_DIR = "/Library/Developer/CommandLineTools"
SDKROOT = "/Library/Developer/CommandLineTools/SDKs/MacOSX26.sdk"
```

Updating Xcode to match your macOS fixes it properly. See also
[docs/releasing.md](docs/releasing.md#if-the-dmg-step-fails), where the same
Xcode mismatch breaks DMG packaging in a different way.

</details>

## How it works

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

## Contributing

Bug reports, ideas and patches are all welcome -- see
[CONTRIBUTING.md](CONTRIBUTING.md) for the dev loop and the conventions worth
knowing before you open a PR. Maintainer release steps live in
[docs/releasing.md](docs/releasing.md).

Found a security issue? Please report it privately -- see
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Lazar Petrov
