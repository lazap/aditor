import { useEffect, useLayoutEffect, useRef } from "react";
import type { RecentProject } from "../projects";
import { fitWindowToPicker } from "../window";

interface Props {
  recents: RecentProject[];
  /** Paths whose directory is gone; shown but not openable. */
  missing: Set<string>;
  /** Why the last open attempt failed, if it did. */
  error: string | null;
  onOpen(path: string): void;
  onForget(path: string): void;
  onBrowse(): void;
  /** null on first run -- there is no project to go back to. */
  onCancel: (() => void) | null;
  /**
   * Shrink the window around this card. Only true before any project has been
   * opened; once the editor is up the chooser is an overlay on it and must
   * leave the window alone.
   */
  fitWindow: boolean;
  /**
   * A folder picked while this window already has projects open: the card
   * asks where it goes, as JetBrains does, before anything is opened.
   */
  pending: string | null;
  onWhere(where: "tab" | "window"): void;
  /** Back from the question to the list. */
  onPendingCancel(): void;
}

/** Where a picked folder opens. "Tab" first: it is the common answer. */
function WhereStep({
  path,
  onWhere,
  onBack,
}: {
  path: string;
  onWhere(where: "tab" | "window"): void;
  onBack(): void;
}) {
  const { name, parent } = split(path);
  return (
    <>
      <div className="picker-section-label">Open project</div>
      <p className="picker-where" title={path}>
        <span className="recent-name">{name}</span>
        <span className="recent-path">{parent}</span>
      </p>
      <div className="picker-actions picker-where-actions">
        <button className="picker-browse" onClick={() => onWhere("tab")}>
          This window
        </button>
        <button className="picker-cancel" onClick={() => onWhere("window")}>
          New window
        </button>
        <button className="picker-cancel" onClick={onBack}>
          Cancel
        </button>
      </div>
    </>
  );
}

/** `/Users/me/dev/aditor` -> `{ name: "aditor", parent: "~/dev" }`. */
function split(path: string): { name: string; parent: string } {
  const parts = path.split("/").filter(Boolean);
  const name = parts[parts.length - 1] ?? path;
  const parent = "/" + parts.slice(0, -1).join("/");
  return { name, parent: tildify(parent) };
}

/**
 * Collapse the home directory. The webview has no `os.homedir`, but every
 * recent is an absolute path and `/Users/<name>` is the only shape that
 * matters on the platform Aditor runs on.
 */
function tildify(dir: string): string {
  const m = /^\/(?:Users|home)\/([^/]+)(\/.*)?$/.exec(dir);
  return m ? `~${m[2] ?? ""}` : dir;
}

/**
 * Full-screen chooser: the first thing Aditor shows, and where the topbar path
 * button (or Cmd-O) returns to. Deliberately an overlay over a still-mounted
 * app -- opening it must not tear down a running agent, which is what
 * unmounting TerminalPane would do.
 */
export function ProjectPicker({
  recents,
  missing,
  error,
  onOpen,
  onForget,
  onBrowse,
  onCancel,
  fitWindow,
  pending,
  onWhere,
  onPendingCancel,
}: Props) {
  const cardRef = useRef<HTMLDivElement>(null);

  // Take focus off whatever had it -- in practice the terminal, whose xterm
  // key handler would otherwise swallow Escape and the arrow keys.
  // Again for the where-to question, so Enter answers "This window".
  useEffect(() => {
    cardRef.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();
  }, [pending]);

  // Measure after layout, before paint, so the window is never briefly the
  // wrong size. Re-runs as the card grows or shrinks: removing the last recent
  // or surfacing an error changes its height.
  useLayoutEffect(() => {
    if (!fitWindow) return;
    const card = cardRef.current;
    const overlay = card?.parentElement;
    if (!card || !overlay) return;
    // Read, not assumed: the top padding also clears the title bar on macOS.
    const pad = getComputedStyle(overlay);
    const padding = parseFloat(pad.paddingTop) + parseFloat(pad.paddingBottom);
    void fitWindowToPicker(card.getBoundingClientRect().height + padding);
  }, [fitWindow, recents.length, error]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && pending) {
      e.preventDefault();
      onPendingCancel();
      return;
    }
    if (e.key === "Escape" && onCancel) {
      e.preventDefault();
      onCancel();
      return;
    }
    const list = Array.from(
      cardRef.current?.querySelectorAll<HTMLButtonElement>(
        ".recent-open:not(:disabled), .picker-browse",
      ) ?? [],
    );
    if (list.length === 0) return;
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    let next: HTMLButtonElement | undefined;
    if (e.key === "ArrowDown") next = list[(i + 1) % list.length];
    else if (e.key === "ArrowUp") next = list[(i - 1 + list.length) % list.length];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };

  return (
    <div
      className="picker-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Open a project"
      onKeyDown={onKeyDown}
      // Covers the tabs strip, so it is the title bar while it is up.
      data-tauri-drag-region
    >
      <div className="picker-card" ref={cardRef}>
        <h1 className="picker-title">Aditor</h1>

        {pending ? (
          <WhereStep path={pending} onWhere={onWhere} onBack={onPendingCancel} />
        ) : (
          <>
            {recents.length > 0 ? (
              <>
                <div className="picker-section-label">Recent</div>
                <ul className="recent-list">
                  {recents.map((r) => {
                    const { name, parent } = split(r.path);
                    const gone = missing.has(r.path);
                    return (
                      <li
                        className="recent-row"
                        key={r.path}
                        data-missing={gone}
                        title={r.path}
                      >
                        <button
                          className="recent-open"
                          disabled={gone}
                          onClick={() => onOpen(r.path)}
                        >
                          <span className="recent-name">{name}</span>
                          <span className="recent-path">
                            {gone ? "missing" : parent}
                          </span>
                        </button>
                        <button
                          className="recent-forget"
                          aria-label={`Remove ${name} from recents`}
                          title="Remove from recents"
                          onClick={() => onForget(r.path)}
                        >
                          ✕
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : (
              <p className="picker-empty">
                No projects yet. Choose a folder to open it in Aditor.
              </p>
            )}

            {error && <p className="picker-error">{error}</p>}

            <div className="picker-actions">
              <button className="picker-browse" onClick={onBrowse}>
                Open folder…
              </button>
              {onCancel && (
                <button className="picker-cancel" onClick={onCancel}>
                  Cancel
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
