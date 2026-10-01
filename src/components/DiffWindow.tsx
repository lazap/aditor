import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { DiffViewer } from "./DiffViewer";
import { FileViewer, type LineTarget } from "./FileViewer";
import { AnnotateToggle, DiffLayoutToggle } from "./BottomPane";
import { eventChord } from "../shortcuts/keys";
import { chordFor } from "../shortcuts/store";
import { BADGE, gitStatus, type ChangeKind } from "../git/api";
import { fsDebounceMs } from "../fs/api";
import { useSetting } from "../settings/store";
import { basename, DIFF_PATH, type ViewerMode, type ViewerTarget } from "../window";

const initialPath = (): string =>
  new URLSearchParams(location.search).get("path") ?? "";

const initialMode = (): ViewerMode =>
  new URLSearchParams(location.search).get("mode") === "file" ? "file" : "diff";

const initialTarget = (): LineTarget | null => {
  const line = Number(new URLSearchParams(location.search).get("line"));
  return line > 0 ? { line, token: 0 } : null;
};

/**
 * One file -- its diff, or the file itself -- in a window of its own.
 *
 * It keeps itself current rather than being fed by App: the watcher's
 * `fs://changed` reaches every window, and `git_diff` / `git_status` answer
 * against the one open workspace whichever window asks.
 */
export function DiffWindow({ onClose }: { onClose(): void }) {
  const [path, setPath] = useState(initialPath);
  const [mode, setMode] = useState(initialMode);
  const [target, setTarget] = useState(initialTarget);
  const [refreshToken, setRefreshToken] = useState(0);
  /** undefined = not back yet; null = no longer changed. */
  const [status, setStatus] = useState<ChangeKind | null | undefined>(undefined);
  const layout = useSetting((s) => s.layout.diffLayout);
  const vim = useSetting((s) => s.keyboardMode === "vim");
  const closeRef = useRef<HTMLButtonElement>(null);
  const [annotate, setAnnotate] = useState(false);
  const [annotateError, setAnnotateError] = useState<string | null>(null);
  useEffect(() => setAnnotateError(null), [annotate, path]);

  // Somewhere for the keyboard to land, so Escape works straight away.
  useEffect(() => closeRef.current?.focus(), []);

  // On the window, not the page: WebKit does not focus a button on click, so
  // after using the layout toggle focus is on <body>, outside the page, and a
  // handler there would never see the key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The app's dispatcher lives in the main window; this one answers the
      // one command that is about what it shows.
      const chord = eventChord(e);
      if (chord !== null && chord === chordFor("git.annotate")) {
        e.preventDefault();
        setMode("file");
        setAnnotate((a) => !a);
        return;
      }
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const unlisten = listen<ViewerTarget>(DIFF_PATH, ({ payload }) => {
      setPath(payload.path);
      setMode(payload.mode);
      setTarget(
        payload.line ? { line: payload.line, token: Date.now() } : null,
      );
      setStatus(undefined);
      void getCurrentWindow().setTitle(basename(payload.path));
    });
    return () => void unlisten.then((u) => u());
  }, []);

  // Same debounce as App, so this window and the main one refresh together.
  useEffect(() => {
    let timer: number | undefined;
    let debounce = 150;
    void fsDebounceMs().then((ms) => (debounce = ms));

    const unlisten = listen<string[]>("fs://changed", () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setRefreshToken((t) => t + 1), debounce);
    });
    return () => {
      window.clearTimeout(timer);
      void unlisten.then((u) => u());
    };
  }, []);

  useEffect(() => {
    let stale = false;
    gitStatus()
      .then((s) => {
        if (!stale) setStatus(s.files.find((f) => f.path === path)?.status ?? null);
      })
      .catch(() => !stale && setStatus(null));
    return () => {
      stale = true;
    };
  }, [path, refreshToken]);

  return (
    <div className="viewer diff-page">
      <div className="viewer-bar">
        <span className="viewer-path" title={path}>
          {basename(path)}
        </span>
        {status && (
          <span className="viewer-status" data-status={status}>
            {BADGE[status]}
          </span>
        )}
        <div className="seg">
          <button
            className="seg-btn"
            data-active={mode === "diff"}
            disabled={!status}
            onClick={() => setMode("diff")}
            title={status ? "Show diff against HEAD" : "No changes to diff"}
          >
            Diff
          </button>
          <button
            className="seg-btn"
            data-active={mode === "file"}
            onClick={() => setMode("file")}
          >
            File
          </button>
        </div>
        {mode === "diff" && status && <DiffLayoutToggle />}
        {mode === "file" && (
          <AnnotateToggle on={annotate} onToggle={() => setAnnotate((a) => !a)} />
        )}
        {annotate && annotateError && (
          <span className="viewer-message error viewer-inline">{annotateError}</span>
        )}
        <span className="viewer-badge">read-only</span>
        <button
          className="viewer-close"
          ref={closeRef}
          onClick={onClose}
          title="Close window"
        >
          ✕
        </button>
      </div>

      {mode === "file" && (
        <FileViewer
          path={path}
          refreshToken={refreshToken}
          target={target}
          autoFocus
          annotate={annotate}
          onAnnotateError={setAnnotateError}
        />
      )}
      {mode === "diff" && status === null && (
        <div className="viewer-message">No changes to diff</div>
      )}
      {mode === "diff" && status && (
        <DiffViewer
          path={path}
          layout={layout}
          refreshToken={refreshToken}
          autoFocus={vim}
        />
      )}
    </div>
  );
}
