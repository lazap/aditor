import { useCallback, useEffect, useState } from "react";
import { listDir, type DirEntry } from "../fs/api";
import { BADGE, type ChangeKind } from "../git/api";

interface Props {
  root: string;
  selected: string | null;
  onSelect(path: string): void;
  /** Bumped by the workspace watcher to force a refetch of loaded levels. */
  refreshToken: number;
  expanded: Set<string>;
  onToggle(path: string): void;
  /** Absolute path -> git status, for row badges. */
  statuses: Map<string, ChangeKind>;
  /** Paths the watcher saw move recently -- accented, then fades. */
  recent: Set<string>;
}

export function FileTree({
  root,
  selected,
  onSelect,
  refreshToken,
  expanded,
  onToggle,
  statuses,
  recent,
}: Props) {
  return (
    <div className="tree" role="tree">
      {/* Keyed by root so switching projects mounts a clean level rather than
          showing the previous project's entries until the refetch lands. */}
      <Level
        key={root}
        dir={root}
        depth={0}
        selected={selected}
        onSelect={onSelect}
        refreshToken={refreshToken}
        expanded={expanded}
        onToggle={onToggle}
        statuses={statuses}
        recent={recent}
      />
    </div>
  );
}

interface LevelProps extends Omit<Props, "root"> {
  dir: string;
  depth: number;
}

/** Is anything changed under this directory? Drives the collapsed-folder dot. */
function dirHasChanges(dir: string, statuses: Map<string, ChangeKind>): boolean {
  const prefix = dir.endsWith("/") ? dir : `${dir}/`;
  for (const p of statuses.keys()) if (p.startsWith(prefix)) return true;
  return false;
}

/**
 * One directory level. Children are fetched when first shown, so a deep or
 * heavy tree costs nothing until it is actually opened.
 */
function Level({
  dir,
  depth,
  selected,
  onSelect,
  refreshToken,
  expanded,
  onToggle,
  statuses,
  recent,
}: LevelProps) {
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    listDir(dir)
      .then(setEntries)
      .catch((e) => setError(String(e)));
  }, [dir]);

  // refreshToken in the deps is what makes the watcher's changes show up:
  // every loaded level refetches, which is cheap because each is one level.
  useEffect(load, [load, refreshToken]);

  if (error) return <div className="tree-error">{error}</div>;
  if (!entries) return null;

  return (
    <>
      {entries.map((entry) => {
        const isOpen = expanded.has(entry.path);
        const status = statuses.get(entry.path);
        const changedInside =
          entry.isDir && !isOpen && dirHasChanges(entry.path, statuses);
        return (
          <div key={entry.path}>
            <div
              className="tree-row"
              role="treeitem"
              aria-expanded={entry.isDir ? isOpen : undefined}
              data-selected={entry.path === selected}
              data-recent={recent.has(entry.path)}
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={() =>
                entry.isDir ? onToggle(entry.path) : onSelect(entry.path)
              }
            >
              <span className="tree-chevron">
                {entry.isDir ? (isOpen ? "▾" : "▸") : ""}
              </span>
              <span className="tree-name" data-dir={entry.isDir}>
                {entry.name}
              </span>
              {status && (
                <span className="tree-status" data-status={status}>
                  {BADGE[status]}
                </span>
              )}
              {changedInside && <span className="tree-dot" />}
            </div>
            {entry.isDir && isOpen && (
              <Level
                dir={entry.path}
                depth={depth + 1}
                selected={selected}
                onSelect={onSelect}
                refreshToken={refreshToken}
                expanded={expanded}
                onToggle={onToggle}
                statuses={statuses}
                recent={recent}
              />
            )}
          </div>
        );
      })}
    </>
  );
}
