# Security Policy

## Supported versions

Aditor is pre-1.0 and ships from `master`. Only the
[latest release](https://github.com/lazap/aditor/releases/latest) is supported;
fixes land there rather than being backported.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private reporting instead:
[**Report a vulnerability**](https://github.com/lazap/aditor/security/advisories/new)
(also reachable from the repository's *Security* tab). That opens a private
advisory visible only to you and the maintainers.

Please include what you were doing, what happened, and the Aditor and macOS
versions. A proof of concept helps but is not required to file.

This is a personal project maintained in spare time, so expect a first response
within about a week rather than within hours. You will be credited in the
advisory and release notes unless you would rather not be.

## What is in scope

Aditor runs on your machine and touches things worth guarding. The areas most
worth a look:

- **`src-tauri/src/accounts.rs`** -- account switching. It reads and writes the
  macOS login Keychain and splices identity fields into `~/.claude.json`. Any
  way to make it leak credentials, write to the wrong entry, or corrupt that
  file on an interrupted switch is in scope.
- **`src-tauri/src/pty.rs`** -- agent processes run in a real PTY in their own
  process groups. Escapes, unintended command execution, or orphaned processes
  holding a terminal are in scope.
- **`src-tauri/src/fs.rs`** -- directory listing and guarded reads. Path
  traversal out of the opened workspace, or reads that bypass the size and type
  guards, are in scope.
- **`src-tauri/capabilities/default.json`** -- the Tauri permission set. A
  command reachable from the frontend that should not be is in scope.

## What is not in scope

- **Unsigned, un-notarized builds.** Releases are ad-hoc signed only, so macOS
  Gatekeeper blocks them on first launch. This is a known and documented
  property of the project, not a vulnerability -- see
  [Install](README.md#install).
- **Vulnerabilities in the `claude` CLI itself**, or in Claude Code's on-disk
  format. Report those to
  [Anthropic](https://github.com/anthropics/claude-code/security).
- **Anything requiring an attacker who already has your user account.** Aditor
  is a local desktop app with no privilege boundary against the user running it.
- Upstream dependency advisories with no Aditor-specific impact. Feel free to
  open a normal issue for those.
