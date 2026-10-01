import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ProjectPicker } from "./components/ProjectPicker";
import { ProjectTabs } from "./components/ProjectTabs";
import { ProjectView, type Dragging, type ViewApi } from "./components/ProjectView";
import { useDialogs } from "./components/Modal";
import { Toast, type ToastMessage } from "./components/Toast";
import { useShortcuts, type Handlers } from "./shortcuts/useShortcuts";
import { COMMANDS, type CommandId } from "./shortcuts/registry";
import { claimAppMenu, installAppMenu } from "./menu";
import { agentsAvailable, reapOrphansOnce, type AgentInfo } from "./pty/api";
import { closeWorkspace, dirsExist, openWorkspace } from "./fs/api";
import { patch, patchLayout, settings } from "./settings/store";
import {
  basename,
  growWindowToEditor,
  openProjectWindow,
  openSettingsWindow,
  TEMPLATES_INSERT,
} from "./window";
import { forgetProject, loadRecents, rememberProject, type RecentProject } from "./projects";

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

/** The first editor window: the one whose tabs are saved and restored. */
const IS_FIRST_WINDOW = getCurrentWindow().label === "main";

/** The project a New Window was opened on, from its URL. */
const URL_PROJECT = new URLSearchParams(location.search).get("project");

/** The commands App answers itself; every other one goes to the active tab. */
const SHELL_COMMANDS: readonly CommandId[] = [
  "project.open",
  "project.close",
  "project.next",
  "project.prev",
  "app.settings",
];

/**
 * An editor window: a strip of project tabs, one ProjectView per tab, and the
 * project chooser over them when it is asked for or there is nothing open.
 *
 * Every view stays mounted while its tab is open and is merely hidden when
 * another is active, because unmounting one kills its agents.
 */
export default function App() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [tabs, setTabs] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  /** Roots with an agent still running, for the tab dot and the close prompt. */
  const [running, setRunning] = useState<Set<string>>(new Set());
  /** Saved and URL tabs are reopened before the chooser is offered. */
  const [booted, setBooted] = useState(false);

  const [picking, setPicking] = useState(false);
  const [recents, setRecents] = useState<RecentProject[]>([]);
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [pickError, setPickError] = useState<string | null>(null);
  /** A folder waiting on "this window or a new one?". */
  const [pending, setPending] = useState<string | null>(null);

  const [insightWidth, setInsightWidth] = useState(() => settings().layout.insightWidth);
  const [railWidth, setRailWidth] = useState(() => settings().layout.railWidth);
  const [resizing, setResizing] = useState<Dragging>(null);

  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastSeq = useRef(0);
  const [dialogs, ask] = useDialogs();

  /**
   * Whether the window has the editor's size. The first window opens sized to
   * the chooser card and grows the first time a project opens; one opened
   * with New Window starts at the editor size.
   */
  const grown = useRef(!IS_FIRST_WINDOW);
  const showPicker = booted && (picking || tabs.length === 0);

  const views = useRef(new Map<string, ViewApi>());
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  const showToast = useCallback((text: string, tone: ToastMessage["tone"] = "info") => {
    setToast({ id: ++toastSeq.current, text, tone });
  }, []);
  const hideToast = useCallback(() => setToast(null), []);

  const register = useCallback((root: string, api: ViewApi | null) => {
    if (api) views.current.set(root, api);
    else views.current.delete(root);
  }, []);

  const onRunning = useCallback((root: string, on: boolean) => {
    setRunning((prev) => {
      if (prev.has(root) === on) return prev;
      const next = new Set(prev);
      if (on) next.add(root);
      else next.delete(root);
      return next;
    });
  }, []);

  useEffect(() => {
    void (async () => {
      // Reap this window's orphans from a previous page context before any
      // view spawns -- they wait for `agents` -- or reloads accumulate agent
      // processes. Once per page, never per project.
      await reapOrphansOnce();
      setAgents(await agentsAvailable());
    })();
  }, []);

  /** Grow out of the chooser card's size, once. */
  const ensureGrown = useCallback(async () => {
    if (grown.current) return;
    grown.current = true;
    // Awaited so the first agent spawns into its final geometry rather than
    // fitting itself twice. Sizing is a nicety; never block a project on it.
    await growWindowToEditor().catch(() => {});
  }, []);

  // Reopen what this window should start with: a New Window's project, or the
  // first window's saved tabs. A folder that has gone since is skipped.
  useEffect(() => {
    void (async () => {
      const wanted = URL_PROJECT ? [URL_PROJECT] : IS_FIRST_WINDOW ? settings().openTabs : [];
      const opened: string[] = [];
      for (const path of wanted) {
        try {
          const root = await openWorkspace(path);
          if (!opened.includes(root)) opened.push(root);
        } catch {
          /* moved or deleted; the chooser will show it as missing */
        }
      }
      if (opened.length > 0) {
        await ensureGrown();
        if (URL_PROJECT) setRecents(rememberProject(opened[0]));
        const saved = settings().activeTab;
        setTabs(opened);
        setActiveTab(saved && opened.includes(saved) ? saved : opened[0]);
      }
      setBooted(true);
    })();
  }, [ensureGrown]);

  // Only the first window's tabs are remembered: restoring every window would
  // mean remembering windows, which is more than "reopen my projects" needs.
  useEffect(() => {
    if (!booted || !IS_FIRST_WINDOW) return;
    patch({ openTabs: tabs, activeTab });
  }, [booted, tabs, activeTab]);

  // The window is named after the project on screen, for the Dock and ⌘`.
  useEffect(() => {
    void getCurrentWindow()
      .setTitle(activeTab ? `${basename(activeTab)} — Aditor` : "Aditor")
      .catch(() => {});
  }, [activeTab]);

  // Re-probe the recents every time the chooser opens: a folder can be moved
  // or deleted between sessions, or while a project is open.
  useEffect(() => {
    if (!showPicker) return;
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
  }, [showPicker]);

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
      else setInsightWidth(clamp(window.innerWidth - e.clientX, INSIGHT_MIN, INSIGHT_MAX));
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

  // ------------------------------------------------------------ projects ---

  /** Open `path` as a tab here, or switch to it if it already is one. */
  const openInTab = useCallback(
    async (path: string) => {
      let root: string;
      try {
        root = await openWorkspace(path);
      } catch (e) {
        setPickError(String(e));
        setMissing((prev) => new Set(prev).add(path));
        setPending(null);
        return;
      }
      await ensureGrown();
      setRecents(rememberProject(root));
      setMissing((prev) => {
        const next = new Set(prev);
        next.delete(path);
        next.delete(root);
        return next;
      });
      setPickError(null);
      setPending(null);
      setTabs((prev) => (prev.includes(root) ? prev : [...prev, root]));
      setActiveTab(root);
      setPicking(false);
    },
    [ensureGrown],
  );

  const openInWindow = useCallback(
    (path: string) => {
      setPending(null);
      setPicking(false);
      void openProjectWindow(path).catch(() => showToast("Could not open a new window.", "error"));
    },
    [showToast],
  );

  /**
   * Both a recent row and the folder dialog land here. With nothing open the
   * folder simply opens; otherwise the chooser asks where, unless it is a tab
   * here already.
   */
  const requestOpen = useCallback(
    (path: string) => {
      if (tabs.length === 0) return void openInTab(path);
      if (tabs.includes(path)) {
        setActiveTab(path);
        setPicking(false);
        return;
      }
      setPending(path);
    },
    [tabs, openInTab],
  );

  const browseForProject = useCallback(async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") requestOpen(picked);
  }, [requestOpen]);

  const forgetRecent = useCallback((path: string) => setRecents(forgetProject(path)), []);

  const closeTab = useCallback(
    async (root: string) => {
      if (running.has(root)) {
        const r = await ask({
          title: "Close Project",
          body: (
            <>
              Agents in <code>{basename(root)}</code> are still running. Closing the tab
              stops them.
            </>
          ),
          confirm: "Close",
          danger: true,
        });
        if (!r) return;
      }
      // The neighbour takes over, as closing a tab does anywhere else.
      const at = tabs.indexOf(root);
      const rest = tabs.filter((t) => t !== root);
      setTabs((prev) => prev.filter((t) => t !== root));
      setActiveTab((cur) => (cur === root ? (rest[Math.min(at, rest.length - 1)] ?? null) : cur));
      onRunning(root, false);
      void closeWorkspace(root).catch(() => {});
    },
    [running, tabs, ask, onRunning],
  );

  const cycleTab = useCallback(
    (step: number) => {
      if (tabs.length < 2 || !activeTab) return;
      const at = tabs.indexOf(activeTab);
      setActiveTab(tabs[(at + step + tabs.length) % tabs.length]);
    },
    [tabs, activeTab],
  );

  const openSettings = useCallback(() => {
    void openSettingsWindow().catch(() => showToast("Could not open Settings.", "error"));
  }, [showToast]);

  const openPicker = useCallback(() => {
    setPending(null);
    setPicking(true);
  }, []);

  // ------------------------------------------------------------ commands ---

  // The window's own commands, then everything else forwarded to the active
  // tab at the moment it fires -- views republish their handlers every render,
  // and App does not re-render with them. While the chooser is up the app
  // behind it is inert, so only reopening it means anything.
  const shell: Handlers = {
    "project.open": openPicker,
    "project.close": () => activeTab && void closeTab(activeTab),
    "project.next": () => cycleTab(1),
    "project.prev": () => cycleTab(-1),
    "app.settings": openSettings,
  };
  const commands: Handlers = showPicker ? { "project.open": openPicker } : { ...shell };
  if (!showPicker) {
    for (const { id } of COMMANDS) {
      if (SHELL_COMMANDS.includes(id)) continue;
      commands[id] = () => views.current.get(activeTabRef.current ?? "")?.handlers[id]?.();
    }
  }
  useShortcuts(commands);

  // The menu bar runs the very same handlers, so a command means one thing
  // whether it arrives by chord, by button or by menu. They are read through a
  // ref because they close over this render's state, and the native menu is
  // built once.
  const commandsRef = useRef(commands);
  useEffect(() => {
    commandsRef.current = commands;
  });
  useEffect(() => {
    void installAppMenu((id) => commandsRef.current[id]?.());
    // One menu bar for every window: whichever editor has focus owns it.
    const unlisten = getCurrentWindow().onFocusChanged(({ payload }) => {
      if (payload) claimAppMenu();
    });
    return () => void unlisten.then((u) => u());
  }, []);

  // The template picker lives in its own window, but the agents' PTYs live in
  // this one, so a chosen prompt comes back here to be typed into the session
  // on screen. Focus follows it, so the user lands in the terminal ready to add
  // to it.
  useEffect(() => {
    const unlisten = listen<string>(TEMPLATES_INSERT, ({ payload }) => {
      void getCurrentWindow()
        .setFocus()
        .catch(() => {});
      const view = views.current.get(activeTabRef.current ?? "");
      if (view) view.insertPrompt(payload);
      else showToast("No agent is running to send a prompt to.", "error");
    });
    return () => void unlisten.then((u) => u());
  }, [showToast]);

  return (
    <>
      {/* Views stay mounted behind the chooser. Unmounting them to show it
          would tear down their terminals -- so merely opening the chooser and
          cancelling would kill live agent sessions. */}
      <div className="app" aria-hidden={showPicker} inert={showPicker}>
        {tabs.length > 0 && (
          <ProjectTabs
            tabs={tabs}
            active={activeTab}
            running={running}
            onSelect={setActiveTab}
            onClose={(root) => void closeTab(root)}
            onOpen={openPicker}
          />
        )}
        {tabs.map((root) => (
          <ProjectView
            key={root}
            root={root}
            active={root === activeTab}
            agents={agents}
            railWidth={railWidth}
            insightWidth={insightWidth}
            resizing={resizing}
            onResizeStart={setResizing}
            onPickProject={openPicker}
            onOpenSettings={openSettings}
            showToast={showToast}
            register={register}
            onRunning={onRunning}
          />
        ))}
      </div>

      {showPicker && (
        <ProjectPicker
          recents={recents}
          missing={missing}
          error={pickError}
          onOpen={requestOpen}
          onForget={forgetRecent}
          onBrowse={() => void browseForProject()}
          onCancel={tabs.length > 0 ? () => setPicking(false) : null}
          // Only while the window is still the card's size; once the editor is
          // up the chooser is an overlay on it and must leave the window alone.
          fitWindow={!grown.current}
          pending={pending}
          onWhere={(where) =>
            pending && (where === "tab" ? void openInTab(pending) : openInWindow(pending))
          }
          onPendingCancel={() => setPending(null)}
        />
      )}

      {dialogs}
      <Toast message={toast} onDone={hideToast} />
    </>
  );
}
