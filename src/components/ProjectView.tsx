import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { BranchPicker, type BranchAction } from "./BranchPicker";
import { InsightPanel } from "./InsightPanel";
import { TerminalPane, type RunSpec } from "./TerminalPane";
import { RunPicker } from "./RunPicker";
import { RunConfigDialog } from "./RunConfigDialog";
import { FileTree } from "./FileTree";
import { ChangesList, type GitOp, type ListRequest } from "./ChangesList";
import { GIT_CHANGED, type GitChanged } from "./LogWindow";
import { PushDialog } from "./PushDialog";
import { FindPopup, type FindMode } from "./FindPopup";
import { refNameError, useDialogs } from "./Modal";
import { BottomPane } from "./BottomPane";
import type { LineTarget } from "./FileViewer";
import { SplitPane } from "./SplitPane";
import { SessionTabs, type FileTab, type SessionTab } from "./SessionTabs";
import { AgentPrompt } from "./AgentPrompt";
import type { ToastMessage } from "./Toast";
import type { Handlers } from "../shortcuts/useShortcuts";
import { chordHint } from "../shortcuts/store";
import { switchToNextAccount } from "../accounts/next";
import { ptyKill, ptyPaste, ptyWriteActive, SHELL_SESSION, type AgentInfo } from "../pty/api";
import { useRunConfigs } from "../run/useRunConfigs";
import { RUN_FILE, runOutput } from "../run/api";
import { toScript } from "../run/command";
import { launchChain, type RunConfig } from "../run/schema";
import { createFile, FS_GIT, fsDebounceMs, type FsChanged, type FsGit } from "../fs/api";
import {
  gitBranchCreate,
  gitBranchDelete,
  gitBranchRename,
  gitCheckout,
  gitCommit,
  gitFetch,
  gitLog,
  gitMerge,
  gitOperationAbort,
  gitOperationContinue,
  gitPull,
  gitPush,
  gitRebase,
  gitRollback,
  gitStage,
  gitStageAll,
  gitStatus,
  gitTagCreate,
  gitUnstage,
  gitUnstageAll,
  pathsOf,
  type BranchInfo,
  type FileStatus,
  type RepoStatus,
} from "../git/api";
import { agentWatch, type AgentsChanged, type SessionSummary } from "../agents/api";
import { patch, patchLayout, settings, useSetting } from "../settings/store";
import type { RailTab } from "../settings/schema";
import { contextFrom } from "../templates/placeholders";
import { notify, onPtyStatus, type Attention } from "../notify/api";
import {
  mcpAnswer,
  onOpenRequest,
  onPrompt,
  onPromptCancel,
  type McpPrompt,
  type PromptAnswer,
} from "../mcp/api";
import {
  basename,
  onDiffWindowClosed,
  openLogWindow,
  openViewerWindow,
  openTemplatesWindow,
  type ViewerMode,
} from "../window";
import { loadProjectState, saveProjectState, setWritable } from "../projects";
import { worktreeCreate, worktreeLabel, type WorktreeInfo } from "../worktree/api";

/** How long a watcher-touched path stays accented. */
const RECENT_MS = 8000;
/** How many opened files Find file remembers for its empty query. */
const RECENT_FILES = 20;

/**
 * Debounce for `agents://changed`. Coarser than the file watcher's: a live
 * transcript is appended many times within a single turn, and every event
 * means re-reading its tail.
 */
const AGENT_DEBOUNCE_MS = 400;

/** Which pane edge is being dragged, if any. Owned by App: the widths are
 *  window furniture, shared by every project tab. */
export type Dragging = "rail" | "insight" | null;

/** What a mounted project offers the window around it. */
export interface ViewApi {
  /** This project's commands, run while its tab is the active one. */
  handlers: Handlers;
  /** Type a finished prompt into the session on screen. */
  insertPrompt(text: string): void;
}

/** One agent CLI in this project, behind its own session tab. */
interface Session {
  key: number;
  agentId: string;
  /** Per agent, from 1, fixed at creation: "Claude Code 2" stays 2. */
  n: number;
  /** Bumping this respawns the session. */
  generation: number;
  /** undefined while running; null or a code once it has exited. */
  exitCode: number | null | undefined;
  /** The Claude Code session it continues; restarting continues it again. */
  resumeId?: string;
  /** What the resumed session was called, for its tab. */
  title?: string;
  /** Its PTY, once spawned: how events about it are recognised as ours. */
  ptyId?: string;
  /** What the agent last reported: "busy", "idle", "waiting". Claude Code only. */
  status?: string;
  /** It finished, or is blocked on the user, while not on screen. */
  attention?: Attention;
  /** A run configuration's process rather than an agent: `agentId` is "run". */
  run?: RunSession;
}

/** What a run tab runs. The spec is fixed per launch, so a rerun picks up an
 *  edit to the configuration and a mere re-render never respawns. */
interface RunSession {
  configId: string;
  name: string;
  spec: RunSpec;
}

/** `agentId` of a run tab: no agent has it. */
const RUN_AGENT = "run";

/** What a session's attention notice says it is waiting on. */
function promptDetail(p: McpPrompt): string {
  switch (p.kind) {
    case "ask":
      return p.question;
    case "review":
      return "review your changes";
    case "run":
      return `start ${p.name}`;
  }
}

/** Lines of a run's output "Send to agent" pastes. */
const SEND_LINES = 80;

/** A resumed session's title, short enough for a tab. */
function tabTitle(title: string): string {
  return title.length > 28 ? `${title.slice(0, 27)}…` : title;
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

const NewFileIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
    strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" focusable="false"
    aria-hidden="true">
    <path d="M9.5 1.5h-5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-9l-3-3z" />
    <path d="M9.5 1.5v3h3M8 7.5v4M6 9.5h4" />
  </svg>
);

/** What a new file's name may not be. Live, so it reads as you type. */
function newFileError(text: string): string | null {
  const t = text.trim();
  if (t === "") return null;
  if (t.startsWith("/")) return "Give a path inside the project, not an absolute one.";
  if (t.split("/").includes("..")) return "Stay inside the project: no `..`.";
  if (t.endsWith("/")) return "Give the file a name after the folder.";
  return null;
}

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

interface Props {
  /** Canonical workspace root, as `open_workspace` returned it. Never changes
   *  for a mounted view: App keys each view by it. */
  root: string;
  /** This project's tab is the one on screen. */
  active: boolean;
  agents: AgentInfo[];
  railWidth: number;
  insightWidth: number;
  resizing: Dragging;
  onResizeStart(edge: "rail" | "insight"): void;
  /** The topbar's project name: back to the chooser. */
  onPickProject(): void;
  /** The topbar's gear: Settings is the window's, not the project's. */
  onOpenSettings(): void;
  showToast(text: string, tone?: ToastMessage["tone"]): void;
  /** Publish (or, with null, withdraw) what App can ask of this project. */
  register(root: string, api: ViewApi | null): void;
  /** Whether any of this project's agents is still running, for the tab dot. */
  onRunning(root: string, running: boolean): void;
  /** How many of this project's sessions want the user, for the tab dot and Dock badge. */
  onAttention(root: string, count: number): void;
  /** Set when this project is a worktree Aditor made for a session. */
  worktree: WorktreeInfo | null;
  /** Open a worktree just made from this project as a tab of its own. */
  onOpenWorktree(info: WorktreeInfo): void;
}

/**
 * One open project: its rail, its terminal sessions, its viewer and its agent
 * panel. App mounts one per project tab and hides all but the active one --
 * never unmounts it while the tab is open, because that kills its agents.
 */
export function ProjectView({
  root,
  active,
  agents,
  railWidth,
  insightWidth,
  resizing,
  onResizeStart,
  onPickProject,
  onOpenSettings,
  showToast,
  register,
  onRunning,
  onAttention,
  worktree,
  onOpenWorktree,
}: Props) {
  // What the project remembers, read once: this view lives as long as its tab.
  const [saved] = useState(() => loadProjectState(root));
  /** Agent to start: the project's, else the last one used anywhere. */
  const [agentPref, setAgentPref] = useState<string | null>(
    () => saved.lastAgent ?? settings().lastAgent,
  );

  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeKey, setActiveKey] = useState<number | null>(null);
  const nextKey = useRef(1);
  const seeded = useRef(false);

  /** Files open as tabs beside the sessions, when files open in tabs. */
  const tabbed = settings().layout.fileDisplay === "tab";
  /** The file in the bottom pane. */
  const [openFile, setOpenFile] = useState<string | null>(tabbed ? null : saved.openFile);
  /** Files open as tabs after the sessions, in the order they were opened. */
  const [fileTabs, setFileTabs] = useState<string[]>(() =>
    tabbed && saved.openFile ? [saved.openFile] : [],
  );
  /** The file tab on screen, or null while a session is. */
  const [fileShown, setFileShown] = useState<string | null>(null);
  /** The line to show in the shown file tab, from a terminal link. */
  const [tabLine, setTabLine] = useState<LineTarget | null>(null);
  /** The file being looked at in this window, wherever it is shown. */
  const viewedFile = fileShown ?? openFile;
  /** Files opened in this window, newest first and relative: Find file's empty list. */
  const [recentFiles, setRecentFiles] = useState<string[]>(() =>
    saved.openFile?.startsWith(`${root}/`) ? [saved.openFile.slice(root.length + 1)] : [],
  );
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
  /** The find popup's mode while it is up. */
  const [finding, setFinding] = useState<FindMode | null>(null);
  useEffect(() => onDiffWindowClosed(() => setDiffFile(null)), []);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(saved.expandedDirs));
  const [refreshToken, setRefreshToken] = useState(0);
  /**
   * Bumped when git moved outside Aditor -- a commit in a terminal touches
   * only `.git`. Re-reads the status alone; the tree has nothing new to list.
   */
  const [gitToken, setGitToken] = useState(0);
  /**
   * What the watcher saw move in the tick that last bumped `refreshToken`, so
   * the tree re-lists only those directories. Null means everything, for the
   * refreshes that do not come from the watcher.
   */
  const [treeChanges, setTreeChanges] = useState<ReadonlySet<string> | null>(null);
  const [repo, setRepo] = useState<RepoStatus | null>(null);
  const [gitBusy, setGitBusy] = useState<GitOp | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  /** Bumped by the commit shortcut; see ChangesList. */
  const [commitRequest, setCommitRequest] = useState(0);
  /** ⌘⌥Z / ⌘D, aimed at the changes list's cursor. */
  const [listRequest, setListRequest] = useState<ListRequest | null>(null);
  /** Bumped by the annotate command; the bottom pane toggles its gutter. */
  const [annotateRequest, setAnnotateRequest] = useState(0);
  /** Bumped by Branches…: the topbar's branch menu opens. */
  const [branchesRequest, setBranchesRequest] = useState(0);
  const [pushing, setPushing] = useState(false);
  const [dialogs, ask] = useDialogs();
  /** path -> when the watcher last saw it move. */
  const [recentAt, setRecentAt] = useState<Map<string, number>>(new Map());
  const splitFraction = useRef(settings().layout.splitFraction);

  // Straight from settings rather than mirrored into state: the General tab
  // sets the same field, and two copies would disagree.
  const insightOpen = useSetting((s) => s.layout.insightOpen);
  const railTab = useSetting((s) => s.layout.railTab);
  const setRailTab = (railTab: RailTab) => patchLayout({ railTab });
  /** Bumped by `agents://changed`, separately from the workspace watcher. */
  const [agentsToken, setAgentsToken] = useState(0);

  // Focus is real DOM focus, so "focus the tree" cannot be state -- it is an
  // event. A counter is how the panes are asked to take the caret, matching
  // `generation` and `refreshToken` elsewhere here.
  const [filesFocus, setFilesFocus] = useState(0);
  const [gitFocus, setGitFocus] = useState(0);
  const [agentFocus, setAgentFocus] = useState(0);

  /** Everything a session can run: the probed agents, and a plain shell. */
  const runnable = useMemo(() => [...agents, SHELL_SESSION], [agents]);
  const agentById = useCallback(
    (id: string | null | undefined) => runnable.find((a) => a.id === id) ?? null,
    [runnable],
  );
  /** What + offers: installed agents first, then the terminal. */
  const choices = useMemo(() => runnable.filter((a) => a.available), [runnable]);
  /** Bumped by ⌘T: the session strip opens its + menu. */
  const [newRequest, setNewRequest] = useState(0);
  /** The preference against what is actually installed. */
  const resolveAgent = useCallback(
    (pref: string | null) =>
      agents.find((a) => a.id === pref && a.available) ??
      agents.find((a) => a.available) ??
      null,
    [agents],
  );

  const current = sessions.find((s) => s.key === activeKey) ?? null;
  const currentAgent = agentById(current?.agentId);
  // A plain terminal has no sessions or limits to show, so with one on screen
  // the panel stays on the project's agent: one open here, else the preferred.
  const panelAgent =
    currentAgent && currentAgent.id !== SHELL_SESSION.id
      ? currentAgent
      : (agentById(sessions.find((s) => s.agentId !== SHELL_SESSION.id && !s.run)?.agentId) ??
        resolveAgent(agentPref));
  const running = sessions.some((s) => s.exitCode === undefined);
  const watchClaude = sessions.some((s) => s.agentId === "claude");

  const addSession = useCallback(
    (agent: AgentInfo, resume?: { id: string; title?: string }) => {
      const key = nextKey.current++;
      setSessions((prev) => {
        const n = Math.max(0, ...prev.filter((s) => s.agentId === agent.id).map((s) => s.n)) + 1;
        return [
          ...prev,
          {
            key,
            agentId: agent.id,
            n,
            generation: 0,
            exitCode: undefined,
            resumeId: resume?.id,
            title: resume?.title,
          },
        ];
      });
      setActiveKey(key);
    },
    [],
  );

  // The first session starts once the agent list is in: spawning against a
  // fallback and correcting it afterwards would kill and respawn the agent.
  useEffect(() => {
    if (seeded.current || agents.length === 0) return;
    seeded.current = true;
    const agent = resolveAgent(agentPref);
    if (agent) addSession(agent);
  }, [agents, agentPref, resolveAgent, addSession]);

  useEffect(() => onRunning(root, running), [root, running, onRunning]);

  // Watcher -> debounced refresh. The payload also feeds the "just changed"
  // accent, which is what separates "the agent touched this a moment ago" from
  // "this has been dirty all morning" -- git alone cannot tell those apart.
  useEffect(() => {
    let timer: number | undefined;
    let debounce = 150;
    void fsDebounceMs().then((ms) => (debounce = ms));
    let batch = new Set<string>();

    const unlisten = listen<FsChanged>("fs://changed", ({ payload }) => {
      if (payload.root !== root) return;
      const now = Date.now();
      setRecentAt((prev) => {
        const next = new Map(prev);
        for (const p of payload.paths) next.set(p, now);
        return next;
      });
      for (const p of payload.paths) batch.add(p);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const paths = batch;
        batch = new Set();
        setTreeChanges(paths);
        setRefreshToken((t) => t + 1);
      }, debounce);
    });
    return () => {
      window.clearTimeout(timer);
      void unlisten.then((u) => u());
    };
  }, [root]);

  // The log window rewrites history too; the changes list must follow.
  useEffect(() => {
    const unlisten = listen<GitChanged>(GIT_CHANGED, ({ payload }) => {
      if (payload?.root !== root) return;
      setTreeChanges(null);
      setRefreshToken((t) => t + 1);
    });
    return () => void unlisten.then((u) => u());
  }, [root]);

  // Git moved under us: a commit, stage or checkout from a terminal. A commit
  // touches the index, HEAD and a ref in one burst, hence the debounce.
  // Regaining focus re-reads too, for whatever the watcher coalesced away.
  useEffect(() => {
    let timer: number | undefined;
    let debounce = 150;
    void fsDebounceMs().then((ms) => (debounce = ms));
    const bump = () => setGitToken((t) => t + 1);
    const unGit = listen<FsGit>(FS_GIT, ({ payload }) => {
      if (payload.root !== root) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(bump, debounce);
    });
    const unFocus = getCurrentWindow().onFocusChanged(({ payload }) => payload && bump());
    return () => {
      window.clearTimeout(timer);
      void unGit.then((u) => u());
      void unFocus.then((u) => u());
    };
  }, [root]);

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
    let stale = false;
    gitStatus(root)
      .then((s) => !stale && setRepo(s))
      .catch(() => !stale && setRepo(null));
    return () => {
      stale = true;
    };
  }, [root, refreshToken, gitToken]);

  // Watch the agent's own state so the panel keeps up during a turn. Only
  // Claude Code has state to watch; any of this project's sessions running it
  // is enough. The backend makes a repeat call for the same root a no-op.
  useEffect(() => {
    void agentWatch(root, watchClaude ? "claude" : "none").catch(() => {
      /* the panel still refreshes with the rest of the tree */
    });
  }, [root, watchClaude]);

  useEffect(() => {
    let timer: number | undefined;
    const unlisten = listen<AgentsChanged>("agents://changed", ({ payload }) => {
      if (payload.root !== root) return;
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
  }, [root]);

  const statuses = useMemo(
    () => new Map((repo?.files ?? []).map((f) => [f.path, f.status])),
    [repo],
  );
  const recent = useMemo(() => new Set(recentAt.keys()), [recentAt]);
  const diffInWindow = useSetting((s) => s.layout.diffDisplay === "window");

  // ------------------------------------------------------------ sessions ---

  /**
   * Run tabs something is waiting on to exit -- a configuration whose
   * before-launch this is. Settled with the exit code, or null when the tab
   * closes or reruns first and no exit will come.
   */
  // Read at call time by the listeners and run callbacks below, which are not
  // rebuilt on every session change.
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const runWaiters = useRef(new Map<number, (code: number | null) => void>());
  const settleRun = useCallback((key: number, code: number | null) => {
    const waiter = runWaiters.current.get(key);
    runWaiters.current.delete(key);
    waiter?.(code);
  }, []);

  /** The agent to start next time here and in new projects. A plain terminal
   *  is a one-off, never what a project opens with. */
  const rememberAgent = useCallback(
    (agent: AgentInfo) => {
      if (agent.id === SHELL_SESSION.id) return;
      patch({ lastAgent: agent.id });
      saveProjectState(root, { lastAgent: agent.id });
      setAgentPref(agent.id);
    },
    [root],
  );

  /** + in the session strip: an agent, or a plain terminal in this folder. */
  const startSession = useCallback(
    (agent: AgentInfo) => {
      rememberAgent(agent);
      addSession(agent);
    },
    [rememberAgent, addSession],
  );

  const worktreeAgent =
    repo?.isRepo ? (agents.find((a) => a.id === "claude" && a.available) ?? null) : null;

  /**
   * + in the session strip: Claude Code on a new branch in a worktree of its
   * own, opened as a project tab -- so its tree, changes and runs are that
   * checkout's, and parallel agents never edit the same files.
   */
  const newWorktreeSession = useCallback(async () => {
    const r = await ask({
      title: "New Worktree Session",
      body: (
        <>
          A new branch off <code>{repo?.branch ?? "HEAD"}</code>, checked out in its own folder
          and opened as a project tab with Claude Code running.
        </>
      ),
      input: { label: "Branch name", initial: `wt-${Date.now().toString(36).slice(-4)}` },
      confirm: "Create",
      validate: refNameError,
    });
    if (!r) return;
    let info: WorktreeInfo;
    try {
      info = await worktreeCreate(root, r.text.trim());
    } catch (e) {
      showToast(String(e), "error");
      return;
    }
    // The new tab seeds its first session from the project's agent.
    saveProjectState(info.path, { lastAgent: "claude" });
    onOpenWorktree(info);
  }, [ask, repo?.branch, root, showToast, onOpenWorktree]);

  // ⌘T asks the same question as +. With no session strip on screen there is
  // nothing to ask from, so it starts the project's agent straight away.
  const newSession = useCallback(() => {
    if (sessions.length > 0) {
      setNewRequest((t) => t + 1);
      return;
    }
    const agent = resolveAgent(agentPref);
    if (agent) addSession(agent);
    else showToast("No coding agent is installed to start.", "error");
  }, [sessions.length, resolveAgent, agentPref, addSession, showToast]);

  const sessionLabel = useCallback(
    (s: Session) => {
      if (s.run) {
        const twins = sessions.filter((o) => o.run?.configId === s.run?.configId).length;
        return twins > 1 ? `${s.run.name} ${s.n}` : s.run.name;
      }
      if (s.title) return tabTitle(s.title);
      const label = agentById(s.agentId)?.label ?? s.agentId;
      const twins = sessions.filter((o) => o.agentId === s.agentId).length;
      return twins > 1 || s.n > 1 ? `${label} ${s.n}` : label;
    },
    [sessions, agentById],
  );

  const closeSession = useCallback(
    async (key: number) => {
      const s = sessions.find((o) => o.key === key);
      if (!s) return;
      if (s.exitCode === undefined) {
        const r = await ask({
          title: "Close Session",
          body: <>{sessionLabel(s)} is still running. Closing the tab stops it.</>,
          confirm: "Close",
          danger: true,
        });
        if (!r) return;
      }
      // The neighbour takes over, as closing a tab does anywhere else.
      const at = sessions.findIndex((o) => o.key === key);
      const rest = sessions.filter((o) => o.key !== key);
      const neighbour = rest[Math.min(at, rest.length - 1)]?.key ?? null;
      setSessions((prev) => prev.filter((o) => o.key !== key));
      setActiveKey((cur) => (cur === key ? neighbour : cur));
      // Whatever waited on it -- a run's before-launch -- will not see an exit.
      settleRun(key, null);
    },
    [sessions, ask, sessionLabel, settleRun],
  );

  /** Next or previous tab, sessions and files alike, as the strip shows them. */
  const cycleSession = useCallback(
    (step: number) => {
      const items: (number | string)[] = [...sessions.map((s) => s.key), ...fileTabs];
      if (items.length < 2) return;
      const at = items.indexOf(fileShown ?? activeKey ?? -1);
      const next = items[(at + step + items.length) % items.length];
      if (typeof next === "string") {
        setTabLine(null);
        setFileShown(next);
      } else {
        setFileShown(null);
        setActiveKey(next);
      }
    },
    [sessions, activeKey, fileTabs, fileShown],
  );

  /** ⌘1-⌘8 pick a tab by position, files included; ⌘9 always the last. */
  const gotoSession = useCallback(
    (n: number) => {
      const items: (number | string)[] = [...sessions.map((s) => s.key), ...fileTabs];
      const target = items[n === 9 ? items.length - 1 : n - 1];
      if (target === undefined) return;
      if (typeof target === "string") {
        setTabLine(null);
        setFileShown(target);
        saveProjectState(root, { openFile: target });
      } else {
        setFileShown(null);
        setActiveKey(target);
      }
    },
    [sessions, fileTabs, root],
  );

  // A session coming to the front -- picked, started, or a run launched --
  // takes the screen back from a file tab.
  useEffect(() => setFileShown(null), [activeKey]);

  const setPtyId = useCallback((key: number, ptyId: string) => {
    setSessions((prev) => prev.map((s) => (s.key === key ? { ...s, ptyId } : s)));
  }, []);

  /**
   * A row in the agent panel: continue that Claude Code session in a new tab.
   * One already running in a tab of ours is shown instead, and one running in
   * some other terminal is resumed only on confirmation -- two processes
   * appending to one transcript fork the conversation.
   */
  const resumeSession = useCallback(
    async (summary: SessionSummary) => {
      const live = summary.live;
      if (live?.ptyId) {
        const mine = sessions.find((s) => s.ptyId === live.ptyId);
        if (mine) {
          setActiveKey(mine.key);
          setAgentFocus((t) => t + 1);
          return;
        }
      }
      const claude = agents.find((a) => a.id === "claude" && a.available);
      if (!claude) {
        showToast("Claude Code is not installed.", "error");
        return;
      }
      if (live) {
        const r = await ask({
          title: "Resume Session",
          body: (
            <>
              This session is still running in another terminal. Resuming it here
              starts a second copy, and the two continue separately.
            </>
          ),
          confirm: "Resume",
        });
        if (!r) return;
      }
      addSession(claude, { id: summary.id, title: summary.title ?? undefined });
    },
    [sessions, agents, ask, addSession, showToast],
  );

  const setExit = useCallback(
    (key: number, code: number | null) => {
      setSessions((prev) =>
        prev.map((s) => (s.key === key ? { ...s, exitCode: code, status: undefined } : s)),
      );
      settleRun(key, code);
    },
    [settleRun],
  );

  const restart = useCallback((key: number) => {
    setSessions((prev) =>
      prev.map((s) =>
        s.key === key
          ? { ...s, generation: s.generation + 1, exitCode: undefined, status: undefined, attention: undefined }
          : s,
      ),
    );
  }, []);

  // ---------------------------------------------------------------- runs ---

  const runs = useRunConfigs(root);
  const [runSelectedId, setRunSelectedId] = useState<string | null>(saved.lastRunConfig);
  const runSelected =
    runs.configs.find((c) => c.id === runSelectedId) ?? runs.configs[0] ?? null;
  const [editingRuns, setEditingRuns] = useState(false);
  /** Bumped by "Choose run configuration…": the topbar's run menu opens. */
  const [runMenuRequest, setRunMenuRequest] = useState(0);
  const runningOf = (id: string | undefined) =>
    sessions.filter((s) => s.run?.configId === id && s.exitCode === undefined);

  const selectRun = useCallback(
    (id: string) => {
      setRunSelectedId(id);
      saveProjectState(root, { lastRunConfig: id });
    },
    [root],
  );

  const runSpec = useCallback(
    (c: RunConfig): RunSpec => ({
      root,
      script: toScript(c, runs.context),
      cwd: c.cwd,
      env: c.env,
      name: c.name,
      configId: c.id,
    }),
    [root, runs.context],
  );

  /**
   * Start `c` in a tab and resolve with its exit code. A tab of the same
   * configuration is reused when it has exited, or -- for a single-instance
   * one -- even while it runs, which restarts it; otherwise a new tab opens.
   * `focus` false leaves the session on screen where it is: an agent's start.
   */
  const launchRun = useCallback(
    (c: RunConfig, focus: boolean): Promise<number | null> => {
      const run: RunSession = { configId: c.id, name: c.name, spec: runSpec(c) };
      const mine = sessionsRef.current.filter((s) => s.run?.configId === c.id);
      const reuse =
        (c.singleInstance ? mine[0] : undefined) ?? mine.find((s) => s.exitCode !== undefined);
      let key: number;
      if (reuse) {
        key = reuse.key;
        // The process it replaces will never report its exit.
        settleRun(key, null);
        setSessions((prev) =>
          prev.map((s) =>
            s.key === key
              ? { ...s, run, generation: s.generation + 1, exitCode: undefined, attention: undefined }
              : s,
          ),
        );
      } else {
        key = nextKey.current++;
        setSessions((prev) => {
          const n =
            Math.max(0, ...prev.filter((s) => s.run?.configId === c.id).map((s) => s.n)) + 1;
          return [
            ...prev,
            { key, agentId: RUN_AGENT, n, generation: 0, exitCode: undefined, run },
          ];
        });
      }
      if (focus) setActiveKey(key);
      return new Promise((resolve) => runWaiters.current.set(key, resolve));
    },
    [runSpec, settleRun],
  );

  /** Run configuration `id`, after its before-launch chain has succeeded. */
  const runConfig = useCallback(
    async (id: string, focus = true) => {
      const chain = launchChain(runs.configs, id);
      if (!chain || chain.length === 0) {
        showToast("Its before-launch steps run in a circle; fix them in Edit Configurations.", "error");
        return;
      }
      selectRun(id);
      for (const step of chain.slice(0, -1)) {
        const code = await launchRun(step, focus);
        if (code !== 0) {
          showToast(
            `${step.name} ${code === null ? "was stopped" : `failed with exit code ${code}`}, so ${chain[chain.length - 1].name} did not run.`,
            "error",
          );
          return;
        }
      }
      void launchRun(chain[chain.length - 1], focus);
    },
    [runs.configs, launchRun, selectRun, showToast],
  );

  // Read by the agent-request listeners, which are set up once.
  const runConfigRef = useRef(runConfig);
  runConfigRef.current = runConfig;
  const runConfigsRef = useRef(runs.configs);
  runConfigsRef.current = runs.configs;
  const runSpecRef = useRef(runSpec);
  runSpecRef.current = runSpec;

  /** Stop every running instance of configuration `id`. */
  const stopRun = useCallback((id: string) => {
    for (const s of sessionsRef.current) {
      if (s.run?.configId === id && s.exitCode === undefined && s.ptyId) void ptyKill(s.ptyId);
    }
  }, []);

  /** A run tab's Rerun: the configuration as it is now, in the same tab. */
  const rerun = useCallback(
    (key: number) => {
      const s = sessionsRef.current.find((o) => o.key === key);
      const c = runs.configs.find((o) => o.id === s?.run?.configId);
      if (!s?.run) return;
      settleRun(key, null);
      const run = c ? { configId: c.id, name: c.name, spec: runSpec(c) } : s.run;
      setSessions((prev) =>
        prev.map((o) =>
          o.key === key
            ? { ...o, run, generation: o.generation + 1, exitCode: undefined, attention: undefined }
            : o,
        ),
      );
    },
    [runs.configs, runSpec, settleRun],
  );

  const restartSession = useCallback(
    (key: number) =>
      sessionsRef.current.find((o) => o.key === key)?.run ? rerun(key) : restart(key),
    [rerun, restart],
  );

  // The project may have grown a pom.xml or a script since it was opened.
  const { redetect } = runs;
  useEffect(() => {
    if (editingRuns) redetect();
  }, [editingRuns, redetect]);

  const saveRuns = useCallback(
    async (next: RunConfig[]) => {
      await runs.save(next);
      setEditingRuns(false);
    },
    [runs],
  );

  // ----------------------------------------------------------- attention ---

  // Read by the status listener, which is set up once rather than on every
  // session change.
  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;
  const activeRef = useRef(active);
  activeRef.current = active;
  const fileShownRef = useRef(fileShown);
  fileShownRef.current = fileShown;
  const sessionLabelRef = useRef(sessionLabel);
  sessionLabelRef.current = sessionLabel;

  /**
   * Session `key` finished, or is blocked on the user. Marked on its tab unless
   * the user is looking right at it, and announced from outside the window if
   * the settings ask for that.
   */
  const raise = useCallback(
    (key: number, kind: Attention, detail?: string | null) => {
      const s = sessionsRef.current.find((o) => o.key === key);
      if (!s) return;
      if (
        activeRef.current &&
        fileShownRef.current === null &&
        activeKeyRef.current === key &&
        document.hasFocus()
      ) {
        return;
      }
      setSessions((prev) => prev.map((o) => (o.key === key ? { ...o, attention: kind } : o)));
      const prefs = settings().notifications;
      if (!(kind === "done" ? prefs.onDone : prefs.onWaiting)) return;
      void notify(
        `${basename(root)} · ${sessionLabelRef.current(s)}`,
        kind === "done" ? "Finished." : `Needs your input${detail ? `: ${detail}` : "."}`,
      ).catch(() => {});
    },
    [root],
  );

  // What Claude Code reports about itself, through `status.rs`. Back at the
  // prompt after working is "done"; blocked on a permission is "waiting".
  useEffect(() => {
    const unlisten = onPtyStatus((ev) => {
      const s = sessionsRef.current.find((o) => o.ptyId === ev.id);
      if (!s) return;
      const was = s.status;
      setSessions((prev) =>
        prev.map((o) =>
          o.key === s.key
            ? // Working again means the user answered: nothing is owed any more.
              { ...o, status: ev.status, attention: ev.status === "busy" ? undefined : o.attention }
            : o,
        ),
      );
      if (ev.status === "waiting") raise(s.key, "waiting", ev.waitingFor);
      else if (ev.status === "idle" && was !== undefined && was !== "idle") raise(s.key, "done");
    });
    return () => void unlisten.then((u) => u());
  }, [raise]);

  /** A terminal bell, from an agent with no status to report. */
  const onBell = useCallback(
    (key: number) => {
      const s = sessionsRef.current.find((o) => o.key === key);
      if (s && s.agentId !== "claude") raise(key, "done");
    },
    [raise],
  );

  // Looking at a session settles what it was owed: on switching to it, and on
  // coming back to the window.
  useEffect(() => {
    const settle = () => {
      if (!activeRef.current || fileShownRef.current !== null || !document.hasFocus()) return;
      const key = activeKeyRef.current;
      setSessions((prev) =>
        prev.some((o) => o.key === key && o.attention)
          ? prev.map((o) => (o.key === key ? { ...o, attention: undefined } : o))
          : prev,
      );
    };
    settle();
    window.addEventListener("focus", settle);
    return () => window.removeEventListener("focus", settle);
  }, [active, activeKey, fileShown]);

  // ----------------------------------------------------- agent requests ---

  /** Questions from this project's agents, oldest first; each session shows its first. */
  const [prompts, setPrompts] = useState<McpPrompt[]>([]);
  const promptsRef = useRef(prompts);
  promptsRef.current = prompts;

  // `open_file` / `show_diff`: the same paths a click takes, so the display
  // settings apply. Never switches project tabs: the agent does not get to
  // pull the user away from what they are looking at.
  useEffect(() => {
    const unlisten = onOpenRequest((r) => {
      if (!sessionsRef.current.some((s) => s.ptyId === r.id)) return;
      if (r.as === "changes" || r.path === null) {
        setRailTab("git");
        return;
      }
      openPathRef.current(r.path, r.as, r.line ?? undefined);
    });
    return () => void unlisten.then((u) => u());
  }, []);

  useEffect(() => {
    const unPrompt = onPrompt((p) => {
      const s = sessionsRef.current.find((o) => o.ptyId === p.id);
      if (!s) return;
      if (p.kind === "run") {
        const ask = p;
        // What the backend read from run.json may already be gone from here.
        const c = runConfigsRef.current.find((o) => o.id === ask.configId);
        if (!c) {
          void mcpAnswer(ask.requestId, {
            decision: "error",
            comment: `"${ask.name}" is no longer a run configuration in this project.`,
          }).catch(() => {});
          return;
        }
        // Shown as it will run, so the user approves the command, not a name.
        p = { ...ask, command: runSpecRef.current(c).script };
      }
      setPrompts((prev) => [...prev, p]);
      raise(s.key, "waiting", promptDetail(p));
    });
    const unCancel = onPromptCancel((requestId) =>
      setPrompts((prev) => prev.filter((p) => p.requestId !== requestId)),
    );
    return () => {
      void unPrompt.then((u) => u());
      void unCancel.then((u) => u());
    };
  }, [raise]);

  const answerPrompt = useCallback(
    (requestId: string, answer: PromptAnswer) => {
      const p = promptsRef.current.find((o) => o.requestId === requestId);
      if (p?.kind === "run" && "decision" in answer && answer.decision === "run") {
        const chain = launchChain(runConfigsRef.current, p.configId);
        if (!chain || chain.length === 0) {
          answer = {
            decision: "error",
            comment: `"${p.name}" could not start: its before-launch steps run in a circle.`,
          };
        } else {
          void runConfigRef.current(p.configId, false);
        }
      }
      setPrompts((prev) => prev.filter((o) => o.requestId !== requestId));
      // Gone already if the call was withdrawn in the meantime; nothing to do.
      void mcpAnswer(requestId, answer).catch(() => {});
      setAgentFocus((t) => t + 1);
    },
    [],
  );

  /** The agent session last on screen: where a run's output is sent. */
  const lastAgentKey = useRef<number | null>(null);
  useEffect(() => {
    const s = sessions.find((o) => o.key === activeKey);
    if (s && !s.run) lastAgentKey.current = s.key;
  }, [sessions, activeKey]);

  /**
   * Type run `key`'s last lines into an agent, without sending, and show that
   * agent: the one last on screen if it still runs, else any that does.
   */
  const sendRunToAgent = useCallback(
    async (key: number) => {
      const all = sessionsRef.current;
      const s = all.find((o) => o.key === key);
      if (!s?.run || !s.ptyId) return;
      const live = (o: Session) => !o.run && o.ptyId && o.exitCode === undefined;
      const target =
        all.find((o) => o.key === lastAgentKey.current && live(o)) ?? all.find(live);
      if (!target?.ptyId) {
        showToast("No agent is running to send the output to.", "error");
        return;
      }
      try {
        const out = await runOutput(s.ptyId, SEND_LINES);
        const how =
          s.exitCode === undefined
            ? "is running"
            : s.exitCode === null
              ? "was stopped"
              : `exited with code ${s.exitCode}`;
        const body = out.trim() === "" ? "It printed nothing." : `Its last lines:\n\n\`\`\`\n${out}\n\`\`\``;
        await ptyPaste(target.ptyId, `The run "${s.run.name}" ${how}. ${body}\n`);
        setActiveKey(target.key);
        setAgentFocus((t) => t + 1);
      } catch (e) {
        showToast(`Could not send the output: ${String(e)}`, "error");
      }
    },
    [showToast],
  );

  const attentionCount = sessions.filter((s) => s.attention).length;
  useEffect(() => {
    onAttention(root, attentionCount);
    return () => onAttention(root, 0);
  }, [root, attentionCount, onAttention]);

  // ----------------------------------------------------------------- git ---

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
        setTreeChanges(null);
        setRefreshToken((t) => t + 1);
        // The log window, if open on this project, re-reads too.
        void emit(GIT_CHANGED, { root } satisfies GitChanged);
      }
    },
    [root, showToast],
  );

  const stageFile = useCallback(
    (f: FileStatus) => void runGit("stage", () => gitStage(root, pathsOf(f))),
    [root, runGit],
  );
  const unstageFile = useCallback(
    (f: FileStatus) => void runGit("stage", () => gitUnstage(root, pathsOf(f))),
    [root, runGit],
  );
  const stageAll = useCallback(
    () => void runGit("stage", () => gitStageAll(root)),
    [root, runGit],
  );
  const unstageAll = useCallback(
    () => void runGit("stage", () => gitUnstageAll(root)),
    [root, runGit],
  );
  const commit = useCallback(() => {
    const message = commitMessage;
    void runGit("commit", async () => {
      await gitCommit(root, message);
      // Only on success: a failed hook must not eat the message.
      setCommitMessage("");
    });
  }, [root, runGit, commitMessage]);
  const pull = useCallback(
    (rebase: boolean) =>
      void runGit("pull", async () => {
        await gitPull(root, rebase);
        showToast(rebase ? "Pulled and rebased." : "Pulled.");
      }),
    [root, runGit, showToast],
  );
  /** The push dialog's answer: what it showed is what goes. */
  const push = useCallback(
    (opts: { force: boolean; tags: boolean }) => {
      setPushing(false);
      void runGit("push", async () => {
        await gitPush(root, opts);
        showToast(opts.force ? "Force-pushed." : "Pushed.");
      });
    },
    [root, runGit, showToast],
  );
  const openPush = useCallback(() => setPushing(true), []);

  /**
   * IntelliJ's Rollback: confirm what goes back to HEAD, and whether files
   * HEAD never had are deleted or merely unstaged.
   */
  const rollback = useCallback(
    async (files: FileStatus[]) => {
      if (files.length === 0) return;
      const rel = (p: string) => (p.startsWith(root) ? p.slice(root.length + 1) : p);
      const added = files.some((f) => f.status === "added");
      const r = await ask({
        title: "Rollback Changes",
        body: (
          <>
            {files.length === 1 ? (
              <>
                Revert <code>{rel(files[0].path)}</code> to its last committed state?
              </>
            ) : (
              <>Revert {files.length} files to their last committed state?</>
            )}
            {files.length > 1 && (
              <ul className="modal-files">
                {files.slice(0, 12).map((f) => (
                  <li key={f.path}>{rel(f.path)}</li>
                ))}
                {files.length > 12 && <li>…and {files.length - 12} more</li>}
              </ul>
            )}
          </>
        ),
        checks: added
          ? [{ id: "delete", label: "Delete local copies of added files", initial: false }]
          : [],
        confirm: "Rollback",
        danger: true,
      });
      if (!r) return;
      const paths = files.flatMap(pathsOf);
      void runGit("rollback", async () => {
        await gitRollback(root, paths, !!r.checks.delete);
        showToast(files.length === 1 ? "Rolled back." : `Rolled back ${files.length} files.`);
      });
    },
    [root, ask, runGit, showToast],
  );

  const continueOperation = useCallback(
    () => void runGit("operation", () => gitOperationContinue(root)),
    [root, runGit],
  );
  const abortOperation = useCallback(
    () =>
      void runGit("operation", async () => {
        await gitOperationAbort(root);
        showToast("Aborted.");
      }),
    [root, runGit, showToast],
  );

  /** A new branch from `from` (HEAD when null), switched to unless unticked. */
  const newBranch = useCallback(
    async (from: string | null) => {
      const r = await ask({
        title: "Create New Branch",
        body: from ? (
          <>
            From <code>{from}</code>
          </>
        ) : undefined,
        input: { label: "New branch name", placeholder: "feature/…" },
        checks: [{ id: "checkout", label: "Checkout branch", initial: true }],
        confirm: "Create",
        validate: refNameError,
      });
      if (!r) return;
      void runGit("branch", async () => {
        await gitBranchCreate(root, r.text, from, r.checks.checkout);
        showToast(r.checks.checkout ? `Switched to new branch ${r.text}.` : `Created ${r.text}.`);
      });
    },
    [root, ask, runGit, showToast],
  );

  const newTag = useCallback(async () => {
    const head = (await gitLog(root, 0, 1, { branch: "HEAD" }).catch(() => []))[0];
    if (!head) {
      showToast("There is no commit to tag yet.", "error");
      return;
    }
    const r = await ask({
      title: "Create New Tag",
      body: (
        <>
          On <code>{head.shortId}</code> {head.subject}
        </>
      ),
      input: { label: "Tag name", placeholder: "v1.0.0" },
      message: { label: "Message (makes an annotated tag)", placeholder: "Optional" },
      confirm: "Create Tag",
      validate: refNameError,
    });
    if (!r) return;
    void runGit("tag", async () => {
      await gitTagCreate(root, r.text, head.id, r.message || null);
      showToast(`Tagged ${head.shortId} as ${r.text}.`);
    });
  }, [root, ask, runGit, showToast]);

  const checkout = useCallback(
    (b: BranchInfo) =>
      void runGit("checkout", async () => {
        await gitCheckout(root, b);
        // A remote branch lands as the local one tracking it.
        const local = b.remote ? b.name.slice(b.name.indexOf("/") + 1) : b.name;
        showToast(`Switched to ${local}.`);
      }),
    [root, runGit, showToast],
  );
  const fetchRemotes = useCallback(() => runGit("fetch", () => gitFetch(root)), [root, runGit]);

  /** Everything the branch popup's submenu can do. */
  const branchAction = useCallback(
    async (action: BranchAction, b: BranchInfo) => {
      const current = repo?.branch ?? "HEAD";
      switch (action) {
        case "checkout":
          return checkout(b);
        case "newFrom":
          return newBranch(b.name);
        case "compare":
          // IntelliJ's "Compare with Current", as the log of what that
          // branch has and the current one does not.
          void openLogWindow({ root, branch: `${current}..${b.name}` });
          return;
        case "showLog":
          void openLogWindow({ root, branch: b.name });
          return;
        case "merge":
          return void runGit("merge", async () => {
            const out = await gitMerge(root, b.name);
            showToast(/up to date/i.test(out) ? "Already up to date." : `Merged ${b.name} into ${current}.`);
          });
        case "rebase":
          return void runGit("rebase", async () => {
            await gitRebase(root, b.name);
            showToast(`Rebased ${current} onto ${b.name}.`);
          });
        case "pull":
          // Only offered for the current branch, which is what pull updates.
          return pull(false);
        case "push":
          return openPush();
        case "rename": {
          const r = await ask({
            title: `Rename Branch ${b.name}`,
            input: { label: "New name", initial: b.name },
            confirm: "Rename",
            validate: (t) => (t === b.name ? "That is its name already." : refNameError(t)),
          });
          if (!r) return;
          return void runGit("branch", async () => {
            await gitBranchRename(root, b.name, r.text);
            showToast(`Renamed ${b.name} to ${r.text}.`);
          });
        }
        case "delete": {
          const r = await ask({
            title: b.remote ? "Delete Remote Branch" : "Delete Branch",
            body: b.remote ? (
              <>
                Delete <code>{b.name}</code> on the remote? Everyone loses it.
              </>
            ) : (
              <>
                Delete <code>{b.name}</code>?
              </>
            ),
            checks: b.remote
              ? []
              : [{ id: "force", label: "Delete even if not fully merged", initial: false }],
            confirm: "Delete",
            danger: true,
          });
          if (!r) return;
          return void runGit("branch", async () => {
            await gitBranchDelete(root, b, !!r.checks.force);
            showToast(`Deleted ${b.name}.`);
          });
        }
      }
    },
    [root, repo?.branch, checkout, newBranch, runGit, showToast, pull, openPush, ask],
  );

  // ----------------------------------------------------------- commands ---

  // Git needs a repo to act on; outside one a silent no-op would read as broken.
  const gitReady = () => {
    if (repo && !repo.isRepo) {
      showToast("This project is not a git repository.", "error");
      return false;
    }
    return true;
  };
  // This project's share of the app's shortcuts. App runs them while this tab
  // is the active one and nothing modal is up; the chords themselves live in
  // the registry, which is also what stops TerminalPane forwarding them.
  const commands: Handlers = {
    "prompt.templates": () => {
      // Nothing to type into, and a chooser that quietly did nothing would be
      // worse than saying so.
      if (!current || current.exitCode !== undefined) {
        showToast("No agent is running to send a prompt to.", "error");
        return;
      }
      void openTemplatesWindow(
        contextFrom(root, viewedFile, repo?.branch ?? null),
      ).catch(() => showToast("Could not open prompt templates.", "error"));
    },
    "focus.files": () => {
      // Same batch as the token, so the tree is visible by the time its
      // focus effect runs.
      setRailTab("files");
      setFilesFocus((t) => t + 1);
    },
    "focus.git": () => {
      setRailTab("git");
      setGitFocus((t) => t + 1);
    },
    "focus.agent": () => setAgentFocus((t) => t + 1),
    "file.new": () => void newFile(),
    "find.files": () => setFinding("files"),
    "find.content": () => setFinding("content"),
    // The chord opens the panel too, so it never lands on a hidden tab.
    "focus.agentInfo": () => patchLayout({ insightOpen: true, insightTab: "info" }),
    "focus.agentTasks": () => patchLayout({ insightOpen: true, insightTab: "tasks" }),
    "focus.agentSubagents": () =>
      patchLayout({ insightOpen: true, insightTab: "subagents" }),
    "session.new": newSession,
    "session.close": () => {
      if (fileShown !== null) closeFileTab(fileShown);
      else if (activeKey !== null) void closeSession(activeKey);
    },
    "session.next": () => cycleSession(1),
    "session.prev": () => cycleSession(-1),
    "session.goto1": () => gotoSession(1),
    "session.goto2": () => gotoSession(2),
    "session.goto3": () => gotoSession(3),
    "session.goto4": () => gotoSession(4),
    "session.goto5": () => gotoSession(5),
    "session.goto6": () => gotoSession(6),
    "session.goto7": () => gotoSession(7),
    "session.goto8": () => gotoSession(8),
    "session.goto9": () => gotoSession(9),
    "account.next": () => {
      // The backend would happily swap the Claude login underneath opencode;
      // it just would not mean anything.
      if (currentAgent?.id !== "claude") {
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
      if (gitReady()) openPush();
    },
    "git.rollback": () => {
      if (!gitReady()) return;
      setRailTab("git");
      setListRequest({ kind: "rollback", token: Date.now() });
    },
    "git.showDiff": () => {
      if (!gitReady()) return;
      setListRequest({ kind: "diff", token: Date.now() });
    },
    "git.log": () => {
      if (!gitReady()) return;
      void openLogWindow({ root }).catch(() => showToast("Could not open the git log.", "error"));
    },
    "git.annotate": () => {
      if (!gitReady()) return;
      if (!viewedFile) {
        showToast("Open a file to annotate it.", "error");
        return;
      }
      setAnnotateRequest((t) => t + 1);
    },
    "git.branches": () => {
      if (gitReady()) setBranchesRequest((t) => t + 1);
    },
    "git.newBranch": () => {
      if (gitReady()) void newBranch(null);
    },
    "git.newTag": () => {
      if (gitReady()) void newTag();
    },
    "git.fetch": () => {
      if (!gitReady()) return;
      void runGit("fetch", async () => {
        await gitFetch(root);
        showToast("Fetched.");
      });
    },
    "run.run": () => {
      if (runSelected) void runConfig(runSelected.id);
      else setEditingRuns(true);
    },
    "run.stop": () => {
      if (runSelected) stopRun(runSelected.id);
    },
    "run.choose": () => {
      if (runs.configs.length > 0) setRunMenuRequest((t) => t + 1);
      else setEditingRuns(true);
    },
    "run.edit": () => setEditingRuns(true),
  };

  /**
   * Type a finished prompt into the session on screen.
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

  // Handlers close over this render's state, so they are republished every
  // render; App reads them through a ref, the way the menu always has.
  useEffect(() => register(root, { handlers: commands, insertPrompt }));
  useEffect(() => () => register(root, null), [root, register]);

  // ----------------------------------------------------------------- files ---

  const toggleDir = useCallback(
    (path: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        next.has(path) ? next.delete(path) : next.add(path);
        saveProjectState(root, { expandedDirs: [...next] });
        return next;
      });
    },
    [root],
  );

  /**
   * Open `path` as the file (from the tree) or as its diff (from the git
   * list). Each goes to the side window when its setting says so, and only
   * there -- the pane is left as it was.
   */
  const openPath = useCallback(
    (path: string, as: ViewerMode, line?: number) => {
      if (as === "file" && path.startsWith(`${root}/`)) {
        const rel = path.slice(root.length + 1);
        setRecentFiles((prev) => [rel, ...prev.filter((p) => p !== rel)].slice(0, RECENT_FILES));
      }
      const { diffDisplay, fileDisplay } = settings().layout;
      const display = as === "diff" ? diffDisplay : fileDisplay;
      if (display === "window") {
        void openViewerWindow(root, path, as, line);
        setDiffFile(path);
        return;
      }
      setDiffFile(null);
      if (display === "tab") {
        setFileTabs((prev) => (prev.includes(path) ? prev : [...prev, path]));
        setFileShown(path);
        setTabLine(line === undefined ? null : { line, token: Date.now() });
        saveProjectState(root, { openFile: path });
        return;
      }
      setOpenFile(path);
      setOpenedAs(as);
      // A fresh token even for the same line: the user may have scrolled away.
      setOpenLine(line === undefined ? null : { line, token: Date.now() });
      saveProjectState(root, { openFile: path });
    },
    [root],
  );
  const openPathRef = useRef(openPath);
  openPathRef.current = openPath;
  const openFromTree = useCallback((path: string) => openPath(path, "file"), [openPath]);
  const openFromGit = useCallback((path: string) => openPath(path, "diff"), [openPath]);
  const openFromTerminal = useCallback(
    (path: string, line?: number) => openPath(path, "file", line),
    [openPath],
  );

  /**
   * ⌘D / ⌘⌥Z with the changes list not focused: the open file, as IntelliJ's
   * editor does. Rollback with no changed file open offers everything.
   */
  const listRequestUnhandled = useCallback(
    (kind: ListRequest["kind"]) => {
      const files = repo?.files ?? [];
      const file = files.find((f) => f.path === (diffFile ?? viewedFile));
      if (kind === "diff") {
        if (file) openPath(file.path, "diff");
        else showToast("No changed file selected to diff.", "error");
      } else if (file) void rollback([file]);
      else if (files.length > 0) void rollback(files);
      else showToast("No changes to roll back.");
    },
    [repo, diffFile, viewedFile, openPath, showToast, rollback],
  );

  /**
   * Create a file and open it ready to type into -- it is the user's, so it is
   * unlocked from the start. The dialog starts in the folder of the file being
   * looked at, the way IntelliJ's New File starts from the selection.
   */
  const newFile = useCallback(async () => {
    const near = diffFile ?? viewedFile;
    const dir = near?.startsWith(root + "/")
      ? near.slice(root.length + 1, near.lastIndexOf("/") + 1)
      : "";
    const r = await ask({
      title: "New File",
      body: (
        <>
          In <code>{root.split("/").pop()}</code>. Folders that do not exist yet are created.
        </>
      ),
      input: { label: "Path, relative to the project", initial: dir, placeholder: ".env" },
      confirm: "Create",
      validate: newFileError,
    });
    if (!r) return;
    let file: string;
    try {
      file = await createFile(root, r.text);
    } catch (e) {
      showToast(String(e).replace(/^Error:\s*/, ""), "error");
      return;
    }
    setWritable(root, file, true);
    // Unfold the tree down to it, so it is visible where it landed.
    setExpanded((prev) => {
      const next = new Set(prev);
      for (let at = file.lastIndexOf("/"); at > root.length; at = file.lastIndexOf("/", at - 1)) {
        next.add(file.slice(0, at));
      }
      saveProjectState(root, { expandedDirs: [...next] });
      return next;
    });
    setTreeChanges(null);
    setRefreshToken((t) => t + 1);
    openPath(file, "file");
  }, [root, diffFile, viewedFile, ask, showToast, openPath]);

  const closeFile = useCallback(() => {
    setOpenFile(null);
    saveProjectState(root, { openFile: null });
  }, [root]);

  /** Close a file tab; if it was on screen, its neighbour takes its place. */
  const closeFileTab = useCallback(
    (path: string) => {
      const at = fileTabs.indexOf(path);
      const rest = fileTabs.filter((p) => p !== path);
      setFileTabs(rest);
      if (fileShown !== path) return;
      const next = rest[Math.min(at, rest.length - 1)] ?? null;
      setTabLine(null);
      setFileShown(next);
      saveProjectState(root, { openFile: next });
    },
    [fileTabs, fileShown, root],
  );

  const showFileTab = useCallback(
    (path: string) => {
      setTabLine(null);
      setFileShown(path);
      saveProjectState(root, { openFile: path });
    },
    [root],
  );

  const commitSplit = useCallback((f: number) => {
    splitFraction.current = f;
    patchLayout({ splitFraction: f });
  }, []);

  const toggleInsight = useCallback(
    () => patchLayout({ insightOpen: !settings().layout.insightOpen }),
    [],
  );

  // -------------------------------------------------------------- render ---

  const changedPaths = useMemo(() => (repo?.files ?? []).map((f) => f.path), [repo]);

  const tabs: SessionTab[] = sessions.map((s) => ({
    key: s.key,
    label: sessionLabel(s),
    exited: s.exitCode !== undefined,
    busy: s.status === "busy",
    attention: s.attention ?? null,
  }));

  // Two tabs on the same name say which folder each is from.
  const fileTabItems: FileTab[] = fileTabs.map((path) => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const rel = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
    const twin = fileTabs.some((o) => o !== path && o.endsWith(`/${name}`));
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    return { path, label: twin && dir ? `${name} — ${dir}` : name, title: rel };
  });

  // One stable slot for the whole terminal area: SplitPane must never see its
  // `top` change shape, and every session pane is keyed inside the stack, so
  // opening, closing or switching sessions never remounts another one.
  const terminal = (
    <div className="terminal-slot">
      {(sessions.length > 0 || fileTabs.length > 0) && (
        <SessionTabs
          tabs={tabs}
          activeKey={activeKey}
          files={fileTabItems}
          activeFile={fileShown}
          onSelectFile={showFileTab}
          onCloseFile={closeFileTab}
          choices={choices}
          newRequest={newRequest}
          onSelect={setActiveKey}
          onClose={(key) => void closeSession(key)}
          onNew={startSession}
          onNewWorktree={worktreeAgent ? () => void newWorktreeSession() : undefined}
        />
      )}
      <div className="session-stack">
        {sessions.map((s) => (
          <SessionPane
            key={s.key}
            session={s}
            agent={agentById(s.agentId)}
            label={sessionLabel(s)}
            cwd={root}
            shown={fileShown === null && s.key === activeKey}
            visible={active && fileShown === null && s.key === activeKey}
            focusToken={agentFocus}
            onExit={setExit}
            onRestart={restartSession}
            onOpenPath={openFromTerminal}
            onSpawned={setPtyId}
            onBell={onBell}
            prompt={prompts.find((p) => p.id === s.ptyId) ?? null}
            changed={changedPaths}
            refreshToken={refreshToken}
            onAnswer={answerPrompt}
            onSendToAgent={sendRunToAgent}
          />
        ))}
        {sessions.length === 0 && fileShown === null && (
          <EmptyTerminal agents={agents} seeded={seeded.current} onStart={startSession} />
        )}
        {fileShown !== null && (
          <div className="session-pane file-pane">
            <BottomPane
              root={root}
              path={fileShown}
              status={statuses.get(fileShown) ?? null}
              refreshToken={refreshToken}
              diffInWindow={diffInWindow}
              openedAs="file"
              target={tabLine}
              annotateRequest={annotateRequest}
              isRepo={!!repo?.isRepo}
              onClose={() => closeFileTab(fileShown)}
            />
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="project-view" hidden={!active}>
      <header className="topbar">
        {/* The project is what this tab is, so it leads where the app's own
            name used to sit. The branch rides along: both answer "where am I
            working?", and splitting them across the bar made you look in two
            places for one fact. */}
        <div className="topbar-project">
          <button
            className="cwd"
            onClick={onPickProject}
            title={chordHint(`${root} — click to open another project`, "project.open")}
          >
            {worktree ? worktreeLabel(worktree) : root.split("/").filter(Boolean).pop() || root}
          </button>
          {repo?.isRepo && repo.branch && (
            <BranchPicker
              root={root}
              branch={repo.branch}
              busy={gitBusy !== null}
              ahead={repo.ahead}
              behind={repo.behind}
              openRequest={branchesRequest}
              onCheckout={checkout}
              onFetch={fetchRemotes}
              onNewBranch={() => void newBranch(null)}
              onAction={(a, b) => void branchAction(a, b)}
            />
          )}
        </div>
        <div className="topbar-right">
          <RunPicker
            configs={runs.configs}
            selected={runSelected}
            running={runningOf(runSelected?.id).length}
            openRequest={runMenuRequest}
            onSelect={selectRun}
            onRun={() => runSelected && void runConfig(runSelected.id)}
            onStop={() => runSelected && stopRun(runSelected.id)}
            onEdit={() => setEditingRuns(true)}
          />
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
            onClick={onOpenSettings}
            title={chordHint("Settings", "app.settings")}
            aria-label="Settings"
          >
            ⚙
          </button>
        </div>
      </header>

      <div className="body">
        <aside className="rail" style={{ width: railWidth }}>
          <nav className="rail-tabs" role="tablist" aria-orientation="vertical">
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
            <button
              className="rail-tab rail-action"
              aria-label="New file"
              title={chordHint("New file", "file.new")}
              onClick={() => void newFile()}
            >
              <NewFileIcon />
            </button>
          </nav>
          {/* Both stay mounted and the other is hidden: remounting the tree
              would reload it and lose its scroll, and remounting the changes
              would drop the commit box's caret and undo. */}
          <div className="rail-panel">
            <div hidden={railTab !== "files"}>
              <FileTree
                root={root}
                selected={diffFile ?? viewedFile}
                onSelect={openFromTree}
                refreshToken={refreshToken}
                changed={treeChanges}
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
                root={root}
                // null = status not back yet, or it failed. Assume a repo so
                // the transient body reads "No changes" rather than accusing
                // a real repo of not being one.
                isRepo={repo === null || repo.isRepo}
                upstream={repo?.upstream ?? null}
                ahead={repo?.ahead ?? 0}
                behind={repo?.behind ?? 0}
                selected={diffFile ?? viewedFile}
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
                onPush={openPush}
                onRollback={(files) => void rollback(files)}
                onHistory={(path) => void openLogWindow({ root, path })}
                operation={repo?.operation ?? null}
                onContinue={continueOperation}
                onAbort={abortOperation}
                request={listRequest}
                onRequestUnhandled={listRequestUnhandled}
              />
            </div>
          </div>
        </aside>

        <div
          className="rail-resizer"
          role="separator"
          aria-orientation="vertical"
          data-dragging={resizing === "rail"}
          onPointerDown={(e) => {
            e.preventDefault();
            onResizeStart("rail");
          }}
        />

        <main className="main">
          {/* Always a SplitPane, even with no file open -- see the note in
              SplitPane: moving `terminal` in the tree would remount it and
              kill the agents' PTYs. The editor simply claims no space until
              asked. */}
          <SplitPane
            initial={splitFraction.current}
            onCommit={commitSplit}
            top={terminal}
            bottom={
              openFile ? (
                <BottomPane
                  root={root}
                  path={openFile}
                  status={statuses.get(openFile) ?? null}
                  refreshToken={refreshToken}
                  diffInWindow={diffInWindow}
                  openedAs={openedAs}
                  target={openLine}
                  annotateRequest={annotateRequest}
                  isRepo={!!repo?.isRepo}
                  onClose={closeFile}
                />
              ) : null
            }
          />
        </main>

        {/* A sibling of <main>, never a wrapper around it: anything that
            remounts the subtree holding TerminalPane kills the agents' PTYs.
            Swapping the panel for the stub keeps <main> in place, so the
            terminals survive a collapse. */}
        {!insightOpen && (
          <button
            className="insight-stub"
            onClick={toggleInsight}
            title="Show agent panel"
            aria-label="Show agent panel"
          >
            ◫
          </button>
        )}

        {insightOpen && (
          <>
            <div
              className="insight-resizer"
              role="separator"
              aria-orientation="vertical"
              data-dragging={resizing === "insight"}
              onPointerDown={(e) => {
                e.preventDefault();
                onResizeStart("insight");
              }}
            />
            <aside className="insight" style={{ width: insightWidth }}>
              <InsightPanel
                agent={panelAgent}
                workspace={root}
                // Not the workspace watcher's token: it fires on every file
                // the agent touches, and each refresh re-reads every
                // transcript and the account config. `agents://changed`
                // already covers the transcripts and the session registry.
                refreshToken={agentsToken}
                onAccountChanged={() => setAgentsToken((t) => t + 1)}
                onResume={(s) => void resumeSession(s)}
                onClose={toggleInsight}
              />
            </aside>
          </>
        )}
      </div>

      {finding && (
        <FindPopup
          root={root}
          mode={finding}
          onMode={setFinding}
          onOpen={(rel, line) => {
            setFinding(null);
            openPath(`${root}/${rel}`, "file", line);
          }}
          onClose={() => setFinding(null)}
          recent={recentFiles}
        />
      )}
      {editingRuns && (
        <RunConfigDialog
          root={root}
          configs={runs.configs}
          initialId={runSelected?.id ?? null}
          detected={runs.detected}
          context={runs.context}
          fileError={runs.error}
          onSave={saveRuns}
          onCancel={() => setEditingRuns(false)}
          onOpenFile={() => {
            setEditingRuns(false);
            openPath(`${root}/${RUN_FILE}`, "file");
          }}
        />
      )}
      {pushing && <PushDialog root={root} onPush={push} onCancel={() => setPushing(false)} />}
      {dialogs}
    </div>
  );
}

interface SessionPaneProps {
  session: Session;
  agent: AgentInfo | null;
  label: string;
  cwd: string;
  /** Its session tab is the selected one in this project. */
  shown: boolean;
  /** Shown, and its project tab is the window's active one. */
  visible: boolean;
  focusToken: number;
  onExit(key: number, code: number | null): void;
  onRestart(key: number): void;
  onOpenPath(path: string, line?: number): void;
  onSpawned(key: number, ptyId: string): void;
  onBell(key: number): void;
  /** The question its agent is waiting on, if any. */
  prompt: McpPrompt | null;
  changed: string[];
  refreshToken: number;
  onAnswer(requestId: string, answer: PromptAnswer): void;
  /** A run tab's "Send to agent": its last lines, typed into an agent. */
  onSendToAgent(key: number): void;
}

/**
 * One session's terminal and its exit overlay. Its own component so the exit
 * callback TerminalPane gets is stable per session: it is a dependency of the
 * spawn effect, and a fresh one each render would restart the agent.
 */
function SessionPane({
  session,
  agent,
  label,
  cwd,
  shown,
  visible,
  focusToken,
  onExit,
  onRestart,
  onOpenPath,
  onSpawned,
  onBell,
  prompt,
  changed,
  refreshToken,
  onAnswer,
  onSendToAgent,
}: SessionPaneProps) {
  const { key } = session;
  const handleExit = useCallback((code: number | null) => onExit(key, code), [onExit, key]);
  const handleSpawned = useCallback((id: string) => onSpawned(key, id), [onSpawned, key]);
  const handleBell = useCallback(() => onBell(key), [onBell, key]);
  if (!agent && !session.run) return null;
  return (
    <div className="session-pane" hidden={!shown}>
      <TerminalPane
        command={agent?.command ?? null}
        cwd={cwd}
        resume={session.resumeId}
        run={session.run?.spec}
        generation={session.generation}
        focusToken={focusToken}
        visible={visible}
        onExit={handleExit}
        onOpenPath={onOpenPath}
        onSpawned={handleSpawned}
        onBell={handleBell}
      />
      {prompt && session.exitCode === undefined && (
        <AgentPrompt
          key={prompt.requestId}
          prompt={prompt}
          changed={changed}
          refreshToken={refreshToken}
          visible={visible}
          onAnswer={(answer) => onAnswer(prompt.requestId, answer)}
        />
      )}
      {session.exitCode !== undefined &&
        (session.run ? (
          // Under the output rather than over it: the last lines are usually
          // why it stopped.
          <div className="run-exit" data-ok={session.exitCode === 0}>
            <span>
              {session.exitCode === null
                ? "Process stopped"
                : `Process finished with exit code ${session.exitCode}`}
            </span>
            <span className="run-exit-actions">
              <button
                className="restart"
                onClick={() => onSendToAgent(key)}
                title="Type its last lines into the agent, without sending"
              >
                Send to Agent
              </button>
              <button className="restart" onClick={() => onRestart(key)}>
                Rerun
              </button>
            </span>
          </div>
        ) : (
          <div className="exit-overlay">
            <p>
              {label} exited
              {session.exitCode === null ? "" : ` (code ${session.exitCode})`}
            </p>
            <button className="restart" onClick={() => onRestart(key)}>
              Restart
            </button>
          </div>
        ))}
    </div>
  );
}

/** The terminal area with no session in it: still loading, nothing installed,
 *  or every session closed. */
function EmptyTerminal({
  agents,
  seeded,
  onStart,
}: {
  agents: AgentInfo[];
  seeded: boolean;
  onStart(agent: AgentInfo): void;
}) {
  if (agents.length === 0) return <div className="empty">Starting…</div>;
  const available = agents.filter((a) => a.available);
  // The registry is never empty, so a populated `agents` with nothing available
  // means every known agent failed its `--version` probe.
  if (available.length === 0) {
    return (
      <div className="empty">
        No coding agent found. Install Claude Code or opencode, then reopen Aditor.
      </div>
    );
  }
  if (!seeded) return <div className="empty">Starting…</div>;
  return (
    <div className="empty session-empty">
      <p>No agent session is open in this project.</p>
      <div className="session-empty-actions">
        {available.map((a) => (
          <button key={a.id} className="restart" onClick={() => onStart(a)}>
            Start {a.label}
          </button>
        ))}
        <button className="restart" onClick={() => onStart(SHELL_SESSION)}>
          Open Terminal
        </button>
      </div>
    </div>
  );
}
