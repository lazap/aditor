# Contributing to Aditor

Thanks for looking. Aditor is a small, opinionated app, so the most useful thing
you can do before writing code is open an issue and say what you are after --
especially for anything that adds a pane, a command, or a dependency.

## Before you start

**macOS is the only platform this has ever been built and run on.** Linux and
Windows patches are genuinely welcome, but be aware you are the first: nothing
is verified there, and `src-tauri/src/accounts.rs` has no Windows arms at all
(the credential half is behind `cfg(target_os = "macos")` for the login Keychain
and `cfg(unix)` for the lock files). Expect to do some discovery.

## Dev loop

```bash
npm install
npm start
```

`npm start`, not `npm run dev` -- `dev` is Vite alone, with no Tauri backend
behind it, so every command fails and the terminal pane never spawns. `npm start`
goes through `scripts/dev.sh`, which sources `scripts/toolchain.sh` because
neither toolchain is reliably on `PATH` in a plain shell: it runs
`fnm use --install-if-missing` to honor `.node-version`, and finds `cargo` under
Homebrew's keg-only rustup prefix, which is not linked into `/opt/homebrew/bin`.
Both failures otherwise surface far from their cause. `npm run release` sources
the same file.

If you do not use fnm, just make sure `node -v` is 22 or newer and `cargo` is on
your `PATH` before running `npm start`; the script checks both and tells you
which one is missing.

To build a bundle without cutting a release, `npm run tauri build` works on its
own; output lands in `src-tauri/target/release/bundle/`.

### Requirements

| | |
|---|---|
| **Node ≥ 22** | `.node-version` pins 24.18.0. Vite 8's rolldown imports `styleText` from `node:util`, which landed in Node 22. |
| **Rust** | A stable toolchain, via [rustup](https://rustup.rs). |
| **Xcode Command Line Tools** | macOS, for linking: `xcode-select --install`. |
| **The `claude` CLI** | [Claude Code](https://claude.com/claude-code), on your `PATH`. |

### If the build dies with "Failed to locate 'clang'"

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

Tests cover the Rust modules (`cargo test` from `src-tauri/`) and the pure
frontend modules (`npm test`, vitest). The UI itself has none, so changes there
are verified by running the app and exercising the pane you touched -- please
say in your PR what you actually clicked through.

## Before you open a PR

```bash
npm run build                        # tsc, then a production vite build
npm run lint                         # React hooks rules; warnings, not errors
npm test                             # frontend unit tests
cd src-tauri && cargo test           # backend unit tests
cd src-tauri && cargo clippy --all-targets -- -D warnings
```

`npm run build` is the typecheck -- `tsc` runs with the repo's strict settings
and a type error fails the build.

CI runs all of these on every push and pull request, and clippy warnings fail
it.

**Please do not run `cargo fmt`.** The Rust here is hand-formatted and is not
rustfmt-clean -- `cargo fmt` rewrites 5 of the 7 files in `src-tauri/src`, which
would bury your actual change in hundreds of lines of reflow. Match the style of
the code around you instead. (Adopting rustfmt wholesale is a reasonable idea,
but it is its own PR, and one that should touch nothing else.)

## How it works

```
scripts/              dev.sh, release.sh, and the toolchain.sh both source
src/                  React frontend
  components/         panes and pickers
  pty/ fs/ git/       typed wrappers over the Tauri commands
  agents/ accounts/ mcp/
  editor/             CodeMirror setup: languages, vim motions, line jumps
  shortcuts/          keybinding system
  settings/           the ~/.aditor/settings.json document, hydrated once
  templates/          prompt templates and their placeholders
src-tauri/src/
  pty.rs              agent processes, in their own process groups
  fs.rs               gitignore-aware listing, guarded reads, fs watcher
  git.rs              status and diffs via git2; writes via the git CLI
  agents.rs           session history, token counters and limits
  accounts.rs         account switching: login Keychain + ~/.claude.json
  mcp.rs              loopback MCP server behind the Tasks tab
  settings.rs         ~/.aditor/settings.json, as an opaque document
```

The Rust side spawns no subprocesses to gather agent state -- everything in
`agents.rs` is read from the agent's own on-disk files, so the panel can
refresh as often as the frontend likes. Its one network call is the Limits
refresh, made only when you click it. The MCP server listens on `127.0.0.1`
only, behind a per-launch bearer token that only agents Aditor spawned are
given.

Everything Aditor remembers is written to `~/.aditor/settings.json`, next to the
saved logins in `~/.aditor/accounts/`. Nothing lives in the webview's storage.
The file is treated as a suggestion: every field is checked on load and falls
back to its default, and a file that will not parse at all is moved to
`settings.json.bad` rather than stopping the app from opening.

## Conventions worth knowing

These are places where the codebase has a single source of truth, and adding a
second one is the main way a PR gets review comments:

- **A new keyboard shortcut is one row** in `COMMANDS` in
  `src/shortcuts/registry.ts` -- nothing else. That list drives dispatch
  (`useShortcuts`) *and* which chords `TerminalPane` holds back from the agent
  (via the store's `isReservedForApp`). There is no second place to register it.
- **A new setting is one field** in `Settings` and `DEFAULTS` in
  `src/settings/schema.ts`, read through `settings()` and written through
  `patch()`. The Rust side never learns what it is -- `settings.rs` reads and
  writes an opaque JSON document -- and nothing new goes into `localStorage`.
- **A new prompt template shipped with the app is one row** in
  `DEFAULT_TEMPLATES` in `src/templates/registry.ts`, plus a bump of
  `TEMPLATE_SEED` in the same commit. The bump is what folds it into the
  settings of people who already have the old set, without resurrecting the
  templates they deleted.
- **A new agent is a new arm** in `agent_sessions` in `src-tauri/src/agents.rs`,
  plus a reader module alongside it. `agents.rs` is the single dispatch point.
- **`git.rs` reads through `git2` and writes only through `run_git`**, behind
  `GIT_GATE`, with the git CLI. Never `--force` -- only `--force-with-lease`
  together with `--force-if-includes` -- and nothing that discards work without
  the user confirming it. The app should never be the reason someone loses
  work.
- **`agents.rs` reads the agent's own on-disk files.** No subprocesses to
  gather state, and no network calls on refresh -- the one request,
  `agent_refresh_limits`, is made only when the user asks for fresh limits.
  That is what makes the sessions panel cheap enough to refresh freely; keep
  new readers in the same shape.
- **New Tauri commands need a permission** in
  `src-tauri/capabilities/default.json`. Keep the set minimal -- add the one
  permission you need, not a wider default.
- **Frontend Tauri calls go through the typed wrappers** in `src/fs/api.ts`,
  `src/git/api.ts`, `src/pty/api.ts`, `src/agents/api.ts` and
  `src/accounts/api.ts`, rather than calling `invoke` from a component.
- **Comments explain why, not what.** The existing ones exist because something
  was surprising; match that bar rather than narrating the code.

## Commits and PRs

Keep commits focused and their messages in the imperative mood ("Add shortcuts
system"), matching the existing history. One logical change per PR, and please
describe how you verified it.

## Contributor License Agreement

Aditor is licensed under [GPL-3.0](LICENSE). Before a PR can be merged, you
need to agree to the Contributor License Agreement below, by ticking the CLA box
in the PR template. You agree once, and it covers every contribution you make
from then on.

In short: you keep the copyright to your work, and you give the maintainer the
right to use it under GPL-3.0 and under other licenses, including commercial
ones. That keeps Aditor's licensing in one place instead of split across every
contributor -- the same model Zed and most company-backed projects use.

### The agreement

1. **Definitions.** "You" means the person or legal entity submitting a
   Contribution. "Contribution" means any code, documentation or other material
   you submit to the Aditor project, through a pull request or otherwise.
   "Maintainer" means Lazar Petrov, the copyright holder of Aditor, and anyone
   the project is transferred to.
2. **You keep your copyright.** You remain the owner of your Contributions, and
   nothing here stops you from using them in any other way you like.
3. **Copyright license.** You grant the Maintainer a perpetual, worldwide,
   non-exclusive, royalty-free, irrevocable license to use, reproduce, modify,
   prepare derivative works of, publicly display, distribute and sublicense
   your Contributions, and to license them under any terms, including GPL-3.0,
   other open-source licenses and proprietary licenses.
4. **Patent license.** You grant the Maintainer, and everyone who receives
   Aditor, a perpetual, worldwide, non-exclusive, royalty-free, irrevocable
   license under any patents you can license that your Contribution would
   otherwise infringe, to make, use, sell and distribute the Contribution as
   part of Aditor or of work derived from it.
5. **You have the right to grant this.** Each Contribution is your original
   work, or you have the right to submit it under this agreement. If your
   employer or anyone else has rights to what you create, you have their
   permission to make the Contribution, or they have waived those rights. If a
   Contribution includes third-party material, you say so in the PR and name
   its license.
6. **No obligations.** The Maintainer is not required to use or merge any
   Contribution. You provide your Contributions "as is", with no warranty or
   obligation to support them.

## Code of Conduct

This project ships the [Contributor Covenant](CODE_OF_CONDUCT.md). By taking
part you agree to abide by it.
