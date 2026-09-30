import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { AgentPicker } from "./components/AgentPicker";
import { InsightPanel } from "./components/InsightPanel";
import { ProjectPicker } from "./components/ProjectPicker";
import { TerminalPane } from "./components/TerminalPane";
import { FileTree } from "./components/FileTree";
import { ChangesList, type GitOp } from "./components/ChangesList";
import { BottomPane } from "./components/BottomPane";
import type { LineTarget } from "./components/FileViewer";
import { SplitPane } from "./components/SplitPane";
import { Toast, type ToastMessage } from "./components/Toast";
import { useShortcuts, type Handlers } from "./shortcuts/useShortcuts";
import { installAppMenu } from "./menu";
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
import {
  gitCommit,
  gitPull,
  gitPush,
  gitStage,
  gitStageAll,
  gitStatus,
  gitUnstage,
  gitUnstageAll,
  pathsOf,
  type FileStatus,
  type RepoStatus,
} from "./git/api";
import { agentWatch } from "./agents/api";
import { patch, patchLayout, settings, useSetting } from "./settings/store";
import type { RailTab } from "./settings/schema";
import { contextFrom } from "./templates/placeholders";
import {
  closeDiffWindow,
  growWindowToEditor,
  onDiffWindowClosed,
  openViewerWindow,
  openSettingsWindow,
  openTemplatesWindow,
  TEMPLATES_INSERT,
  type ViewerMode,
} from "./window";
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

/**
 * Narrower floor than the panel's: the rail holds paths, not prose. Counts the
 * 36px tab strip, so the panel beside it never drops under 160.
 */
const RAIL_MIN = 196;
const RAIL_MAX = 480;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Which pane edge is being dragged, if any. */
type Dragging = "rail" | "insight" | null;

/** A tooltip that names the chord, and stays honest once it is rebound. */
function chordHint(text: string, id: CommandId): string {
  const chord = chordFor(id);
  return chord ? `${text} (${formatChord(chord)})` : text;
}

/** Rail tab glyphs. Stroked in `currentColor`, so the tab state colours them. */
const FilesIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
    strokeWidth="1.3" strokeLinejoin="round" focusable="false" aria-hidden="true">
    <path d="M4.5 1.5h5l3 3v7a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z" />
    <path d="M9.5 1.5v3h3" />
    <path d="M1.5 5v8.5a1 1 0 0 0 1 1h7" strokeLinecap="round" />
  </svg>
);

const GitIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
    strokeWidth="1.3" strokeLinecap="round" focusable="false" aria-hidden="true">
    <circle cx="4.5" cy="3.5" r="1.75" />
    <circle cx="4.5" cy="12.5" r="1.75" />
    <circle cx="11.5" cy="5.5" r="1.75" />
    <path d="M4.5 5.25v5.5" />
    <path d="M11.5 7.25c0 2.5-2 3-5.4 4.1" />
  </svg>
);

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
  /** How the pane's file was opened: as the file (tree) or its diff (git). */
  const [openedAs, setOpenedAs] = useState<ViewerMode>("file");
  /** The line to show in the pane's file, when it came from a terminal link. */
  const [openLine, setOpenLine] = useState<LineTarget | null>(null);
  /**
   * The file in the side window, while it is the last one picked. Highlighted
   * in its place of `openFile`, which it does not replace: the pane is left
   * alone, and this is not restored with the project.
   */
  const [diffFile, setDiffFile] = useState<string | null>(null);
  useEffect(() => onDiffWindowClosed(() => setDiffFile(null)), []);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [refreshToken, setRefreshToken] = useState(0);
  const [repo, setRepo] = useState<RepoStatus | null>(null);
  const [gitBusy, setGitBusy] = useState<GitOp | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  /** Bumped by the commit shortcut; see ChangesList. */
  const [commitRequest, setCommitRequest] = useState(0);
  /** path -> when the watcher last saw it move. */
  const [recentAt, setRecentAt] = useState<Map<string, number>>(new Map());
  const splitFraction = useRef(settings().layout.splitFraction);

  // Straight from settings rather than mirrored into state: the General tab
  // sets the same field, and two copies would disagree.
  const insightOpen = useSetting((s) => s.layout.insightOpen);
  const [insightWidth, setInsightWidth] = useState(
    () => settings().layout.insightWidth,
  );
  const [railWidth, setRailWidth] = useState(() => settings().layout.railWidth);
  const railTab = useSetting((s) => s.layout.railTab);
  const setRailTab = (railTab: RailTab) => patchLayout({ railTab });
  const [resizing, setResizing] = useState<Dragging>(null);
  /** Bumped by `agents://changed`, separately from the workspace watcher. */
  const [agentsToken, setAgentsToken] = useState(0);

  // Focus is real DOM focus, so "focus the tree" cannot be state -- it is an
  // event. A counter is how the panes are asked to take the caret, matching
  // `generation` and `refreshToken` elsewhere here.
  const [filesFocus, setFilesFocus] = useState(0);
  const [gitFocus, setGitFocus] = useState(0);
  const [agentFocus, setAgentFocus] = useState(0);
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

  // Dragging either pane edge. A horizontal twin of SplitPane's divider rather
  // than a generalisation of it: SplitPane wraps the terminal, and reshaping it
  // risks the remount that would kill the PTY.
  //
  // The rail measures from the left edge and the panel from the right, so each
  // one grows towards the pointer. Settings are written on release rather than
  // per move: a drag is one decision, not a hundred.
  useEffect(() => {
    if (!resizing) return;
    const rail = resizing === "rail";
    const move = (e: PointerEvent) => {
      if (rail) setRailWidth(clamp(e.clientX, RAIL_MIN, RAIL_MAX));
      else
        setInsightWidth(
          clamp(window.innerWidth - e.clientX, INSIGHT_MIN, INSIGHT_MAX),
        );
    };
    const up = () => {
      setResizing(null);
      if (rail)
        setRailWidth((w) => {
          patchLayout({ railWidth: w });
          return w;
        });
      else
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
  const diffInWindow = useSetting((s) => s.layout.diffDisplay === "window");

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
    // The diff window shows a path in the old project; `git_diff` would now
    // refuse it as outside the workspace.
    if (workspaceRef.current !== root) void closeDiffWindow().catch(() => {});
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
    setDiffFile(null);
    setExpanded(new Set(state.expandedDirs));
    setRecentAt(new Map());
    setRepo(null);
    // A message drafted for one project is not meant for the next.
    setCommitMessage("");
    if (state.lastAgent) setAgentPref(state.lastAgent);
    setExitCode(undefined);
    setWorkspace(root);
    // Reopening the project that is already open sets `workspace` to the string
    // it already holds, so React bails out and every effect keyed on it stays
    // put -- including the one that fetches git status. `setRepo(null)` above
    // would then strand the changes list empty until the app restarted. The
    // token is the one dep those effects share, so bumping it reloads the tree
    // and the status whether or not the path actually changed.
    setRefreshToken((t) => t + 1);
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

  /**
   * Every git write goes through here: one at a time, errors in git's own
   * words, and a status refresh afterwards -- the watcher ignores `.git`, so
   * a stage or a commit would otherwise leave the list stale.
   */
  const gitBusyRef = useRef(false);
  const runGit = useCallback(
    async <T,>(op: GitOp, run: () => Promise<T>): Promise<T | undefined> => {
      if (gitBusyRef.current) return undefined;
      gitBusyRef.current = true;
      setGitBusy(op);
      try {
        return await run();
      } catch (e) {
        showToast(String(e).replace(/^Error:\s*/, ""), "error");
        return undefined;
      } finally {
        gitBusyRef.current = false;
        setGitBusy(null);
        setRefreshToken((t) => t + 1);
      }
    },
    [showToast],
  );

  const stageFile = useCallback(
    (f: FileStatus) => void runGit("stage", () => gitStage(pathsOf(f))),
    [runGit],
  );
  const unstageFile = useCallback(
    (f: FileStatus) => void runGit("stage", () => gitUnstage(pathsOf(f))),
    [runGit],
  );
  const stageAll = useCallback(() => void runGit("stage", gitStageAll), [runGit]);
  const unstageAll = useCallback(
    () => void runGit("stage", gitUnstageAll),
    [runGit],
  );
  const commit = useCallback(() => {
    const message = commitMessage;
    void runGit("commit", async () => {
      await gitCommit(message);
      // Only on success: a failed hook must not eat the message.
      setCommitMessage("");
    });
  }, [runGit, commitMessage]);
  const pull = useCallback(
    (rebase: boolean) =>
      void runGit("pull", async () => {
        await gitPull(rebase);
        showToast(rebase ? "Pulled and rebased." : "Pulled.");
      }),
    [runGit, showToast],
  );
  const push = useCallback(
    () =>
      void runGit("push", async () => {
        await gitPush();
        showToast("Pushed.");
      }),
    [runGit, showToast],
  );

  // Every shortcut the app has. The chords themselves live in the registry,
  // which is also what stops TerminalPane forwarding them to the agent --
  // ⌘O used to need a listener here and a line over there to work.
  //
  // The chooser is on top: the app behind it is inert, so nothing but closing
  // it should fire. Settings and the template picker are windows of their own
  // and leave this one fully usable.
  const blocked = picking;
  // Git needs a repo to act on; outside one a silent no-op would read as broken.
  const gitReady = () => {
    if (blocked || !workspace) return false;
    if (repo && !repo.isRepo) {
      showToast("This project is not a git repository.", "error");
      return false;
    }
    return true;
  };
  const commands: Handlers = {
    "project.open": () => setPicking(true),
    "app.settings": () => {
      if (picking) return;
      void openSettingsWindow().catch(() =>
        showToast("Could not open Settings.", "error"),
      );
    },
    "prompt.templates": () => {
      if (picking) return;
      // Nothing to type into, and a chooser that quietly did nothing would be
      // worse than saying so.
      if (!active || exitCode !== undefined) {
        showToast("No agent is running to send a prompt to.", "error");
        return;
      }
      void openTemplatesWindow(
        contextFrom(workspace, openFile, repo?.branch ?? null),
      ).catch(() => showToast("Could not open prompt templates.", "error"));
    },
    "focus.files": () => {
      if (blocked || !workspace) return;
      // Same batch as the token, so the tree is visible by the time its
      // focus effect runs.
      setRailTab("files");
      setFilesFocus((t) => t + 1);
    },
    "focus.git": () => {
      if (blocked || !workspace) return;
      setRailTab("git");
      setGitFocus((t) => t + 1);
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
    "git.commit": () => {
      if (!gitReady()) return;
      setRailTab("git");
      setCommitRequest((t) => t + 1);
    },
    "git.stageAll": () => {
      if (gitReady()) stageAll();
    },
    "git.pull": () => {
      if (gitReady()) pull(false);
    },
    "git.pullRebase": () => {
      if (gitReady()) pull(true);
    },
    "git.push": () => {
      if (gitReady()) push();
    },
  };
  useShortcuts(commands);

  // The menu bar runs the very same handlers, so a command means one thing
  // whether it arrives by chord, by button or by menu -- including the guards
  // that make it a no-op while a dialog is up. They are read through a ref
  // because they close over this render's state, and the native menu is built
  // once.
  const commandsRef = useRef(commands);
  useEffect(() => {
    commandsRef.current = commands;
  });
  useEffect(() => {
    void installAppMenu((id) => commandsRef.current[id]?.());
  }, []);

  const toggleDir = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      const ws = workspaceRef.current;
      if (ws) saveProjectState(ws, { expandedDirs: [...next] });
      return next;
    });
  }, []);

  /**
   * Open `path` as the file (from the tree) or as its diff (from the git
   * list). Each goes to the side window when its setting says so, and only
   * there -- the pane is left as it was.
   */
  const openPath = useCallback((path: string, as: ViewerMode, line?: number) => {
    const { diffDisplay, fileDisplay } = settings().layout;
    if ((as === "diff" ? diffDisplay : fileDisplay) === "window") {
      void openViewerWindow(path, as, line);
      setDiffFile(path);
      return;
    }
    setDiffFile(null);
    setOpenFile(path);
    setOpenedAs(as);
    // A fresh token even for the same line: the user may have scrolled away.
    setOpenLine(line === undefined ? null : { line, token: Date.now() });
    const ws = workspaceRef.current;
    if (ws) saveProjectState(ws, { openFile: path });
  }, []);
  const openFromTree = useCallback((path: string) => openPath(path, "file"), [openPath]);
  const openFromGit = useCallback((path: string) => openPath(path, "diff"), [openPath]);
  const openFromTerminal = useCallback(
    (path: string, line?: number) => openPath(path, "file", line),
    [openPath],
  );

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

  // The picker lives in its own window, but the agent's PTY lives in this one,
  // so a chosen prompt comes back here to be typed. Focus follows it, so the
  // user lands in the terminal ready to add to it.
  useEffect(() => {
    const unlisten = listen<string>(TEMPLATES_INSERT, ({ payload }) => {
      void getCurrentWindow()
        .setFocus()
        .catch(() => {});
      insertPrompt(payload);
    });
    return () => void unlisten.then((u) => u());
  }, [insertPrompt]);

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
          onOpenPath={openFromTerminal}
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
          {/* The project is what this window is, so it leads where the app's
              own name used to sit. The branch rides along: both answer "where
              am I working?", and splitting them across the bar made you look
              in two places for one fact. */}
          <div className="topbar-project">
            <button
              className="cwd"
              onClick={() => setPicking(true)}
              title={chordHint(
                `${workspace ?? "…"} — click to switch project`,
                "project.open",
              )}
            >
              {(workspace ?? "").split("/").filter(Boolean).pop() ||
                "Choose project…"}
            </button>
            {repo?.isRepo && repo.branch && (
              <span className="branch" title="Current branch">
                {repo.branch}
              </span>
            )}
          </div>
          <AgentPicker
            agents={agents}
            activeId={active?.id ?? null}
            onPick={pickAgent}
          />
          <div className="topbar-right">
            <button
              className="shortcuts-open"
              onClick={() => commands["prompt.templates"]?.()}
              title={chordHint("Prompt templates", "prompt.templates")}
              aria-label="Prompt templates"
            >
              ❝
            </button>
            <button
              className="shortcuts-open"
              onClick={() => commands["app.settings"]?.()}
              title={chordHint("Settings", "app.settings")}
              aria-label="Settings"
            >
              ⚙
            </button>
          </div>
        </header>

        <div className="body">
          <aside className="rail" style={{ width: railWidth }}>
            {workspace ? (
              <>
                <nav
                  className="rail-tabs"
                  role="tablist"
                  aria-orientation="vertical"
                >
                  <button
                    className="rail-tab"
                    role="tab"
                    aria-selected={railTab === "files"}
                    aria-label="Files"
                    title={chordHint("Files", "focus.files")}
                    onClick={() => setRailTab("files")}
                  >
                    <FilesIcon />
                  </button>
                  <button
                    className="rail-tab"
                    role="tab"
                    aria-selected={railTab === "git"}
                    aria-label="Git"
                    title={chordHint("Git", "focus.git")}
                    onClick={() => setRailTab("git")}
                  >
                    <GitIcon />
                    {(repo?.files.length ?? 0) > 0 && (
                      <span className="rail-tab-badge">{repo!.files.length}</span>
                    )}
                  </button>
                </nav>
                {/* Both stay mounted and the other is hidden: remounting the
                    tree would reload it and lose its scroll, and remounting the
                    changes would drop the commit box's caret and undo. */}
                <div className="rail-panel">
                  <div hidden={railTab !== "files"}>
                    <FileTree
                      root={workspace}
                      selected={diffFile ?? openFile}
                      onSelect={openFromTree}
                      refreshToken={refreshToken}
                      expanded={expanded}
                      onToggle={toggleDir}
                      statuses={statuses}
                      recent={recent}
                      focusToken={filesFocus}
                    />
                  </div>
                  <div hidden={railTab !== "git"}>
                    <ChangesList
                      files={repo?.files ?? []}
                      root={workspace}
                      // null = status not back yet, or it failed. Assume a repo so
                      // the transient body reads "No changes" rather than accusing
                      // a real repo of not being one.
                      isRepo={repo === null || repo.isRepo}
                      upstream={repo?.upstream ?? null}
                      ahead={repo?.ahead ?? 0}
                      behind={repo?.behind ?? 0}
                      selected={diffFile ?? openFile}
                      recent={recent}
                      onSelect={openFromGit}
                      message={commitMessage}
                      onMessage={setCommitMessage}
                      busy={gitBusy}
                      commitRequest={commitRequest}
                      focusToken={gitFocus}
                      onStage={stageFile}
                      onUnstage={unstageFile}
                      onStageAll={stageAll}
                      onUnstageAll={unstageAll}
                      onCommit={commit}
                      onPull={pull}
                      onPush={push}
                    />
                  </div>
                </div>
              </>
            ) : (
              <div className="rail-placeholder">Files</div>
            )}
          </aside>

          <div
            className="rail-resizer"
            role="separator"
            aria-orientation="vertical"
            data-dragging={resizing === "rail"}
            onPointerDown={(e) => {
              e.preventDefault();
              setResizing("rail");
            }}
          />

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
                    diffInWindow={diffInWindow}
                    openedAs={openedAs}
                    target={openLine}
                    onClose={closeFile}
                  />
                ) : null
              }
            />
          </main>

          {/* A sibling of <main>, never a wrapper around it: anything that
              remounts the subtree holding TerminalPane kills the agent's PTY.
              Swapping the panel for the stub keeps <main> in place, so the
              terminal survives a collapse. */}
          {workspace && !insightOpen && (
            <button
              className="insight-stub"
              onClick={toggleInsight}
              title="Show agent panel"
              aria-label="Show agent panel"
            >
              ◫
            </button>
          )}

          {insightOpen && workspace && (
            <>
              <div
                className="insight-resizer"
                role="separator"
                aria-orientation="vertical"
                data-dragging={resizing === "insight"}
                onPointerDown={(e) => {
                  e.preventDefault();
                  setResizing("insight");
                }}
              />
              <aside className="insight" style={{ width: insightWidth }}>
                <InsightPanel
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

      <Toast message={toast} onDone={hideToast} />
    </>
  );
}
