import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { AgentPicker } from "./components/AgentPicker";
import { AgentSessions } from "./components/AgentSessions";
import { ProjectPicker } from "./components/ProjectPicker";
import { TerminalPane } from "./components/TerminalPane";
import { FileTree } from "./components/FileTree";
import { ChangesList } from "./components/ChangesList";
import { BottomPane } from "./components/BottomPane";
import { SplitPane } from "./components/SplitPane";
import { Settings } from "./components/Settings";
import { TemplatePicker } from "./components/TemplatePicker";
import { Toast, type ToastMessage } from "./components/Toast";
import { useShortcuts } from "./shortcuts/useShortcuts";
import { chordFor } from "./shortcuts/store";
import { formatChord } from "./shortcuts/keys";
import { switchToNextAccount } from "./accounts/next";
import type { CommandId } from "./shortcuts/registry";
import {
  agentsAvailable,
  ptyWriteActive,
  reapOrphansOnce,
  type AgentInfo,
} from "./pty/api";
import { dirsExist, fsDebounceMs, openWorkspace } from "./fs/api";
import { gitStatus, type RepoStatus } from "./git/api";
import { agentWatch } from "./agents/api";
import { patch, patchLayout, settings, useSetting } from "./settings/store";
import { contextFrom } from "./templates/placeholders";
import { growWindowToEditor } from "./window";
import {
  forgetProject,
  loadProjectState,
  loadRecents,
  rememberProject,
  saveProjectState,
  type RecentProject,
} from "./projects";

/** How long a watcher-touched path stays accented. */
const RECENT_MS = 8000;

/**
 * Debounce for `agents://changed`. Coarser than the file watcher's: a live
 * transcript is appended many times within a single turn, and every event
 * means re-reading its tail.
 */
const AGENT_DEBOUNCE_MS = 400;

/** Keeps the rail and the terminal both usable. */
const INSIGHT_MIN = 220;
const INSIGHT_MAX = 480;

/** A tooltip that names the chord, and stays honest once it is rebound. */
function chordHint(text: string, id: CommandId): string {
  const chord = chordFor(id);
  return chord ? `${text} (${formatChord(chord)})` : text;
}

export default function App() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  /** Agent we would like to run: the project's, else the last one used. */
  const [agentPref, setAgentPref] = useState<string | null>(
    () => settings().lastAgent,
  );
  const [active, setActive] = useState<AgentInfo | null>(null);
  const [generation, setGeneration] = useState(0);
  const [exitCode, setExitCode] = useState<number | null | undefined>(undefined);

  const [workspace, setWorkspace] = useState<string | null>(null);
  /** The chooser is the first screen: nothing opens until it is used. */
  const [picking, setPicking] = useState(true);
  const [recents, setRecents] = useState<RecentProject[]>([]);
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [pickError, setPickError] = useState<string | null>(null);

  const [openFile, setOpenFile] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [refreshToken, setRefreshToken] = useState(0);
  const [repo, setRepo] = useState<RepoStatus | null>(null);
  /** path -> when the watcher last saw it move. */
  const [recentAt, setRecentAt] = useState<Map<string, number>>(new Map());
  const splitFraction = useRef(settings().layout.splitFraction);

  // Straight from settings rather than mirrored into state: the General tab
  // sets the same field, and two copies would disagree.
  const insightOpen = useSetting((s) => s.layout.insightOpen);
  const [insightWidth, setInsightWidth] = useState(
    () => settings().layout.insightWidth,
  );
  const [resizing, setResizing] = useState(false);
  /** Bumped by `agents://changed`, separately from the workspace watcher. */
  const [agentsToken, setAgentsToken] = useState(0);

  // Focus is real DOM focus, so "focus the tree" cannot be state -- it is an
  // event. A counter is how the panes are asked to take the caret, matching
  // `generation` and `refreshToken` elsewhere here.
  const [filesFocus, setFilesFocus] = useState(0);
  const [agentFocus, setAgentFocus] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastSeq = useRef(0);

  // Persisting per-project state from the callbacks below needs the current
  // workspace, but taking it as a dep would rebuild handlers the tree treats
  // as stable. A ref keeps both.
  const workspaceRef = useRef<string | null>(null);
  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);

  // Re-probe the recents every time the chooser opens: a folder can be moved
  // or deleted between sessions, or while a project is open.
  useEffect(() => {
    if (!picking) return;
    const list = loadRecents();
    setRecents(list);
    if (list.length === 0) return;
    let stale = false;
    void dirsExist(list.map((r) => r.path))
      .then((flags) => {
        if (stale) return;
        setMissing(new Set(list.filter((_, i) => !flags[i]).map((r) => r.path)));
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [picking]);

  useEffect(() => {
    void (async () => {
      // Reap orphans from a previous page context before spawning, or reloads
      // accumulate agent processes. Once per page, never per project: on a
      // project switch this would kill the session we are about to keep.
      await reapOrphansOnce();
      setAgents(await agentsAvailable());
    })();
  }, []);

  // Resolve the preference against what is actually installed. Runs again when
  // a project remembering a different agent is opened. Only `command` reaches
  // TerminalPane, so re-resolving to the same agent does not respawn anything.
  useEffect(() => {
    if (agents.length === 0) return;
    setActive(
      agents.find((a) => a.id === agentPref && a.available) ??
        agents.find((a) => a.available) ??
        null,
    );
  }, [agents, agentPref]);

  // Watcher -> debounced refresh. The payload also feeds the "just changed"
  // accent, which is what separates "the agent touched this a moment ago" from
  // "this has been dirty all morning" -- git alone cannot tell those apart.
  useEffect(() => {
    let timer: number | undefined;
    let debounce = 150;
    void fsDebounceMs().then((ms) => (debounce = ms));

    const unlisten = listen<string[]>("fs://changed", (ev) => {
      const now = Date.now();
      setRecentAt((prev) => {
        const next = new Map(prev);
        for (const p of ev.payload) next.set(p, now);
        return next;
      });
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setRefreshToken((t) => t + 1), debounce);
    });
    return () => {
      window.clearTimeout(timer);
      void unlisten.then((u) => u());
    };
  }, []);

  // Expire accents. Only ticks while something is actually accented.
  useEffect(() => {
    if (recentAt.size === 0) return;
    const id = window.setInterval(() => {
      const cutoff = Date.now() - RECENT_MS;
      setRecentAt((prev) => {
        const next = new Map([...prev].filter(([, at]) => at > cutoff));
        return next.size === prev.size ? prev : next;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [recentAt.size]);

  // Git status follows the same refresh as the tree, so badges land during a
  // turn rather than after it.
  useEffect(() => {
    if (!workspace) return;
    let stale = false;
    gitStatus()
      .then((s) => !stale && setRepo(s))
      .catch(() => !stale && setRepo(null));
    return () => {
      stale = true;
    };
  }, [workspace, refreshToken]);

  // Watch the agent's own state so the panel keeps up during a turn. Re-armed
  // when the project or the agent changes; the backend makes a repeat call for
  // the same pair a no-op.
  useEffect(() => {
    if (!workspace || !active) return;
    void agentWatch(active.id).catch(() => {
      /* the panel still refreshes with the rest of the tree */
    });
  }, [workspace, active]);

  useEffect(() => {
    let timer: number | undefined;
    const unlisten = listen("agents://changed", () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(
        () => setAgentsToken((t) => t + 1),
        AGENT_DEBOUNCE_MS,
      );
    });
    return () => {
      window.clearTimeout(timer);
      void unlisten.then((u) => u());
    };
  }, []);

  // Dragging the panel edge. A horizontal twin of SplitPane's divider rather
  // than a generalisation of it: SplitPane wraps the terminal, and reshaping it
  // risks the remount that would kill the PTY.
  useEffect(() => {
    if (!resizing) return;
    const move = (e: PointerEvent) =>
      setInsightWidth(
        Math.min(INSIGHT_MAX, Math.max(INSIGHT_MIN, window.innerWidth - e.clientX)),
      );
    const up = () => {
      setResizing(false);
      setInsightWidth((w) => {
        patchLayout({ insightWidth: w });
        return w;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [resizing]);

  const statuses = useMemo(
    () => new Map((repo?.files ?? []).map((f) => [f.path, f.status])),
    [repo],
  );
  const recent = useMemo(() => new Set(recentAt.keys()), [recentAt]);

  const pickAgent = useCallback((agent: AgentInfo) => {
    patch({ lastAgent: agent.id });
    const ws = workspaceRef.current;
    if (ws) saveProjectState(ws, { lastAgent: agent.id });
    setExitCode(undefined);
    setAgentPref(agent.id);
    setActive(agent);
    setGeneration((g) => g + 1);
  }, []);

  /**
   * Open `path` as the workspace and restore whatever was last open in it.
   * The only way in: both a recent row and the folder dialog land here.
   */
  const openProject = useCallback(async (path: string) => {
    let root: string;
    try {
      root = await openWorkspace(path);
    } catch (e) {
      setPickError(String(e));
      setMissing((prev) => new Set(prev).add(path));
      return;
    }
    // The window opens sized to the picker card; the editor layout needs the
    // room. Only on the first open -- after that the size is the user's.
    // Awaited only so the agent spawns into its final geometry rather than
    // fitting itself twice.
    if (workspaceRef.current === null) {
      await growWindowToEditor().catch(() => {
        /* sizing is a nicety; never block opening a project on it */
      });
    }
    const state = loadProjectState(root);
    setRecents(rememberProject(root));
    setMissing((prev) => {
      const next = new Set(prev);
      next.delete(path);
      next.delete(root);
      return next;
    });
    setPickError(null);
    setOpenFile(state.openFile);
    setExpanded(new Set(state.expandedDirs));
    setRecentAt(new Map());
    setRepo(null);
    if (state.lastAgent) setAgentPref(state.lastAgent);
    setExitCode(undefined);
    setWorkspace(root);
    setPicking(false);
  }, []);

  const browseForProject = useCallback(async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked !== "string") return;
    await openProject(picked);
  }, [openProject]);

  const forgetRecent = useCallback(
    (path: string) => setRecents(forgetProject(path)),
    [],
  );

  const showToast = useCallback((text: string, tone: ToastMessage["tone"] = "info") => {
    setToast({ id: ++toastSeq.current, text, tone });
  }, []);
  const hideToast = useCallback(() => setToast(null), []);

  // Every shortcut the app has. The chords themselves live in the registry,
  // which is also what stops TerminalPane forwarding them to the agent --
  // ⌘O used to need a listener here and a line over there to work.
  //
  // A dialog is on top: the app behind it is inert, so nothing but closing the
  // dialog should fire.
  const blocked = picking || settingsOpen || templatesOpen;
  useShortcuts({
    "project.open": () => !settingsOpen && !templatesOpen && setPicking(true),
    "app.settings": () =>
      !picking && !templatesOpen && setSettingsOpen((open) => !open),
    "prompt.templates": () => {
      if (picking || settingsOpen) return;
      // Nothing to type into, and a chooser that quietly did nothing would be
      // worse than saying so.
      if (!active || exitCode !== undefined) {
        showToast("No agent is running to send a prompt to.", "error");
        return;
      }
      setTemplatesOpen((open) => !open);
    },
    "focus.files": () => {
      if (blocked || !workspace) return;
      setFilesFocus((t) => t + 1);
    },
    "focus.agent": () => {
      if (blocked) return;
      setAgentFocus((t) => t + 1);
    },
    "account.next": () => {
      if (blocked) return;
      // The backend would happily swap the Claude login underneath opencode;
      // it just would not mean anything.
      if (active?.id !== "claude") {
        showToast("Switch to Claude Code to change accounts.", "error");
        return;
      }
      void switchToNextAccount()
        .then(({ label, settleSeconds }) => {
          showToast(
            settleSeconds > 0
              ? `Switched to ${label}. The session keeps going and picks it up in ${settleSeconds}s.`
              : `Switched to ${label}.`,
          );
          // Sessions and limits on screen belong to the account we just left.
          setAgentsToken((t) => t + 1);
        })
        .catch((e: unknown) =>
          showToast(String(e).replace(/^Error:\s*/, ""), "error"),
        );
    },
  });

  const toggleDir = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      const ws = workspaceRef.current;
      if (ws) saveProjectState(ws, { expandedDirs: [...next] });
      return next;
    });
  }, []);

  const selectFile = useCallback((path: string) => {
    setOpenFile(path);
    const ws = workspaceRef.current;
    if (ws) saveProjectState(ws, { openFile: path });
  }, []);

  const closeFile = useCallback(() => {
    setOpenFile(null);
    const ws = workspaceRef.current;
    if (ws) saveProjectState(ws, { openFile: null });
  }, []);

  const commitSplit = useCallback((f: number) => {
    splitFraction.current = f;
    patchLayout({ splitFraction: f });
  }, []);

  const handleExit = useCallback((code: number | null) => setExitCode(code), []);

  const toggleInsight = useCallback(
    () => patchLayout({ insightOpen: !settings().layout.insightOpen }),
    [],
  );

  /**
   * Type a finished prompt into the running agent.
   *
   * It goes through the module-level session handle rather than a prop, because
   * anything that re-enters TerminalPane is one step closer to the effect that
   * kills and respawns the PTY. Focus follows it back to the terminal so the
   * user can add to the prompt and press Enter.
   */
  const insertPrompt = useCallback(
    (text: string) => {
      void ptyWriteActive(text)
        .then((sent) => {
          if (sent) setAgentFocus((t) => t + 1);
          else showToast("No agent is running to send a prompt to.", "error");
        })
        .catch(() => showToast("Could not reach the agent.", "error"));
    },
    [showToast],
  );

  // Both the agent list and the workspace must be resolved before spawning:
  // cwd is one of TerminalPane's effect deps, so spawning against a fallback
  // path and correcting it afterwards would kill and respawn the agent.
  const terminal =
    active && workspace ? (
      <div className="terminal-slot">
        <TerminalPane
          command={active.command}
          cwd={workspace}
          generation={generation}
          focusToken={agentFocus}
          onExit={handleExit}
        />
        {exitCode !== undefined && (
          <div className="exit-overlay">
            <p>
              {active.label} exited
              {exitCode === null ? "" : ` (code ${exitCode})`}
            </p>
            <button
              className="restart"
              onClick={() => {
                setExitCode(undefined);
                setGeneration((g) => g + 1);
              }}
            >
              Restart
            </button>
          </div>
        )}
      </div>
    ) : agents.length > 0 && !active ? (
      // The registry is never empty, so a populated `agents` with nothing
      // selected means every known agent failed its `--version` probe. Before
      // the Shell entry was dropped there was always a fallback and this state
      // could not happen; now it would sit on "Starting…" forever.
      <div className="empty">
        No coding agent found. Install Claude Code or opencode, then reopen
        Aditor.
      </div>
    ) : (
      <div className="empty">Starting…</div>
    );

  return (
    <>
      {/* The app stays mounted behind the chooser. Unmounting it to show the
          chooser would tear down TerminalPane -- so merely opening the chooser
          and cancelling would kill a live agent session. */}
      <div className="app" aria-hidden={picking} inert={picking}>
        <header className="topbar">
          <span className="brand">Aditor</span>
          <AgentPicker
            agents={agents}
            activeId={active?.id ?? null}
            onPick={pickAgent}
          />
          <div className="topbar-right">
            <button
              className="insight-toggle"
              data-open={insightOpen}
              aria-pressed={insightOpen}
              onClick={toggleInsight}
              title={insightOpen ? "Hide agent panel" : "Show agent panel"}
            >
              ◫
            </button>
            <button
              className="shortcuts-open"
              onClick={() => setTemplatesOpen(true)}
              title={chordHint("Prompt templates", "prompt.templates")}
              aria-label="Prompt templates"
            >
              ❝
            </button>
            <button
              className="shortcuts-open"
              onClick={() => setSettingsOpen(true)}
              title={chordHint("Settings", "app.settings")}
              aria-label="Settings"
            >
              ⚙
            </button>
            {repo?.isRepo && repo.branch && (
              <span className="branch" title="Current branch">
                {repo.branch}
              </span>
            )}
            <button
              className="cwd"
              onClick={() => setPicking(true)}
              title={chordHint(
                `${workspace ?? "…"} — click to switch project`,
                "project.open",
              )}
            >
              {(workspace ?? "").split("/").slice(-2).join("/") ||
                "Choose project…"}
            </button>
          </div>
        </header>

        <div className="body">
          <aside className="rail">
            {workspace ? (
              <>
                <ChangesList
                  files={repo?.files ?? []}
                  root={workspace}
                  // null = status not back yet, or it failed. Assume a repo so
                  // the transient body reads "No changes" rather than accusing
                  // a real repo of not being one.
                  isRepo={repo === null || repo.isRepo}
                  selected={openFile}
                  recent={recent}
                  onSelect={selectFile}
                />
                <FileTree
                  root={workspace}
                  selected={openFile}
                  onSelect={selectFile}
                  refreshToken={refreshToken}
                  expanded={expanded}
                  onToggle={toggleDir}
                  statuses={statuses}
                  recent={recent}
                  focusToken={filesFocus}
                />
              </>
            ) : (
              <div className="rail-placeholder">Files</div>
            )}
          </aside>

          <main className="main">
            {/* Always a SplitPane, even with no file open -- see the note in
                SplitPane: moving `terminal` in the tree would remount it and
                kill the agent's PTY. The editor simply claims no space until
                asked. */}
            <SplitPane
              initial={splitFraction.current}
              onCommit={commitSplit}
              top={terminal}
              bottom={
                openFile ? (
                  <BottomPane
                    path={openFile}
                    status={statuses.get(openFile) ?? null}
                    refreshToken={refreshToken}
                    onClose={closeFile}
                  />
                ) : null
              }
            />
          </main>

          {/* A sibling of <main>, never a wrapper around it: anything that
              remounts the subtree holding TerminalPane kills the agent's PTY. */}
          {insightOpen && workspace && (
            <>
              <div
                className="insight-resizer"
                role="separator"
                aria-orientation="vertical"
                data-dragging={resizing}
                onPointerDown={(e) => {
                  e.preventDefault();
                  setResizing(true);
                }}
              />
              <aside className="insight" style={{ width: insightWidth }}>
                <AgentSessions
                  agent={active}
                  workspace={workspace}
                  // Both are monotonic, so the sum changes whenever either does.
                  refreshToken={refreshToken + agentsToken}
                  onAccountChanged={() => setAgentsToken((t) => t + 1)}
                  onClose={toggleInsight}
                />
              </aside>
            </>
          )}
        </div>
      </div>

      {picking && (
        <ProjectPicker
          recents={recents}
          missing={missing}
          error={pickError}
          onOpen={(p) => void openProject(p)}
          onForget={forgetRecent}
          onBrowse={() => void browseForProject()}
          onCancel={workspace ? () => setPicking(false) : null}
          fitWindow={workspace === null}
        />
      )}

      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}

      {templatesOpen && (
        <TemplatePicker
          ctx={contextFrom(workspace, openFile, repo?.branch ?? null)}
          onInsert={insertPrompt}
          onClose={() => setTemplatesOpen(false)}
        />
      )}

      <Toast message={toast} onDone={hideToast} />
    </>
  );
}
