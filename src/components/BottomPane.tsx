import { useEffect, useState } from "react";
import { FileViewer } from "./FileViewer";
import { DiffViewer, type DiffLayout } from "./DiffViewer";
import { BADGE, type ChangeKind } from "../git/api";
import { patchLayout, useSetting } from "../settings/store";
import { basename, openDiffWindow } from "../window";

type Mode = "diff" | "file";

interface Props {
  path: string;
  /** git status for this path, or null when unchanged / not a repo. */
  status: ChangeKind | null;
  refreshToken: number;
  /** Diffs open in their own window: this pane only ever shows the file. */
  diffInWindow: boolean;
  onClose(): void;
}

/**
 * Unified / Split. Read straight from settings rather than mirrored into state,
 * so the General tab, this pane and the diff window cannot disagree.
 */
export function DiffLayoutToggle() {
  const layout = useSetting((s) => s.layout.diffLayout);
  const choose = (next: DiffLayout) => patchLayout({ diffLayout: next });

  return (
    <div className="seg">
      <button
        className="seg-btn"
        data-active={layout === "unified"}
        onClick={() => choose("unified")}
        title="Unified diff"
      >
        Unified
      </button>
      <button
        className="seg-btn"
        data-active={layout === "split"}
        onClick={() => choose("split")}
        title="Side-by-side diff"
      >
        Split
      </button>
    </div>
  );
}

export function BottomPane({ path, status, refreshToken, diffInWindow, onClose }: Props) {
  const pick = (): Mode => (status && !diffInWindow ? "diff" : "file");
  const [mode, setMode] = useState<Mode>(pick);
  const layout = useSetting((s) => s.layout.diffLayout);

  // Re-pick the default when a different file is opened, but not on every
  // watcher refresh -- an explicit choice should survive the agent's edits.
  useEffect(() => {
    setMode(pick());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, diffInWindow]);

  return (
    <div className="viewer">
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
            onClick={() => (diffInWindow ? void openDiffWindow(path) : setMode("diff"))}
            title={
              !status
                ? "No changes to diff"
                : diffInWindow
                  ? "Open the diff against HEAD in its own window"
                  : "Show diff against HEAD"
            }
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

        <span className="viewer-badge">read-only</span>
        <button className="viewer-close" onClick={onClose} title="Close file">
          ✕
        </button>
      </div>

      {mode === "diff" && status ? (
        <DiffViewer path={path} layout={layout} refreshToken={refreshToken} />
      ) : (
        <FileViewer path={path} refreshToken={refreshToken} />
      )}
    </div>
  );
}
