import { useState } from "react";
import { BADGE, type FileStatus } from "../git/api";

interface Props {
  files: FileStatus[];
  root: string;
  isRepo: boolean;
  selected: string | null;
  /** Paths the watcher saw move recently -- highlighted, then fades. */
  recent: Set<string>;
  onSelect(path: string): void;
}

/**
 * Changed files, pinned above the tree. The fastest answer to "what did the
 * agent touch?" -- no expanding directories to hunt for badges.
 *
 * Always mounted, even with nothing to show: the rail would otherwise shift
 * every time the tree goes clean, and a missing section reads the same as a
 * broken one.
 */
export function ChangesList({
  files,
  root,
  isRepo,
  selected,
  recent,
  onSelect,
}: Props) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="changes">
      <button
        className="changes-header"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
      >
        <span className="tree-chevron">{collapsed ? "▸" : "▾"}</span>
        Changes
        {isRepo && <span className="changes-count">{files.length}</span>}
      </button>

      {!collapsed &&
        (!isRepo ? (
          <div className="changes-empty">Not a git repository</div>
        ) : files.length === 0 ? (
          <div className="changes-empty">No changes</div>
        ) : (
          files.map((f) => (
            <div
              key={f.path}
              className="tree-row changes-row"
              data-selected={f.path === selected}
              data-recent={recent.has(f.path)}
              onClick={() => onSelect(f.path)}
              title={f.path}
            >
              <span className="tree-status" data-status={f.status}>
                {BADGE[f.status]}
              </span>
              <span className="changes-path">
                {f.path.startsWith(root)
                  ? f.path.slice(root.length + 1)
                  : f.path}
              </span>
            </div>
          ))
        ))}
    </div>
  );
}
