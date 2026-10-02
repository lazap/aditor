import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FileIcon } from "./fileIcons";
import { eventChord, formatChord } from "../shortcuts/keys";
import { keymap, useBindings } from "../shortcuts/store";
import { rank } from "../search/fuzzy";
import {
  listFiles,
  searchContent,
  type ContentMatch,
  type FileList,
} from "../search/api";

export type FindMode = "files" | "content";

interface Props {
  root: string;
  mode: FindMode;
  onMode(mode: FindMode): void;
  /** `rel` is relative to the root; `line` is set for a content hit. */
  onOpen(rel: string, line?: number): void;
  onClose(): void;
}

/** Rows a name search shows; past this the query wants narrowing anyway. */
const FILE_ROWS = 100;
/** Same pause the tree uses for the watcher, so typing is not a scan per key. */
const DEBOUNCE_MS = 150;
const PAGE = 10;

/**
 * Find a file by name, or a line by its text: one card, two modes, each with
 * its own chord. The query survives a mode switch, so a name typed in the
 * wrong mode is one Tab away from the right one.
 *
 * The file list is read once per opening and ranked in the webview; content is
 * searched by the backend on each (debounced) change, newest call winning.
 */
export function FindPopup({ root, mode, onMode, onOpen, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const [files, setFiles] = useState<FileList | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [hits, setHits] = useState<{ query: string; matches: ContentMatch[]; truncated: boolean } | null>(null);
  const [hitsError, setHitsError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const bindings = useBindings();

  // Whatever had focus gets it back, as with every other dialog.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    return () => before?.focus?.();
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    setAt(0);
  }, [mode]);

  useEffect(() => {
    let stale = false;
    listFiles(root)
      .then((l) => !stale && setFiles(l))
      .catch((e) => !stale && setFilesError(String(e).replace(/^Error:\s*/, "")));
    return () => {
      stale = true;
    };
  }, [root]);

  const needle = query.trim();

  useEffect(() => {
    if (mode !== "content") return;
    if (needle === "") {
      seq.current++;
      setHits(null);
      return;
    }
    const timer = setTimeout(() => {
      const mine = ++seq.current;
      setHitsError(null);
      searchContent(root, needle, mine)
        .then((r) => {
          if (mine === seq.current) setHits({ query: needle, ...r });
        })
        .catch((e) => {
          if (mine === seq.current) setHitsError(String(e).replace(/^Error:\s*/, ""));
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [mode, needle, root]);

  const ranked = useMemo(
    () => (mode === "files" && files ? rank(needle, files.files, (f) => f, FILE_ROWS) : []),
    [mode, files, needle],
  );
  const matches = mode === "content" ? (hits?.matches ?? []) : [];
  const count = mode === "files" ? ranked.length : matches.length;
  const index = Math.min(at, Math.max(0, count - 1));

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${index}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [index, mode]);

  const choose = (i: number) => {
    if (mode === "files") {
      const r = ranked[i];
      if (r) onOpen(r.item);
    } else {
      const m = matches[i];
      if (m) onOpen(m.path, m.line);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Nothing behind the card may react to a key meant for it -- including the
    // app's chords, so the two that mean something here are handled here.
    e.stopPropagation();
    const id = keymap().get(eventChord(e.nativeEvent) ?? "");
    if (id === "find.files" || id === "find.content") {
      e.preventDefault();
      onMode(id === "find.files" ? "files" : "content");
      return;
    }
    const move = (to: number) => {
      e.preventDefault();
      if (count > 0) setAt(to);
    };
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        onClose();
        break;
      case "Tab":
        e.preventDefault();
        onMode(mode === "files" ? "content" : "files");
        break;
      case "ArrowDown":
        move((index + 1) % count);
        break;
      case "ArrowUp":
        move((index - 1 + count) % count);
        break;
      case "PageDown":
        move(Math.min(count - 1, index + PAGE));
        break;
      case "PageUp":
        move(Math.max(0, index - PAGE));
        break;
      case "Enter":
        e.preventDefault();
        choose(index);
        break;
    }
  };

  const tab = (m: FindMode, label: string, chord: string | null | undefined) => (
    <button
      className="find-mode"
      role="tab"
      aria-selected={mode === m}
      data-active={mode === m}
      tabIndex={-1}
      onClick={() => onMode(m)}
    >
      {label}
      {chord && <span className="find-chord">{formatChord(chord)}</span>}
    </button>
  );

  let note: string | null = null;
  if (mode === "files") {
    if (filesError) note = filesError;
    else if (!files) note = "Reading files…";
    else if (ranked.length === 0) note = "No matching file.";
  } else if (hitsError) note = hitsError;
  else if (needle === "") note = "Type to search file contents.";
  else if (hits?.query !== needle) note = hits ? null : "Searching…";
  else if (matches.length === 0) note = "No matches.";

  const footer =
    mode === "files"
      ? files?.truncated && `Only the first ${files.files.length.toLocaleString()} files are searched.`
      : hits?.truncated && `Showing the first ${hits.matches.length.toLocaleString()} matches.`;

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal-card find-card"
        role="dialog"
        aria-modal="true"
        aria-label={mode === "files" ? "Find file" : "Find in files"}
        onKeyDown={onKeyDown}
      >
        <div className="find-modes" role="tablist">
          {tab("files", "Files", bindings.get("find.files"))}
          {tab("content", "Content", bindings.get("find.content"))}
        </div>
        <input
          ref={inputRef}
          className="find-input"
          placeholder={mode === "files" ? "Find a file by name…" : "Find text in files…"}
          value={query}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          onChange={(e) => {
            setQuery(e.target.value);
            setAt(0);
          }}
          aria-label="Query"
        />
        <div className="find-list" role="listbox" ref={listRef}>
          {note ? (
            <div className="find-note">{note}</div>
          ) : mode === "files" ? (
            ranked.map((r, i) => (
              <FileRow
                key={r.item}
                index={i}
                path={r.item}
                positions={r.match.positions}
                selected={i === index}
                onHover={() => setAt(i)}
                onClick={() => choose(i)}
              />
            ))
          ) : (
            matches.map((m, i) => (
              <HitRow
                key={`${m.path}:${m.line}`}
                index={i}
                hit={m}
                selected={i === index}
                onHover={() => setAt(i)}
                onClick={() => choose(i)}
              />
            ))
          )}
        </div>
        {footer && <div className="find-footer">{footer}</div>}
      </div>
    </div>
  );
}

interface RowProps {
  index: number;
  selected: boolean;
  onHover(): void;
  onClick(): void;
}

function Row({ index, selected, onHover, onClick, children }: RowProps & { children: ReactNode }) {
  return (
    <div
      className="find-row"
      role="option"
      aria-selected={selected}
      data-selected={selected}
      data-index={index}
      onMouseMove={onHover}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </div>
  );
}

/** `text` with the characters at `positions` (sorted, relative to `offset`) marked. */
function marked(text: string, positions: readonly number[], offset: number): ReactNode[] {
  const out: ReactNode[] = [];
  let run = "";
  let inHit = false;
  let p = 0;
  while (p < positions.length && positions[p] < offset) p++;
  for (let i = 0; i < text.length; i++) {
    const hit = positions[p] === offset + i;
    if (hit) p++;
    if (hit !== inHit && run) {
      out.push(inHit ? <mark key={i} className="find-hit">{run}</mark> : run);
      run = "";
    }
    inHit = hit;
    run += text[i];
  }
  if (run) out.push(inHit ? <mark key="end" className="find-hit">{run}</mark> : run);
  return out;
}

function FileRow({ path, positions, ...row }: RowProps & { path: string; positions: number[] }) {
  const cut = path.lastIndexOf("/") + 1;
  const name = path.slice(cut);
  return (
    <Row {...row}>
      <FileIcon name={name} isDir={false} open={false} />
      <span className="find-name">{marked(name, positions, cut)}</span>
      {cut > 0 && <span className="find-dir">{marked(path.slice(0, cut - 1), positions, 0)}</span>}
    </Row>
  );
}

function HitRow({ hit, ...row }: RowProps & { hit: ContentMatch }) {
  const name = hit.path.slice(hit.path.lastIndexOf("/") + 1);
  return (
    <Row {...row}>
      <FileIcon name={name} isDir={false} open={false} />
      <span className="find-text">
        {hit.text.slice(0, hit.start)}
        <mark className="find-hit">{hit.text.slice(hit.start, hit.end)}</mark>
        {hit.text.slice(hit.end)}
      </span>
      <span className="find-dir">
        {hit.path}:{hit.line}
      </span>
    </Row>
  );
}
