<h1 align="center">
  <img src="public/aditor.svg" width="72" height="72" alt=""><br>
  Aditor
</h1>

<p align="center">
  <b>Where AI agents are first-class.</b><br>
  A lightweight editor with your coding agent in the main pane.<br>
  <sub>macOS · Apple Silicon · <a href="https://aditor.dev">aditor.dev</a> · <a href="LICENSE">GPL-3.0</a></sub>
</p>

<p align="center">
  <img src="docs/screenshot.png" alt="The Aditor window: file tree on the left, a Claude Code session in the middle, the Tasks panel on the right.">
</p>

Aditor runs your agent in a real terminal and puts what you reach for while it
works around it: the file tree, diffs, git, your dev server's output, and the
agent's own task list.

## Install

```bash
brew tap lazap/aditor
brew install --cask aditor
```

Or download the `.dmg` from [Releases](https://github.com/lazap/aditor/releases).
Builds aren't notarized, so a downloaded copy needs **Open Anyway** in System
Settings › Privacy & Security on first launch, or
`xattr -dr com.apple.quarantine /Applications/Aditor.app` (Homebrew handles this for you).
Aditor updates itself after that.

You also need the [`claude` CLI](https://claude.com/claude-code) on your `PATH`.

## Features

- **Real terminal**: the agent's own TUI, your shell, your `PATH`.
- **Sessions as tabs**: several agents per project, <kbd>⌘</kbd><kbd>1</kbd>–<kbd>⌘</kbd><kbd>9</kbd>.
- **Worktrees**: start a session on its own branch.
- **Live task list**: the agent's plan, ticked off as it works.
- **Questions and review**: the agent asks with real buttons and hands you diffs to approve.
- **Reads your runs**: dev server and test output, no pasting.
- **Git**: stage, commit, pull, push, log and blame, through your own `git`.
- **Diffs**: unified or side by side.
- **Clickable paths**: `src/a.ts:42` in the agent's output opens at that line.
- **Prompt templates**: <kbd>⌘</kbd><kbd>⇧</kbd><kbd>P</kbd>, with placeholders for the open file, branch and more.
- **Notifications**: a dot, a banner and a Dock badge when it's your turn.
- **Usage and cost**: tokens, cost and limits per session, plus an account switcher.

Works with **Claude Code** and **opencode**. Tasks, review, history and limits
are Claude Code only for now.

Shortcuts and the full list of agent tools are on the
[reference page](https://aditor.dev/reference/). Settings live in
`~/.aditor/settings.json`.

## Build from source

```bash
git clone https://github.com/lazap/aditor.git
cd aditor
npm install
npm start
```

Needs Node 22+, Rust, and the Xcode Command Line Tools. Use `npm start`, not
`npm run dev`: `dev` starts Vite alone, with no Tauri backend behind it.

Toolchain details, troubleshooting and a map of the source are in
[CONTRIBUTING.md](CONTRIBUTING.md).

## Contributing

Bug reports, ideas and patches are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).
Security issues go through [SECURITY.md](SECURITY.md).

## License

[GPL-3.0](LICENSE) © Lazar Petrov
