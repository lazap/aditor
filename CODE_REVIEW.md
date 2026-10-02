# Aditor code review

Reviewed at `2adc1c4` on 2026-10-02. Review only: no source files were changed.

Fixes for Critical, High and Medium items were applied afterwards; each finding carries a **Status** line. Low items and Questions were not worked on.

## 1. Summary

Aditor is a Tauri 2 desktop app with a React 19 / TypeScript 6 / Vite 8 frontend (`src/`) and a Rust backend (`src-tauri/src/`). The backend has about 5.4k lines across eight modules:

- `pty.rs` runs agents in a PTY.
- `fs.rs` handles workspace reads, writes and the file watcher.
- `git.rs` and `git_log.rs` read through git2 and write through the git CLI.
- `agents.rs` parses transcripts and calls the limits endpoint.
- `accounts.rs` swaps Keychain credentials and the `~/.claude.json` identity.
- `mcp.rs` is a loopback MCP server.
- `settings.rs` stores `~/.aditor/settings.json` as an opaque JSON document.

Every window loads the same page. `?view=` picks the editor, settings, templates, diff or log view, and windows talk to each other through Tauri events.

**Overall health is good for a pre-1.0 personal project.** The code is careful and its comments explain why each choice was made. The fs boundary in `fs.rs` is sound, and the credential handling shows real thought. `tsc` is clean, `npm audit` reports 0 vulnerabilities, all 40 Rust unit tests pass, and clippy shows only the 2 warnings `CONTRIBUTING.md` already lists.

The main risks fall into four areas:

- **Blocking or racy IPC around the terminal.** `pty_write` blocks the main thread. Output and exit events can arrive before the frontend is listening.
- **Write paths with no conflict or failure handling.** Autosave overwrites concurrent agent edits. A failed account switch leaves state that a retry turns into a lost token. `--force-with-lease` is weakened by the app's own Fetch.
- **Two gaps in the workspace boundary.** `git_diff` does a lexical path check only. `pty_spawn` runs any command it is given, with CSP turned off.
- **Avoidable work on the main thread on every watcher tick.**

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 7 |
| Medium | 17 |
| Low | 13 |

What was run: `npx tsc --noEmit` (clean), `npm audit` (0 vulnerabilities), `npm outdated`, `cargo test` (40 passed), `cargo clippy --all-targets` (2 known warnings) and `cargo update --dry-run`. `cargo audit` and `cargo outdated` are not installed on this machine, so the Rust crates were **not** checked against the advisory database.

---

## 2. Findings

### High

#### H1. `pty_write` can freeze the whole app, and blocks every other session while it waits
`src-tauri/src/pty.rs:355-366`

**Status:** Fixed (5acbc38). Each session has a writer thread fed by a channel; `pty_write` only enqueues.

**What's wrong.** `pty_write` is a synchronous command, so on macOS it runs on the AppKit main thread. It also holds the global `sessions` mutex while it runs `write_all` against a blocking PTY master fd. Once the tty input queue is full, the write blocks until the child process reads. A child that isn't reading never drains the queue. Examples: a `sleep 100` or a stopped job in a Terminal session, or an agent stuck in synchronous work.

**Why it matters.** Pasting a large block into a busy session freezes the webview, including every terminal and every window. Because the mutex is held, `pty_kill`, `pty_resize` and writes to every other session also block. Killing the stuck session from the UI is impossible, since the kill command can't take the lock either.

**Suggested fix.** Give each session a writer thread fed by an `mpsc` channel. `pty_write` then only enqueues and returns. This also keeps keystrokes in order, which matters if the command is ever made `async`.
```rust
// in PtySession: tx: std::sync::mpsc::Sender<Vec<u8>>
// spawn:  std::thread::spawn(move || for buf in rx { if writer.write_all(&buf).is_err() { break } });
#[tauri::command]
pub fn pty_write(registry: State<'_, Arc<PtyRegistry>>, id: String, bytes: String) -> Result<(), String> {
    let data = B64.decode(bytes).map_err(|e| format!("bad base64: {e}"))?;
    let sessions = registry.sessions.lock().unwrap();
    sessions.get(&id).ok_or("no such session")?.tx.send(data).map_err(|_| "session closed".into())
}
```

#### H2. Terminal output and the exit event can be lost between `pty_spawn` returning and the listeners attaching
`src/components/TerminalPane.tsx:125-157`, `src-tauri/src/pty.rs:299-352`

**Status:** Fixed (bec9847). Output and exit go over a `tauri::ipc::Channel` passed to `pty_spawn`.

**What's wrong.** The reader and ticker threads start inside `pty_spawn`, and the ticker flushes every 4 ms. The frontend only calls `listen("pty://output")` and `listen("pty://exit")` after `ptySpawn` resolves, and each `listen` is another IPC round trip. Anything emitted in that gap is dropped, because Tauri does not buffer events for listeners that don't exist yet.

**Why it matters.** A Terminal session whose shell starts quickly can lose its first prompt and show a blank pane until you press Enter. Login-shell output is lost too. Worse, a command that fails at once (for example, `claude` no longer on `PATH`) can emit `pty://exit` before the listener exists. The pane then shows "running" forever, with no exit overlay and no Restart button.

**Suggested fix.** Pass a `tauri::ipc::Channel` into `pty_spawn` and send output and exit on it. The channel exists before the process does, so nothing can be missed. Delivery also becomes per-caller instead of a broadcast, which fixes M4.
```rust
#[derive(Clone, Serialize)] #[serde(tag = "kind")]
enum PtyEvent { Output { bytes: String }, Exit { code: Option<i32> } }
pub fn pty_spawn(..., on_event: tauri::ipc::Channel<PtyEvent>) -> Result<String, String>
```
```ts
const ch = new Channel<PtyEvent>(); ch.onmessage = (m) => m.kind === "Output" ? term.write(fromBase64(m.bytes)) : onExit(m.code);
const id = await invoke<string>("pty_spawn", { command, cwd, cols, rows, onEvent: ch });
```

#### H3. A failed account switch leaves the credential and identity mismatched, and a retry then overwrites the outgoing account's saved token
`src-tauri/src/accounts.rs:1051-1076`, `880-893`

**Status:** Fixed (ff6c750). The outgoing credential is restored if the config splice fails; a token refreshed in between is filed into the target's slot first. The suggested "switch in progress" marker was not added, so a crash (rather than an error) between the two halves is still unprotected.

**What's wrong.** `switch_blocking` writes the target account's credential into the Keychain (`live_write`, line 1054) and only then takes `config_lock()` (line 1058) to splice the identity into `~/.claude.json`. If that lock times out after 9 s, or the config write fails, the command returns an error. At that point the Keychain holds the **target's** token while the config still names the **old** account.

When the user retries, `recapture_outgoing` reads the live credential (the target's) and the config uuid (the old one). It then writes the target's token into the old account's slot (`write_slot(dir, uuid, &slot)`, line 892). That slot held the only copy of the old account's freshly rotated refresh token.

**Why it matters.** This is the exact outcome the module header calls out as the thing to avoid: the outgoing account's refresh token is destroyed. Getting there takes only one lock timeout ("stayed locked -- Claude Code looks busy…") followed by a natural retry.

**Suggested fix.** Keep the outgoing credential in memory. If anything fails after `live_write`, put it back under the credential locks before returning the error. As a safety net, `recapture_outgoing` should refuse to overwrite a slot when a "switch in progress" marker (written before `live_write`, removed after the splice) names a different target.
```rust
let outgoing = { let _l = credential_locks()?; let prev = live_read()?; recapture_outgoing(&dir, &index)?; live_write(&target.credential)?; prev };
if let Err(e) = splice_config(&target) {
    if let Some(prev) = outgoing { let _l = credential_locks()?; let _ = live_write(&prev); }
    return Err(e);
}
```

#### H4. Autosave on an unlocked file silently overwrites edits the agent makes to it
`src/components/FileViewer.tsx:186-188`, `212-217`; `src-tauri/src/fs.rs:270-281`

**Status:** Fixed (e5ce933). `write_file` takes the base text and refuses with "changed on disk"; the editor stops autosaving and shows Reload / Overwrite. Typing held back by a conflict is dropped if you switch files without choosing. Not exercised in the running app, only type-checked and unit-tested on the backend.

**What's wrong.** A disk refresh is skipped while `unsavedRef.current` is set. The comment assumes the change is "most likely our own save landing", but it could equally be the agent writing. The next autosave then writes the whole stale buffer back. `write_file` has no precondition (expected mtime or content hash), so it clobbers whatever is on disk. After that the buffer and the disk agree, so nothing ever shows that anything happened.

**Why it matters.** In an app built around an agent editing files, a user typing into an unlocked file (a `.env`, a config) while the agent edits the same file loses the agent's change permanently and without any sign of it.

**Suggested fix.** Track the disk text the buffer is based on (`baseRef`). When a refresh arrives with text that differs from both `baseRef` and the last thing written, treat it as a conflict. Stop autosaving and show a "changed on disk — reload / overwrite" bar. Enforce the same rule in the backend by having `write_file` take an `expected: Option<String>` (a hash of `baseRef`) and refuse to write when the disk no longer matches.

#### H5. `git_diff` reads files outside the workspace through `..` segments, because its boundary check is lexical
`src-tauri/src/git.rs:422-435`, `580-585`; `src-tauri/src/git_log.rs:442-447`

**Status:** Fixed (77be6fb). Shared `fs::inside_workspace` used by `git_diff`, `check_paths` and also `git_blame`, which had the same lexical check.

**What's wrong.** `git_diff` checks `PathBuf::from(&path).starts_with(root)`. That check is component-wise but does not resolve anything, so `"<root>/../../etc/passwd"` passes it. `strip_prefix(workdir)` passes too. The HEAD lookup fails harmlessly, and then `std::fs::read(&abs)` lets the OS resolve the `..` and returns the file's contents as the diff's `new` side, for any file up to 2 MB. `check_paths`, which guards stage, unstage and rollback, has the same lexical check. `git_rollback(..., delete_untracked: true)` calls `remove_file` on those paths, although in most layouts git's own "outside repository" refusal fails the operation first.

**Why it matters.** `SECURITY.md` names "path traversal out of the opened workspace" as in scope, and `fs.rs` canonicalizes everything for exactly this reason. These commands bypass that guard. The current frontend never builds such a path, so this is defense in depth. Even so, it is the boundary the project chose to enforce, and with CSP off (M1) it is the main thing standing between a webview bug and reading arbitrary files.

**Suggested fix.** Share one helper with `fs.rs`. Reject any path with a `ParentDir`, `CurDir` or prefix component, then require `starts_with(root)`. Canonicalize when the path exists (deleted files can't be canonicalized, which is why a component check is needed as well).
```rust
fn lexically_inside(root: &Path, p: &Path) -> bool {
    p.is_absolute() && p.starts_with(root)
        && p.components().all(|c| matches!(c, Component::RootDir | Component::Normal(_)))
}
```

#### H6. "Force push with lease" no longer protects other people's work once the app has fetched
`src-tauri/src/git.rs:709-711`, `760-763`; `src/components/PushDialog.tsx:114`

**Status:** Fixed (e71c869). Added `--force-if-includes`; verified against a scratch repo that a push after Fetch is now refused.

**What's wrong.** A bare `--force-with-lease` compares the remote against the local remote-tracking ref. Aditor's own **Fetch** (`git fetch --all --prune`, also on the branch menu and the `git.fetch` command) moves that ref to the remote's tip, so the lease always matches and the push behaves like `--force`. The dialog nevertheless promises "with lease: refuses if the remote moved", and the code comment says "so nobody else's work is lost".

**Why it matters.** The sequence is ordinary: Fetch, then decide to force-push your rebased branch. That silently deletes a teammate's commits that landed in between, which is the loss the UI explicitly says it prevents.

**Suggested fix.** Add `--force-if-includes` (git ≥ 2.30), which was designed for exactly this background-fetch problem. Better still, pin the lease to the remote sha the push dialog actually displayed: `--force-with-lease=refs/heads/<branch>:<sha shown in dialog>`.

#### H7. A chosen prompt template is typed into the active agent of *every* editor window
`src/App.tsx:381-391`, `src/components/TemplatePicker.tsx:233`

**Status:** Fixed (434fe06). Listens via `getCurrentWindow().listen`.

**What's wrong.** The picker sends with `emitTo(target.from, TEMPLATES_INSERT, text)`, aimed at one window. App receives it with the global `listen()` from `@tauri-apps/api/event`, which registers with target `{kind: "Any"}`. In Tauri 2.11, `emit_to` walks every webview, and `match_any_or_filter` (`tauri-2.11.6/src/event/listener.rs:310`) always delivers to `Any` listeners. So every editor window runs its listener and pastes the prompt into whichever session it has on screen.

**Why it matters.** With two editor windows open, a template meant for project A also lands in project B's agent input. The bracketed paste means it isn't submitted, but it is easy to send by accident on the next Enter.

**Suggested fix.** Listen on the current window only:
```ts
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
const unlisten = getCurrentWebviewWindow().listen<string>(TEMPLATES_INSERT, ...);
```
Use the same pattern for any future event meant for a single window.

---

### Medium

#### M1. CSP is disabled, and `pty_spawn` runs any command (and any `cwd`) the webview sends
`src-tauri/tauri.conf.json:25`, `src-tauri/src/pty.rs:251-276`, `441`

**Status:** Needs decision. Restricting `pty_spawn` to an allow-list depends on Question 2 (custom agents), and a strict CSP has to be checked in the running app against xterm's WebGL renderer and CodeMirror, which I could not do here. Only the misleading "fixed registry" comment was corrected (be53840).

**What's wrong.** `"csp": null` turns off the webview's Content Security Policy. `pty_spawn` interpolates `command` straight into `sh -l -c "…; exec {c}{args}"`. The comment at line 169 says "Commands come from a fixed registry", but that is only true of the current frontend; the backend enforces nothing. `cwd` is not checked against an open workspace either.

**Why it matters.** Nothing in the UI renders untrusted HTML today (no `dangerouslySetInnerHTML`; commit messages, file names and MCP task titles all go through React's escaping). But any future injection would immediately become arbitrary command execution. `SECURITY.md` lists "unintended command execution" as in scope.

**Suggested fix.** Set a strict CSP, for example `"default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"`, then confirm that xterm's WebGL and CodeMirror still work. In `pty_spawn`, accept an agent **id** rather than a command string, look the command up in the same `known` table `agents_available` uses, and require `cwd` to be an open workspace root (`workspace_root(&ws, &cwd)`).

#### M2. Several hot or slow commands still run on the macOS main thread
`src-tauri/src/pty.rs:443-484` (`agents_available`); `src-tauri/src/git.rs:222`, `422`; `src-tauri/src/fs.rs:207`, `242`, `270`; `src-tauri/src/agents.rs:886`, `933`

**Status:** Fixed (71cf71e). `agents_available` (probes now parallel), `agent_sessions`, `git_status`, `git_diff`, `list_dir` and `read_file` run on the blocking pool; every caller already drops stale responses. `write_file` deliberately stays synchronous: overlapping autosaves on the pool could land out of order.

**What's wrong.** These are synchronous `#[tauri::command]` fns, so they block the webview, xterm included, for as long as they run. Moving `git_status`, `git_diff`, `list_dir`, `read_file` and `agent_sessions` off the main thread was previously deferred on purpose. Two additions make the problem worse:

- `agents_available` runs **two login shells one after the other** (`$SHELL -l -c 'command -v … && … --version'`) at window start. With a heavy `.zprofile` that can freeze a new window for seconds.
- `write_file` runs on every autosave.

**Why it matters.** It causes UI stutter during agent turns, when the watcher fires constantly (see M3), and a frozen window at startup.

**Suggested fix.** Copy the existing `off_thread` / `spawn_blocking` pattern. Start with `agents_available`, where the two probes can also run in parallel, and `agent_sessions`. The `State<'_, Workspace>` issue that motivated the deferral only needs `let root = workspace_root(&ws, &root)?;` before the closure, as `git_branches` already does.

#### M3. The agent panel re-reads sessions and accounts on every workspace file change
`src/components/ProjectView.tsx:1286`; `src/components/AgentSessions.tsx:175-188`; `src/components/AccountSwitcher.tsx:47-49`

**Status:** Fixed (edf680d). The panel gets only `agentsToken`; M8 was fixed first so a project's first session still refreshes.

**What's wrong.** `refreshToken={refreshToken + agentsToken}` ties the panel to the **workspace** watcher as well as `agents://changed`. Every debounced file event (every 150 ms during a turn) therefore runs:

- `agent_sessions`: synchronous, on the main thread. It parses all of `~/.claude.json`, lists `~/.claude/sessions` and stats every transcript.
- `claude_accounts`: re-parses `~/.claude.json`.

**Why it matters.** This is the most frequent main-thread work in the app, and it happens exactly while the agent is busiest. Transcript and registry changes already have their own watcher.

**Suggested fix.** Pass only `agentsToken` to `InsightPanel`. Make sure `agents://changed` covers the cases the workspace token was standing in for (see M8).

#### M4. PTY output is broadcast to every window and every terminal listener
`src-tauri/src/pty.rs:214-220`, `src/components/TerminalPane.tsx:149-152`

**Status:** Fixed with H2 (bec9847). Output goes over the spawning pane's channel only.

**What's wrong.** `app.emit("pty://output", …)` serializes and delivers each base64 chunk to every webview: settings, diff and log windows, and every other editor window. Inside each window, every `TerminalPane` listener receives it and drops it if the id doesn't match.

**Why it matters.** The cost grows with windows × sessions during exactly the long-streaming output that `FLUSH_BYTES` coalescing was meant to make cheap.

**Suggested fix.** Use a per-session `Channel`, as in H2. At minimum, use `emit_to(window_label, …)` with the label already stored on `PtySession`.

#### M5. Each PTY session's ticker thread wakes every 4 ms for the life of the session
`src-tauri/src/pty.rs:313-318`

**Status:** Fixed (0d21bfa). The ticker waits on a condvar and arms the 4 ms deadline only when output arrives.

**What's wrong.** `loop { sleep(4ms); flush(lock()) }` runs whether or not there is output, which is 250 wakeups and mutex acquisitions per second per session, idle or not.

**Why it matters.** Battery and CPU drain with several sessions open across tabs. Most sessions are idle most of the time.

**Suggested fix.** Have the ticker wait on a `Condvar` (or `recv_timeout`) that the reader signals when `pending` goes from empty to non-empty, and arm the 4 ms deadline only then.

#### M6. `write_file` truncates and rewrites the user's file in place
`src-tauri/src/fs.rs:280`

**Status:** Fixed (fd7f607). Reuses `rewrite_preserving_mode` (now `pub(crate)`); test checks mode is kept and no temp file is left.

**What's wrong.** `std::fs::write` opens the file with `O_TRUNC` and then writes. `accounts::write_private` already shows the safer temp-file-and-rename pattern.

**Why it matters.** A crash or full disk mid-write leaves a truncated `.env` or config. The watcher also fires on the truncate, so the agent or the viewer can briefly read an empty file.

**Suggested fix.** Write to `.<name>.aditor.tmp` in the same directory, copy the original's permissions, `sync_all`, then `rename`. That is `rewrite_preserving_mode` in `accounts.rs`, which can be moved somewhere shared and reused.

#### M7. Every git write starts a login shell, has no timeout, and holds the global git gate while it runs
`src-tauri/src/git.rs:534-577`, `445-460`

**Status:** Partly fixed (e8e51e8): every git write is bounded by a 5-minute timeout that kills git, so a hang no longer wedges `GIT_GATE`. 5 minutes rather than "a few seconds" for local operations, because commit hooks can legitimately run tests. **Needs decision** on the login-shell half: spawning git directly with only a cached `PATH` drops anything else the login profile exports (commonly `SSH_AUTH_SOCK` for 1Password or a custom agent), which would break push/pull authentication for those setups. Capturing the whole login environment once is the safer variant.

**What's wrong.** `run_git` runs `$SHELL -l -c 'exec git "$@"'`, sourcing the user's whole login profile, for every stage, unstage and commit. There is no wait timeout. A push hung on a network stall, or a hook waiting on something, holds `GIT_GATE` forever, and all later git writes queue behind it with no way to cancel.

**Why it matters.** Staging a single file feels slow, and one hung push wedges every other git action until the app restarts.

**Suggested fix.** Resolve the login `PATH` once (`$SHELL -l -c 'printf %s "$PATH"'`), cache it, and spawn `git` directly with that `PATH`. Add a wait with a timeout, like `keychain::run` already has: about 2 min for network operations, a few seconds for local ones. Kill the child when it fires.

#### M8. The agent watcher never notices a transcript directory created after the first call
`src-tauri/src/agents.rs:945-980`

**Status:** Fixed (aca6949). While the transcript directory is missing, the watcher also watches `~/.claude/projects` and adds the directory from a helper thread once it resolves. Not exercised end to end in the running app.

**What's wrong.** When `project_dir` returns `None` (a project with no Claude transcripts yet, which is the normal first-run case), only `~/.claude/sessions` is watched. The watcher is still stored, so every later `agent_watch` call for that root returns early at line 945, and the new project directory is never added.

**Why it matters.** For a project's first session, the panel doesn't refresh as the transcript grows. It only appears to work today because of the workspace-token coupling in M3.

**Suggested fix.** Don't store a watcher that lacks its transcript directory. Alternatively, have the registry-dir event handler retry `project_dir` and add the watch once it resolves.

#### M9. Projects with no transcripts trigger a full scan of `~/.claude/projects` on every refresh
`src-tauri/src/agents.rs:505-528`

**Status:** Fixed (f49dd11). A failed full scan is trusted for 30 s; the cheap guessed path is still checked every call.

**What's wrong.** Misses aren't cached. Each `agent_sessions` call for a project without a match runs `read_dir` over every project directory and opens up to 50 lines of the first `.jsonl` in each. That happens on the main thread, and (via M3) on every file change.

**Why it matters.** Heavy Claude Code users have hundreds of project directories, so the cost scales with that history rather than with the open project.

**Suggested fix.** Cache negative results with a short TTL, or invalidate on a `Create` event under `~/.claude/projects`.

#### M10. Lock touching leaves a `.touch` file inside Claude Code's lock directory, which can wedge its lock after a crash
`src-tauri/src/accounts.rs:196-200`, `274`

**Status:** Fixed (d625374). `touch` uses `File::set_modified`; new test asserts the held lock directory stays empty.

**What's wrong.** `touch` creates `<lock>/.touch` to bump the directory's mtime, and the file stays there until `Drop`. `proper-lockfile` removes locks, including stale ones, with a plain `rmdir`. If Aditor is force-quit or crashes (`panic = "abort"`) while holding a lock for more than 3 s, Claude Code finds a stale but **non-empty** lock directory. Its `rmdir` fails with `ENOTEMPTY`, and its token refresh can't take the lock until someone deletes the directory by hand.

**Why it matters.** This breaks Claude Code's credential refresh, outside Aditor, with an obscure symptom.

**Suggested fix.** Bump the mtime directly, without creating entries. `std` can do it, so the "no utime binding" constraint doesn't apply:
```rust
fn touch(dir: &Path) -> bool {
    fs::File::open(dir).and_then(|f| f.set_modified(SystemTime::now())).is_ok()
}
```

#### M11. Closing an editor window leaks the agent watchers for its projects
`src-tauri/src/fs.rs:71-76` vs `185-201`; `src-tauri/src/lib.rs:106-108`

**Status:** Fixed (251a6ed). `release_window` returns the released roots and the `Destroyed` handler forgets each.

**What's wrong.** `close_workspace` calls `agents.forget(&root)` when the last holder goes, but `release_window`, used when a window is destroyed, does not. Watchers on `~/.claude/sessions` and the project's transcript directory survive. They keep broadcasting `agents://changed` to every window for roots that no window shows.

**Why it matters.** It is a resource leak, and it adds event noise that every window has to filter.

**Suggested fix.** Have `release_window` return the roots it dropped. Call `AgentState::forget` for each one in the `Destroyed` handler.

#### M12. Git log paging re-walks history from the start, and the path filter diffs every commit
`src-tauri/src/git_log.rs:231-258`, `182-190`; `src/components/LogWindow.tsx:187`, `164`

**Status:** Partly fixed (3a17da4): `touches` is memoised per (commit, path) in a bounded cache, so re-walks no longer re-diff. **Needs decision** on the rest: with `Sort::TOPOLOGICAL` libgit2 walks the whole history before yielding anything, so a cursor alone gains little; the real options are a server-side walk session or the CLI with commit-graph bloom filters (whose path-history semantics differ from the current first-parent diff).

**What's wrong.** `loadMore` asks for `skip = commits.length`, so page *n* walks *n × 300* commits before it returns any. Window focus and every `git://changed` event also re-request `max(PAGE, loaded)` rows from the top. With a `path` filter, each walked commit costs a tree-to-tree diff, and a path that rarely changes means walking the whole history for one page.

**Why it matters.** Deep scrolling is quadratic, and the file-history view on a large repo is slow.

**Suggested fix.** Page by cursor: return the last oid and resume the revwalk from it, or keep the revwalk alive server-side keyed by a query id. For path history, use `git log --format=… -- <path>` through the CLI, which uses commit-graph bloom filters.

#### M13. `git_outgoing` returns the entire history when there is no upstream and no remote
`src-tauri/src/git_log.rs:477-500`

**Status:** Fixed (29177f0). Early return when the repo has no remotes (a repo with several remotes but no `origin` still lists what no remote has); capped at 500 with a `more` flag shown as "…and more".

**What's wrong.** With no upstream, it hides `refs/remotes/*`. In a repo with no remotes that hides nothing, so every commit reachable from HEAD is serialized, each with its labels, every time the Push dialog opens.

**Why it matters.** A local-only repo with a long history gets a slow Push dialog and a large IPC payload, all to show a dialog that can't push.

**Suggested fix.** Return early when there are no remotes, and cap the walk (say 500 commits, with a "…and more" flag).

#### M14. The file tree re-lists every directory it has ever loaded on each watcher tick
`src/components/FileTree.tsx:164-194`

**Status:** Fixed (368f44f). The watcher's paths are batched per tick; the tree re-lists only loaded directories that are a changed path, its parent, or beneath it. Git operations and new files still re-list everything.

**What's wrong.** The refresh effect re-runs `listDir` for every key in `cache`, including collapsed directories, ignoring which paths the `fs://changed` payload named. Each `listDir` is a synchronous command on the main thread (M2).

**Why it matters.** After you've browsed a large tree, each 150 ms watcher tick during a turn costs dozens of directory walks.

**Suggested fix.** Pass the changed paths down from `ProjectView` and only re-list their parent directories. Optionally drop collapsed directories from the cache after a while.

#### M15. Broadcasting the whole settings document between windows can drop concurrent changes
`src/settings/store.ts:64-69`, `99-106`

**Status:** Fixed (8d90417). Patches are broadcast as fields and merged. A new window asks peers with unwritten changes for their document (answered to that window only) and adopts it under its own patches.

**What's wrong.** Each `patch` broadcasts the **entire** document, and peers replace their snapshot with it wholesale. Two kinds of change get lost:

- Two windows changing different fields within the IPC latency window: one change is lost, because the second broadcast overwrites the first.
- Work not yet written when a new window opens. The new window hydrates from disk while another window's changes still sit in the 300 ms debounce. Its first `patch` (for example `rememberProject` on a URL project) then broadcasts a stale document over everyone.

**Why it matters.** Writes that the user sees as saved occasionally disappear, such as a rebinding, a template edit or the expanded directories.

**Suggested fix.** Broadcast the *patch* (`{from, next}`) rather than the whole document, and have peers merge it with `{...current, ...next}`. On hydrate, ask the peers for their in-memory document before falling back to disk.

#### M16. No CI, no frontend lint config, and no frontend tests
`.github/` (templates only), `src/components/BottomPane.tsx:138`, `src/components/FileViewer.tsx:244`

**Status:** Fixed (98c9b7d). CI workflow (build, lint, vitest, cargo test, clippy without `-D warnings` until L10), ESLint with only the react-hooks rules (11 warnings, 0 errors), vitest with tests for `placeholders` and `fileLinks`. The workflow has not run on GitHub yet.

**What's wrong.** Nothing runs `tsc`, `cargo test` or `cargo clippy` on PRs, even though the PR checklist asks contributors to run them by hand. The code carries `// eslint-disable-next-line react-hooks/exhaustive-deps` comments, but there is no ESLint setup, so those rules never run. The frontend logic is untested, though pure modules like `pty/fileLinks.ts` (`findCandidates`), `templates/placeholders.ts`, `settings/store.ts` (`normalize`), `shortcuts/keys.ts` and `git/graph.ts` are easy to test.

**Why it matters.** Regressions in exactly the subtle areas this review flags (effect dependencies, normalisation) go unnoticed.

**Suggested fix.** Add a GitHub Actions workflow on `macos-latest` that runs `npm ci && npx tsc --noEmit`, then `cargo clippy -- -D warnings` (once the two existing warnings are fixed) and `cargo test`. Add `eslint` with `eslint-plugin-react-hooks`, and `vitest` for the pure modules above.

#### M17. Contributor docs and code comments contradict the code

**Status:** Fixed (be53840).

- `CONTRIBUTING.md:71`: says "`git.rs` is read-only by design… does not mutate the repository". It now stages, commits, pushes, merges, rebases, resets and deletes branches.
- `CONTRIBUTING.md:27` and `.github/PULL_REQUEST_TEMPLATE.md:8`: say "There is no test suite yet". `cargo test` runs 40 tests across `fs`, `git`, `git_log`, `agents`, `accounts` and `settings`.
- `CONTRIBUTING.md:74`: says "`agents.rs`… No network calls". `agent_refresh_limits` makes one; the README states this correctly.
- `src-tauri/src/pty.rs:82-84`, `150-152`, `173-175`, `453-454`: describe the `command: None` arm as "dormant… a branch nothing reaches". `SHELL_SESSION` in `src/pty/api.ts:18-24` reaches it every time someone opens a Terminal.

**Why it matters.** Contributors are told to follow conventions that no longer hold, and reviewers are told tests don't exist.

**Suggested fix.** Update the four places. The git rule should become something like "reads via git2; writes only via `run_git`, behind `GIT_GATE`, never with `--force` except `--force-with-lease`."

---

### Low

#### L1. The MCP bearer token appears in the agent's argv
`src-tauri/src/pty.rs:237-247`, `src-tauri/src/mcp.rs:61-72`

**What's wrong.** The token is passed inside `--mcp-config '<json>'` on the command line. On macOS any local user can read it with `ps -wwax`. The Keychain code takes care to keep secrets out of argv; this path doesn't.

**Why it matters.** The impact is small (spoofing the Tasks panel), but the README presents the token as the access control.

**Suggested fix.** Write the config to a `0600` file in `$TMPDIR` and pass its path. `--mcp-config` accepts file paths. Delete the file when the PTY exits.

#### L2. The MCP server has no body limit, no timeouts, and handles one request at a time
`src-tauri/src/mcp.rs:103-107`, `146-149`

**What's wrong.** `read_to_string` reads unbounded input, and one slow client blocks every other agent's tool calls.

**Suggested fix.** Cap the body (for example `req.as_reader().take(1 << 20)`), and either handle each request on its own short-lived thread or set a socket read timeout.

#### L3. The askpass helper script is never deleted
`src-tauri/src/git.rs:504-521`

**What's wrong.** Each launch leaves a new `aditor-askpass-<pid>.sh` in `$TMPDIR`. It is opened with `create + truncate`, not `create_new`, so a leftover file with a reused pid keeps its old mode.

**Suggested fix.** Use a fixed name under `~/.aditor/` with `create_new` and a mode check, or delete the file on exit.

#### L4. The Keychain helper's timeout leaves the `security` process running
`src-tauri/src/accounts.rs:496-508`

**What's wrong.** On timeout, the waiting thread and the child are abandoned rather than killed.

**Suggested fix.** Keep the `Child` handle, or its pid, and kill it when `recv_timeout` fires.

#### L5. The Keychain write falls back to passing the secret (hex) in argv
`src-tauri/src/accounts.rs:545-565`

**What's wrong.** Hex encoding is not protection: anyone listing processes can decode it.

**Suggested fix.** Prefer failing loudly. Alternatively, split the value across `security -i` input with `-X` on its own line, if `security` accepts long lines in that form.

#### L6. Several in-memory and on-disk stores grow without bound
`src-tauri/src/agents.rs:273-286`, `874-876`; `src-tauri/src/accounts.rs:900-909`; `src/projects.ts:51-59`

**What's wrong.**
- `AgentState.files` holds a `seen_requests` set for every transcript ever opened, and `forget` doesn't clear it.
- The `accounts/unsaved/` folder gains a credential file on every switch away from an unsaved login.
- `settings.projects` keeps entries for projects long gone from the 12-item recents list.

**Suggested fix.** Prune `files` and `dirs` in `forget`. Cap the `unsaved/` stash (keep the newest N). Drop `projects[path]` when a path falls off `recents`.

#### L7. `settings.projects` is not validated below the top level
`src/settings/store.ts:192`

**What's wrong.** The README promises that "every field is checked on load", but `projects` is only checked for being an object. A hand-edited `"expandedDirs": 5` or `"writable": 5` throws during render (`new Set(5)`, `(5).includes`). A string `writable` silently does substring matching.

**Suggested fix.** Normalise each `ProjectState` the same way `layout` is normalised.

#### L8. Blame reports one extra line for files ending in a newline
`src-tauri/src/git_log.rs:387`

**What's wrong.** `split(b'\n').count()` counts the empty piece after the trailing newline.

**Suggested fix.** Use `working.iter().filter(|&&b| b == b'\n').count() + (!working.ends_with(b"\n") && !working.is_empty()) as usize`.

#### L9. Small parsing inaccuracies in `agents.rs`
`src-tauri/src/agents.rs:194-204`, `451-455`

**What's wrong.**
- `iso_to_ms` calls itself "deliberately strict" but ignores any trailing offset (`+02:00`) without complaint.
- The comment says "Lossy rather than strict", but the code uses strict `from_utf8` and skips the line.

**Suggested fix.** Require a `Z` (or apply the offset). Change the comment, or switch to `from_utf8_lossy`.

#### L10. The two known clippy warnings
`src-tauri/src/accounts.rs:207` (`subsec_millis()`), `src-tauri/src/pty.rs:251` (too many arguments)

**What's wrong.** Both are trivial, and fixing them would let CI use `-D warnings`.

**Suggested fix.** Use `d.subsec_millis() as u64 % 250`. Group the spawn arguments into a struct, or add `#[allow(clippy::too_many_arguments)]` with a reason; Tauri commands commonly do the latter.

#### L11. Minor frontend and config hygiene
- `src/main.tsx:13-19`: an `import` statement comes after executable code (`flushAll`). It works because imports are hoisted, but it reads as if ordering matters. Move it up.
- `vite.config.ts:3`: `// @ts-expect-error` stands in for a missing `@types/node`. Add the dev dependency.
- `src-tauri/src/fs.rs:330-332`: `Duration::from_millis(150).as_millis()` is a round trip. A `const FS_DEBOUNCE_MS: u64 = 150` is clearer.

#### L12. Bundle targets say `all` on a macOS-only project
`src-tauri/tauri.conf.json:30`

**What's wrong.** `npm run tauri build` tries every format for the platform. The README already says nothing outside macOS has been exercised.

**Suggested fix.** Use `"targets": ["app", "dmg"]`.

#### L13. The diff and log windows break once their project's tab is closed
`src/components/DiffWindow.tsx:111-121`, `src/components/LogWindow.tsx:64`

**What's wrong.** These windows read through a root that `close_workspace` may have dropped. After that, every call fails with "… is not an open workspace", and the window stays open, showing errors.

**Suggested fix.** Close or blank the side window when its root is released. A `fs://released { root }` event would be enough.

---

## 3. Dependency updates

**Status:** Done for every row that recommended a change, one update per commit, with tests, tsc, lint and clippy after each: `tauri` 2.12.1 + `tauri-build` 2.7.1, `@tauri-apps/api` 2.12.1, `@tauri-apps/cli` 2.12.1, dialog plugin 2.8.1 (crate and JS), opener plugin 2.7.0 (crate and JS; `opener:default` is unchanged), `vite` 8.3.2. `@types/node` was not added: it only serves L11, which is Low. `cargo audit` is still not run.

`npm audit` reports 0 vulnerabilities. `cargo audit` and `cargo outdated` are **not installed**, so Rust advisories were not checked. Running `cargo install cargo-audit && cargo audit` is recommended, ideally in CI.

| Package | Current | Recommended | Reason |
|---|---|---|---|
| `tauri` (crate) | 2.11.6 | 2.12.1 | Semver-compatible patch/minor. Keep in lockstep with `@tauri-apps/api` (the CLI warns on mismatch). |
| `tauri-build` (crate) | 2.6.3 | 2.7.1 | Goes with `tauri` 2.12. |
| `@tauri-apps/api` | 2.11.1 | 2.12.1 | Match the Rust `tauri` crate. |
| `@tauri-apps/cli` | 2.11.5 | 2.12.1 | Match the runtime. |
| `tauri-plugin-dialog` / `@tauri-apps/plugin-dialog` | 2.7.3 / 2.7.3 | 2.8.1 / 2.8.1 | Minor update. Update the crate and the JS package together. |
| `tauri-plugin-opener` / `@tauri-apps/plugin-opener` | 2.5.5 / 2.5.5 | 2.7.0 / 2.7.0 | Minor update. Update both together. |
| `vite` | 8.3.0 | 8.3.2 | Patch release. |
| `typescript` | 6.0.3 | stay on 6.0.x | 7.0.2 is a new major. The `~6.0.3` pin looks deliberate; evaluate 7 separately. |
| `@types/node` (new, dev) | — | latest 22.x/24.x | Removes the `@ts-expect-error` in `vite.config.ts`. |
| `notify` | 8.2.0 | stay | 9.0 is still a release candidate. |
| `base64` | 0.23.1 (also 0.21/0.22 transitively) | stay | Three copies in the lockfile come from transitive dependencies. Harmless, but `cargo tree -d` is worth checking after the Tauri bump. |
| `git2`, `portable-pty`, `ureq`, `tiny_http`, `ignore` | 0.21.0, 0.9.0, 3.4.2, 0.12.0, 0.4.33 | no change | Already the latest published versions (`cargo search`). |

No unused dependencies were found. Every crate and npm package in the manifests is imported somewhere.

---

## 4. Questions

These look wrong but may be intentional.

1. **Grandchild processes on session close.** `pty_kill` and `kill_window` signal only the agent's own pid, through `ChildKiller::kill`. The README says each agent runs "in its own process group", but nothing signals the *group*. Do tool subprocesses and stdio MCP servers that Claude Code starts survive closing a pane? If they keep the slave fd open, the reader and ticker threads also never exit (the reader never gets EOF). `libc::killpg(pid, SIGHUP)` would cover the group, and `libc` is already a dependency.
2. **Is `pty_spawn`'s free-form `command` meant for future "custom agent" entries?** If so, M1's fix should become an allow-list stored in settings, rather than the hard-coded table.
3. **Default `diffDisplay` / `fileDisplay` are both `"window"`** (`src/settings/schema.ts:134-135`). Opening a file from the tree on first run opens a separate window rather than the pane under the terminal. Is that the intended first impression?
4. **Hard-coded price table** (`src-tauri/src/agents.rs:140-150`). Costs only matter when no `cost-state` line exists. Is there a plan to keep this current, or to show "≈" plus "unknown model" more prominently when nothing matches?
5. **`dirs_exist` takes arbitrary paths** (`src-tauri/src/fs.rs:341-344`). This is documented as deliberate, and it only reveals whether a path exists. It is noted here because it is the one path-taking command outside the workspace boundary.

---

## 5. Suggested fix order

Ordered by impact relative to effort.

1. **H7: listen for `TEMPLATES_INSERT` on the current window only.** One line, and it ends a confirmed cross-window bug.
2. **H5: reject `..`/`.` components in `git_diff` and `check_paths`.** A small shared helper restores the documented boundary.
3. **H6: add `--force-if-includes`, or a sha-pinned lease, to force push.** One argument, and it protects other people's commits.
4. **H3: roll back the credential when the config splice fails.** A few lines in `switch_blocking`, and it prevents permanent token loss.
5. **M10: bump the lock mtime with `File::set_modified` instead of a `.touch` file.** Three lines, and it stops Claude Code's lock from wedging after a crash.
6. **H1: move PTY writes to a per-session writer thread.** Small, self-contained, and removes the worst freeze.
7. **H2 + M4: deliver PTY output and exit over a `tauri::ipc::Channel`.** Medium effort; fixes lost first output and exits, and the broadcast cost.
8. **M3 + M2: drop `refreshToken` from the agent panel, and move `agent_sessions` and `agents_available` off the main thread.** Removes most of the main-thread work during turns.
9. **H4 + M6: add conflict detection to autosave, and make `write_file` atomic.** Medium effort; prevents silent data loss in user-edited files.
10. **M16 + M17: add a CI workflow (tsc, clippy, cargo test) and correct `CONTRIBUTING.md`.** Cheap, and keeps the fixes above from regressing.
