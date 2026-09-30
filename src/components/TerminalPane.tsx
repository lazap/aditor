import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { listen } from "@tauri-apps/api/event";
import { isReservedForApp } from "../shortcuts/store";
import { useSetting } from "../settings/store";
import { createFileLinkProvider } from "../pty/fileLinks";
import {
  activeSession,
  fromBase64,
  ptyKill,
  ptyResize,
  ptySpawn,
  ptyWrite,
  setActiveSession,
  type PtyExit,
  type PtyOutput,
} from "../pty/api";

const terminalTheme = {
  background: "#14161a",
  foreground: "#d7dae0",
  cursor: "#7aa2f7",
  cursorAccent: "#14161a",
  selectionBackground: "#2d3343",
  black: "#14161a",
  red: "#f7768e",
  green: "#9ece6a",
  yellow: "#e0af68",
  blue: "#7aa2f7",
  magenta: "#bb9af7",
  cyan: "#7dcfff",
  white: "#c0caf5",
  brightBlack: "#565f89",
  brightRed: "#ff899d",
  brightGreen: "#b9f27c",
  brightYellow: "#ffc777",
  brightBlue: "#8db0ff",
  brightMagenta: "#caa9fa",
  brightCyan: "#b4f9f8",
  brightWhite: "#eaeefb",
};

interface Props {
  /** Command to run in the login shell; null spawns an interactive shell. */
  command: string | null;
  cwd: string;
  /** Bumping this respawns -- how the agent picker switches agents. */
  generation: number;
  /** Bumping this takes the caret, without touching the session. */
  focusToken: number;
  onExit(code: number | null): void;
  /** A file path in the output was clicked; `line` when it carried one. */
  onOpenPath(path: string, line?: number): void;
}

export function TerminalPane({
  command,
  cwd,
  generation,
  focusToken,
  onExit,
  onOpenPath,
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
  // Read at click time rather than depended on: any new dependency of the spawn
  // effect is one more way to kill and restart the agent.
  const onOpenPathRef = useRef(onOpenPath);
  onOpenPathRef.current = onOpenPath;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // `disposed` makes the async spawn cancellable: if the pane goes away
    // before openpty returns, we still kill the session we asked for rather
    // than leaking a PTY with no pane.
    let disposed = false;
    let sessionId: string | null = null;
    const unlisteners: Array<() => void> = [];

    const term = new Terminal({
      theme: terminalTheme,
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
    term.attachCustomKeyEventHandler((e) => !isReservedForApp(e));
    fit.fit();

    /** Geometry the PTY has actually been told about. */
    let sent = { cols: term.cols, rows: term.rows };

    (async () => {
      try {
        const id = await ptySpawn({
          command,
          cwd,
          cols: term.cols,
          rows: term.rows,
        });
        if (disposed) {
          void ptyKill(id);
          return;
        }
        sessionId = id;
        // Published so the prompt-template chooser can type into this session
        // without a prop that would re-enter this component.
        setActiveSession(id);

        // A session can vanish underneath us (killed, or the agent exited);
        // pty://exit drives the UI, so swallow the write/resize rejection.
        term.onData((data) => void ptyWrite(id, data).catch(() => {}));

        unlisteners.push(
          await listen<PtyOutput>("pty://output", (ev) => {
            if (ev.payload.id === id) term.write(fromBase64(ev.payload.bytes));
          }),
        );
        unlisteners.push(
          await listen<PtyExit>("pty://exit", (ev) => {
            if (ev.payload.id === id) onExit(ev.payload.code);
          }),
        );
        term.focus();
      } catch (e) {
        if (!disposed) setError(String(e));
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
      unlisteners.forEach((u) => u());
      // Only if it is still ours: a respawn publishes the new id before the old
      // pane's cleanup runs, and clearing unconditionally would blank it.
      if (sessionId && activeSession() === sessionId) setActiveSession(null);
      if (sessionId) void ptyKill(sessionId);
      termRef.current = null;
      setLiveTerm(null);
      term.dispose();
    };
  }, [command, cwd, generation, onExit]);

  // Separate from the spawn effect for the same reason as focus below: turning
  // the setting on or off adds or drops the provider on the live terminal and
  // leaves the agent alone.
  useEffect(() => {
    if (!liveTerm || !fileLinks) return;
    const provider = liveTerm.registerLinkProvider(
      createFileLinkProvider(liveTerm, (path, line) =>
        onOpenPathRef.current(path, line),
      ),
    );
    return () => provider.dispose();
  }, [liveTerm, fileLinks]);

  // Its own effect, and `focusToken` stays out of the one above: adding it
  // there would tear down the PTY and restart the agent on every ⌘3.
  useEffect(() => {
    if (focusToken === 0) return;
    termRef.current?.focus();
  }, [focusToken]);

  return (
    <div className="terminal-wrap">
      {error && <div className="terminal-error">Could not start: {error}</div>}
      <div className="terminal-host" ref={hostRef} />
    </div>
  );
}
