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
behind it, so every command fails and the terminal pane never spawns. See
[Build from source](README.md#build-from-source) for the toolchain details and
what to do when the build cannot find `clang`.

There is **no test suite yet**. Changes are verified by running the app and
exercising the pane you touched, so please say in your PR what you actually
clicked through.

## Before you open a PR

```bash
npm run build                        # tsc, then a production vite build
cd src-tauri && cargo clippy         # no *new* warnings, please
```

`npm run build` is the typecheck -- `tsc` runs with the repo's strict settings
and a type error fails the build.

`cargo clippy` currently reports two pre-existing warnings in the lib; leaving
those alone is fine, and fixing them in a PR of their own is welcome. Just do
not add more.

**Please do not run `cargo fmt`.** The Rust here is hand-formatted and is not
rustfmt-clean -- `cargo fmt` rewrites 5 of the 7 files in `src-tauri/src`, which
would bury your actual change in hundreds of lines of reflow. Match the style of
the code around you instead. (Adopting rustfmt wholesale is a reasonable idea,
but it is its own PR, and one that should touch nothing else.)

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
- **`git.rs` is read-only by design.** It reports status and diffs through
  `git2` and does not mutate the repository. Please keep it that way -- the app
  should never be the reason someone loses work.
- **`agents.rs` reads the agent's own on-disk files.** No network calls, no
  subprocesses to gather state. That is what makes the sessions panel cheap
  enough to refresh freely; keep new readers in the same shape.
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

## Code of Conduct

This project ships the [Contributor Covenant](CODE_OF_CONDUCT.md). By taking
part you agree to abide by it.
