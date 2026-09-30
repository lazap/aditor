import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { DiffViewer } from "./DiffViewer";
import { DiffLayoutToggle } from "./BottomPane";
import { BADGE, gitStatus, type ChangeKind } from "../git/api";
import { fsDebounceMs } from "../fs/api";
import { useSetting } from "../settings/store";
import { basename, DIFF_PATH } from "../window";

const initialPath = (): string =>
  new URLSearchParams(location.search).get("path") ?? "";

/**
 * One file's diff, in a window of its own.
 *
 * It keeps itself current rather than being fed by App: the watcher's
 * `fs://changed` reaches every window, and `git_diff` / `git_status` answer
 * against the one open workspace whichever window asks.
 */
export function DiffWindow({ onClose }: { onClose(): void }) {
  const [path, setPath] = useState(initialPath);
  const [refreshToken, setRefreshToken] = useState(0);
  /** undefined = not back yet; null = no longer changed. */
  const [status, setStatus] = useState<ChangeKind | null | undefined>(undefined);
  const layout = useSetting((s) => s.layout.diffLayout);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Somewhere for the keyboard to land, so Escape works straight away.
  useEffect(() => closeRef.current?.focus(), []);

  // On the window, not the page: WebKit does not focus a button on click, so
  // after using the layout toggle focus is on <body>, outside the page, and a
  // handler there would never see the key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const unlisten = listen<string>(DIFF_PATH, ({ payload }) => {
      setPath(payload);
      setStatus(undefined);
      void getCurrentWindow().setTitle(basename(payload));
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
        {status && <DiffLayoutToggle />}
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

      {status === null && (
        <div className="viewer-message">No changes to diff</div>
      )}
      {status && (
        <DiffViewer path={path} layout={layout} refreshToken={refreshToken} />
      )}
    </div>
  );
}
