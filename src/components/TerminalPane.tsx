import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { isReservedForApp } from "../shortcuts/store";
import { useSetting } from "../settings/store";
import { createFileLinkProvider } from "../pty/fileLinks";
import { currentThemeDef, terminalOptions, useThemeDef } from "../theme";
import {
  activeSession,
  fromBase64,
  ptyKill,
  ptyResize,
  ptySpawn,
  ptyWrite,
  setActiveSession,
  type PtyEvent,
} from "../pty/api";
import { ptyRun } from "../run/api";

/** A run configuration's shell line, in place of an agent command. */
export interface RunSpec {
  /** The open workspace it runs in; `cwd` is relative to it. */
  root: string;
  script: string;
  cwd: string;
  env: Record<string, string>;
  /** The configuration it came from: how the agent asks for its output. */
  name: string;
  configId: string;
}

interface Props {
  /** Command to run in the login shell; null spawns an interactive shell. */
  command: string | null;
  cwd: string;
  /** A Claude Code session to continue, rather than starting a new one. */
  resume?: string;
  /**
   * Run this instead of `command`. Must keep its identity between renders:
   * like `command`, a new one respawns.
   */
  run?: RunSpec;
  /** Bumping this respawns -- how the agent picker switches agents. */
  generation: number;
  /** Bumping this takes the caret, without touching the session. */
  focusToken: number;
  /**
   * On screen: its project tab and its session tab are both the active ones.
   * Panes stay mounted while hidden -- unmounting kills the agent -- so this is
   * what keeps a background session from taking focus or the active slot.
   */
  visible: boolean;
  onExit(code: number | null): void;
  /** A file path in the output was clicked; `line` when it carried one. */
  onOpenPath(path: string, line?: number): void;
  /** The PTY is up, under this id. Called again after every respawn. */
  onSpawned?(id: string): void;
  /** The program rang the terminal bell. */
  onBell?(): void;
}

export function TerminalPane({
  command,
  cwd,
  resume,
  run,
  generation,
  focusToken,
  visible,
  onExit,
  onOpenPath,
  onSpawned,
  onBell,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Reachable from outside the spawn effect, so focusing never goes near the
  // dependencies that kill and respawn the PTY.
  const termRef = useRef<Terminal | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * The live terminal as state, for the link effect below: it has to re-run
   * when a respawn replaces the terminal, and a ref change would not tell it.
   */
  const [liveTerm, setLiveTerm] = useState<Terminal | null>(null);
  const fileLinks = useSetting((s) => s.terminalFileLinks);
  const theme = useThemeDef();
  // Read at click time rather than depended on: any new dependency of the spawn
  // effect is one more way to kill and restart the agent.
  const onOpenPathRef = useRef(onOpenPath);
  onOpenPathRef.current = onOpenPath;
  const onSpawnedRef = useRef(onSpawned);
  onSpawnedRef.current = onSpawned;
  const onBellRef = useRef(onBell);
  onBellRef.current = onBell;
  // Read by the spawn, not depended on, like the two above.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  /** This pane's PTY once spawned, for the visibility effect below. */
  const sessionRef = useRef<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // `disposed` makes the async spawn cancellable: if the pane goes away
    // before openpty returns, we still kill the session we asked for rather
    // than leaking a PTY with no pane.
    let disposed = false;
    let sessionId: string | null = null;

    // Read rather than depended on, like onOpenPath: the effect below repaints
    // a live terminal, so a theme change never respawns the agent.
    const term = new Terminal({
      ...terminalOptions(currentThemeDef()),
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, "Cascadia Code", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10_000,
      macOptionIsMeta: true, // Opt-arrow does word motion instead of emitting ø∂
    });
    termRef.current = term;
    setLiveTerm(term);
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    // WebGL keeps long streaming output smooth, but can fail to get a context
    // inside WKWebView -- fall back to the DOM renderer rather than show an
    // empty pane.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      /* DOM renderer is the default; nothing to do. */
    }

    // Everything the app has not claimed goes to the PTY -- the agent needs
    // Ctrl-C, Cmd-K and Opt/Cmd-arrow word motion far more than the webview
    // does. Declining a key here does not preventDefault it, which is how the
    // reserved ones go on to reach App's window listener.
    term.attachCustomKeyEventHandler((e) => {
      if (isReservedForApp(e)) return false;
      // xterm sends a bare CR for Shift+Enter, which the agent takes as submit.
      // ESC CR is the Meta+Enter the agent reads as a newline. Every event of
      // the press is declined, so no stray CR follows it.
      if (e.key === "Enter" && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
        if (e.type === "keydown") {
          e.preventDefault();
          term.input("\x1b\r", true);
        }
        return false;
      }
      return true;
    });
    term.onBell(() => onBellRef.current?.());
    fit.fit();

    /** Geometry the PTY has actually been told about. */
    let sent = { cols: term.cols, rows: term.rows };

    (async () => {
      try {
        const onEvent = (ev: PtyEvent) => {
          if (disposed) return;
          if (ev.kind === "output") term.write(fromBase64(ev.bytes));
          else onExit(ev.code);
        };
        const size = { cols: term.cols, rows: term.rows };
        const id = run
          ? await ptyRun({ ...run, ...size }, onEvent)
          : await ptySpawn({ command, cwd, ...size, resume }, onEvent);
        if (disposed) {
          void ptyKill(id);
          return;
        }
        sessionId = id;
        sessionRef.current = id;
        // A rerun after fixing what stopped the last start.
        setError(null);
        onSpawnedRef.current?.(id);
        // Published so the prompt-template chooser can type into this session
        // without a prop that would re-enter this component. Only from the pane
        // on screen: several spawn at once when a window restores its tabs.
        if (visibleRef.current) setActiveSession(id);

        // A session can vanish underneath us (killed, or the agent exited);
        // the exit event drives the UI, so swallow the write/resize rejection.
        term.onData((data) => void ptyWrite(id, data).catch(() => {}));

        if (visibleRef.current) term.focus();
      } catch (e) {
        if (disposed) return;
        setError(String(e));
        // A run that never started has still finished, as far as whatever
        // waits on it -- a Run button, a before-launch chain -- is concerned.
        if (run) onExit(null);
      }
    })();

    // Resize the PTY only after xterm has recomputed cols/rows, or the agent
    // redraws its TUI against the wrong geometry.
    let resizeTimer: number | undefined;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        // A collapsed or hidden pane measures zero, and fitting to that gives
        // a 1x1 terminal the agent then has to redraw its way out of.
        if (host.clientWidth === 0 || host.clientHeight === 0) return;
        fit.fit();
        // A resize the geometry did not actually change is a SIGWINCH the
        // agent has to redraw for, for nothing.
        if (term.cols === sent.cols && term.rows === sent.rows) return;
        sent = { cols: term.cols, rows: term.rows };
        if (sessionId)
          void ptyResize(sessionId, term.cols, term.rows).catch(() => {});
      }, 50);
    });
    observer.observe(host);

    return () => {
      disposed = true;
      window.clearTimeout(resizeTimer);
      observer.disconnect();
      // Only if it is still ours: a respawn publishes the new id before the old
      // pane's cleanup runs, and clearing unconditionally would blank it.
      if (sessionId && activeSession() === sessionId) setActiveSession(null);
      if (sessionId) void ptyKill(sessionId);
      sessionRef.current = null;
      termRef.current = null;
      setLiveTerm(null);
      term.dispose();
    };
  }, [command, cwd, resume, run, generation, onExit]);

  // Separate from the spawn effect for the same reason as focus below: turning
  // the setting on or off adds or drops the provider on the live terminal and
  // leaves the agent alone.
  useEffect(() => {
    if (!liveTerm || !fileLinks) return;
    const provider = liveTerm.registerLinkProvider(
      createFileLinkProvider(liveTerm, cwd, (path, line) =>
        onOpenPathRef.current(path, line),
      ),
    );
    return () => provider.dispose();
  }, [liveTerm, fileLinks, cwd]);

  useEffect(() => {
    if (!liveTerm) return;
    const { theme: palette, minimumContrastRatio } = terminalOptions(theme);
    liveTerm.options.theme = palette;
    liveTerm.options.minimumContrastRatio = minimumContrastRatio;
  }, [liveTerm, theme]);

  // Its own effect, and `focusToken` stays out of the spawn effect: adding it
  // there would tear down the PTY and restart the agent on every ⌘E.
  useEffect(() => {
    if (focusToken === 0 || !visibleRef.current) return;
    termRef.current?.focus();
  }, [focusToken]);

  // The pane that comes on screen takes the active slot, and the caret with it,
  // the way switching tabs in an IDE lands you in the tab. The one going off
  // screen gives the slot up -- unless the newcomer already took it, which is
  // why it checks before clearing.
  useEffect(() => {
    const id = sessionRef.current;
    if (!id) return;
    if (visible) {
      setActiveSession(id);
      termRef.current?.focus();
    } else if (activeSession() === id) {
      setActiveSession(null);
    }
  }, [visible]);

  return (
    <div className="terminal-wrap">
      {error && <div className="terminal-error">Could not start: {error}</div>}
      <div className="terminal-host" ref={hostRef} />
    </div>
  );
}
