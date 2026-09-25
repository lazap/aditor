import { useEffect, useState } from "react";
import { FileViewer } from "./FileViewer";
import { DiffViewer, type DiffLayout } from "./DiffViewer";
import { BADGE, type ChangeKind } from "../git/api";
import { STORAGE, loadJSON, saveJSON } from "../config";

type Mode = "diff" | "file";

interface Props {
  path: string;
  /** git status for this path, or null when unchanged / not a repo. */
  status: ChangeKind | null;
  refreshToken: number;
  onClose(): void;
}

function basename(path: string): string {
  return path.split("/").slice(-1)[0] ?? path;
}

export function BottomPane({ path, status, refreshToken, onClose }: Props) {
  const [mode, setMode] = useState<Mode>(status ? "diff" : "file");
  const [layout, setLayout] = useState<DiffLayout>(() =>
    loadJSON<DiffLayout>(STORAGE.diffLayout, "unified"),
  );

  // Re-pick the default when a different file is opened, but not on every
  // watcher refresh -- an explicit choice should survive the agent's edits.
  useEffect(() => {
    setMode(status ? "diff" : "file");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const chooseLayout = (next: DiffLayout) => {
    setLayout(next);
    saveJSON(STORAGE.diffLayout, next);
  };

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

        {mode === "diff" && status && (
          <div className="seg">
            <button
              className="seg-btn"
              data-active={layout === "unified"}
              onClick={() => chooseLayout("unified")}
              title="Unified diff"
            >
              Unified
            </button>
            <button
              className="seg-btn"
              data-active={layout === "split"}
              onClick={() => chooseLayout("split")}
              title="Side-by-side diff"
            >
              Split
            </button>
          </div>
        )}

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
