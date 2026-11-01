import { useEffect, useRef, useState } from "react";
import { Annotation, Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { selectAll } from "@codemirror/commands";
import { CHANGED_ON_DISK, readFile, writeFile, type FileContents } from "../fs/api";
import { AUTOSAVE_MS, trackEdits } from "../editor/autosave";
import { aditorEditorTheme, aditorHighlighting, darkMode, darkModeFor } from "../editor/theme";
import { loadLanguage } from "../editor/language";
import { vimMode, vimMotions } from "../editor/vim";
import { jumpLine, jumpToLine } from "../editor/jumpLine";
import { blame, blameGutter } from "../editor/blame";
import { gitBlame, type BlameHunk } from "../git/api";
import { openLogWindow } from "../window";
import { useSetting } from "../settings/store";
import { useTheme } from "../theme";

/**
 * A line to show. `token` changes on every request, so asking for the same
 * line twice -- after scrolling away -- still jumps.
 */
export interface LineTarget {
  line: number;
  token: number;
}

interface Props {
  /** Workspace the file belongs to; every read is checked against it. */
  root: string;
  path: string;
  /** Bumped by the watcher; reloads when the agent rewrites the file. */
  refreshToken: number;
  /** Take focus once built, so the keyboard lands in the file without a click. */
  autoFocus?: boolean;
  /** Scroll to and mark this line once the file is up. */
  target?: LineTarget | null;
  /** Bumped to put the keyboard in the file, once this path's view is up. */
  focusToken?: number;
  /** Show the blame gutter. */
  annotate?: boolean;
  /** Blame could not be read (not committed, not a repo): the owner says so. */
  onAnnotateError?(message: string): void;
  /** Unlocked by the user: typing edits the file, and it saves itself. */
  editable?: boolean;
}

/** Marks a doc swap that came from disk, so it is not mistaken for typing. */
const fromDisk = Annotation.define<boolean>();

/** Read-only or not, swapped on the live view. */
const editMode = new Compartment();
const editFor = (on: boolean): Extension => EditorState.readOnly.of(!on);

/** What is waiting to be written, and where. */
interface Unsaved {
  root: string;
  path: string;
  text: string;
  /** The disk text this edit started from; the write refuses if it moved. */
  base: string | null;
}

export function formatBytes(n: number): string {
  return n > 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(n / 1024)} KB`;
}

export function FileViewer({
  root,
  path,
  refreshToken,
  autoFocus,
  target,
  focusToken,
  annotate,
  onAnnotateError,
  editable = false,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [contents, setContents] = useState<FileContents | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Vim here is motions only, for reading: on an editable file j and k must
  // type, so the motions step aside while it is unlocked.
  const vim = useSetting((s) => s.keyboardMode === "vim") && !editable;
  const editableRef = useRef(editable);
  editableRef.current = editable;
  const [saveError, setSaveError] = useState<string | null>(null);
  /** Typed but not yet written. */
  const unsavedRef = useRef<Unsaved | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  /** The disk text the buffer is based on: what the last read or write left. */
  const baseRef = useRef<string | null>(null);
  /**
   * The file changed on disk under unsaved typing. Autosave stops until the
   * user picks a side, or it would overwrite the agent's change unseen.
   */
  const [conflict, setConflictState] = useState(false);
  const conflictRef = useRef(false);
  const setConflict = (on: boolean) => {
    conflictRef.current = on;
    setConflictState(on);
  };

  /**
   * Write whatever is waiting, now. Safe to call with nothing waiting.
   * `overwrite` writes even over a change made on disk since.
   */
  const flushRef = useRef(async (_overwrite?: boolean) => {});
  flushRef.current = async (overwrite = false) => {
    window.clearTimeout(saveTimer.current);
    const job = unsavedRef.current;
    if (!job || (conflictRef.current && !overwrite)) return;
    unsavedRef.current = null;
    // Ahead of the write, so typing while it is out bases on what it writes.
    baseRef.current = job.text;
    try {
      await writeFile(job.root, job.path, job.text, overwrite ? undefined : (job.base ?? undefined));
      setSaveError(null);
    } catch (e) {
      if (baseRef.current === job.text) baseRef.current = job.base;
      if (String(e).includes(CHANGED_ON_DISK)) {
        // Keep the typing, newest first, for an overwrite.
        unsavedRef.current = unsavedRef.current ?? job;
        setConflict(true);
        return;
      }
      setSaveError(`Not saved: ${String(e).replace(/^Error:\s*/, "")}`);
    }
  };
  // Registered once: the ref always holds this render's flush.
  useEffect(() => trackEdits(() => flushRef.current()), []);
  // Read by the build effect rather than depended on: flipping the setting
  // reconfigures the live view below instead of rebuilding it.
  const vimRef = useRef(vim);
  vimRef.current = vim;
  // Same arrangement for the theme.
  const theme = useTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const autoFocusRef = useRef(autoFocus);
  autoFocusRef.current = autoFocus;
  const [hunks, setHunks] = useState<BlameHunk[] | null>(null);
  const hunksRef = useRef(hunks);
  hunksRef.current = hunks;
  const onAnnotateErrorRef = useRef(onAnnotateError);
  onAnnotateErrorRef.current = onAnnotateError;

  // Re-read with the file: blame is of the working copy, so an edit moves it.
  useEffect(() => {
    if (!annotate) {
      setHunks(null);
      return;
    }
    let stale = false;
    gitBlame(root, path)
      .then((h) => !stale && setHunks(h))
      .catch((e) => {
        if (stale) return;
        setHunks(null);
        onAnnotateErrorRef.current?.(String(e).replace(/^Error:\s*/, ""));
      });
    return () => {
      stale = true;
    };
  }, [annotate, root, path, refreshToken]);

  // A target belongs to the path it arrived with, and must land on that file's
  // view -- not on the previous file's, still up while the new one loads. So
  // the view records which path it shows, and each token is applied once: a
  // watcher refresh rebuilds the view, and should not yank it back to the line.
  const pathRef = useRef(path);
  pathRef.current = path;
  const targetRef = useRef(target);
  targetRef.current = target;
  /** Which path `contents` was read for; it lags `path` while a read is out. */
  const loadedPathRef = useRef<string | null>(null);
  const viewPathRef = useRef<string | null>(null);
  const jumpedRef = useRef<number | null>(null);
  const jump = () => {
    const view = viewRef.current;
    const t = targetRef.current;
    if (!view || !t || t.token === jumpedRef.current) return;
    if (viewPathRef.current !== pathRef.current) return;
    jumpedRef.current = t.token;
    jumpToLine(view, t.line);
  };
  const focusTokenRef = useRef(focusToken);
  focusTokenRef.current = focusToken;
  const focusedRef = useRef<number | undefined>(undefined);
  const takeFocus = () => {
    const view = viewRef.current;
    const t = focusTokenRef.current;
    if (!view || !t || t === focusedRef.current) return;
    if (viewPathRef.current !== pathRef.current) return;
    focusedRef.current = t;
    view.focus();
  };

  useEffect(() => {
    let stale = false;
    setError(null);
    readFile(root, path)
      .then((c) => {
        if (stale) return;
        loadedPathRef.current = path;
        setContents(c);
      })
      .catch((e) => !stale && setError(String(e)));
    return () => {
      stale = true;
    };
  }, [root, path, refreshToken]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || contents?.kind !== "text") return;
    // Still the previous file's text: wait for this one's rather than dress
    // the old text in the new file's language.
    if (loadedPathRef.current !== path) return;

    const text = contents.text;
    // A refresh of the file already on screen: swap the text in place, which
    // keeps the caret and the scroll. Not while typing is waiting to be saved
    // -- the refresh is most likely our own save landing, and replacing the
    // buffer would throw away what was typed since.
    const live = viewRef.current;
    if (live && viewPathRef.current === path) {
      if (unsavedRef.current) return;
      baseRef.current = text;
      if (live.state.doc.toString() === text) return;
      const { anchor, head } = live.state.selection.main;
      const clamp = (n: number) => Math.min(n, text.length);
      live.dispatch({
        changes: { from: 0, to: live.state.doc.length, insert: text },
        selection: { anchor: clamp(anchor), head: clamp(head) },
        annotations: fromDisk.of(true),
      });
      return;
    }

    let disposed = false;

    (async () => {
      const lang = await loadLanguage(path);
      if (disposed) return;

      const extensions: Extension[] = [
        lineNumbers(),
        aditorEditorTheme,
        aditorHighlighting,
        EditorView.lineWrapping,
        // Read-only unless the user unlocked this file.
        editMode.of(editFor(editableRef.current)),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged || u.transactions.some((t) => t.annotation(fromDisk))) return;
          unsavedRef.current = {
            root,
            path,
            text: u.state.doc.toString(),
            base: unsavedRef.current?.base ?? baseRef.current,
          };
          window.clearTimeout(saveTimer.current);
          saveTimer.current = window.setTimeout(() => void flushRef.current(), AUTOSAVE_MS);
        }),
        // IntelliJ saves when focus leaves the editor; so does this.
        EditorView.domEventHandlers({ blur: () => void flushRef.current() }),
        vimMode.of(vimMotions(vimRef.current)),
        darkMode.of(darkModeFor(themeRef.current)),
        jumpLine,
        // The browser's own select all reaches only the lines drawn around the
        // viewport; this takes the whole document.
        keymap.of([{ key: "Mod-a", run: selectAll }]),
        blame.of(gutterFor(hunksRef.current, root, path)),
        ...lang,
      ];

      viewRef.current?.destroy();
      viewRef.current = new EditorView({
        state: EditorState.create({ doc: text, extensions }),
        parent: host,
      });
      baseRef.current = text;
      viewPathRef.current = path;
      if (autoFocusRef.current) viewRef.current.focus();
      takeFocus();
      jump();
    })();

    return () => {
      disposed = true;
    };
  }, [contents, root, path]);

  // The file may already be up (another line in the open file), or not yet, in
  // which case the build above takes the jump when it lands.
  useEffect(() => jump(), [target?.token]);
  useEffect(() => takeFocus(), [focusToken]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: vimMode.reconfigure(vimMotions(vim)) });
  }, [vim]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: editMode.reconfigure(editFor(editable)) });
    if (!editable) void flushRef.current();
  }, [editable]);

  // Switching to another file saves this one first; the next build replaces
  // the view, and its text with it. Typing held back by a conflict is dropped
  // with the file, leaving the change on disk in place.
  useEffect(
    () => () => {
      void flushRef.current();
      if (conflictRef.current) {
        unsavedRef.current = null;
        setConflict(false);
      }
    },
    [root, path],
  );

  /** Drop the typing and show what is on disk. */
  const reload = async () => {
    window.clearTimeout(saveTimer.current);
    unsavedRef.current = null;
    setConflict(false);
    try {
      const c = await readFile(root, path);
      loadedPathRef.current = path;
      setContents(c);
    } catch (e) {
      setError(String(e));
    }
  };

  /** Keep the typing, writing it over the change on disk. */
  const overwrite = () => {
    setConflict(false);
    void flushRef.current(true);
  };

  useEffect(() => {
    viewRef.current?.dispatch({ effects: darkMode.reconfigure(darkModeFor(theme)) });
  }, [theme]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: blame.reconfigure(gutterFor(hunks, root, pathRef.current)),
    });
  }, [hunks, root]);

  useEffect(
    () => () => {
      viewRef.current?.destroy();
      viewRef.current = null;
    },
    [],
  );

  return (
    <>
      {error && <div className="viewer-message error">{error}</div>}
      {saveError && <div className="viewer-message error">{saveError}</div>}
      {conflict && (
        <div className="viewer-message error viewer-conflict">
          Changed on disk while you were typing; not saved.
          <button className="seg-btn" onClick={() => void reload()}>
            Reload
          </button>
          <button className="seg-btn" onClick={overwrite}>
            Overwrite
          </button>
        </div>
      )}
      {contents?.kind === "tooLarge" && (
        <div className="viewer-message">
          {formatBytes(contents.bytes)} — too large to display
        </div>
      )}
      {contents?.kind === "binary" && (
        <div className="viewer-message">Binary file</div>
      )}
      <div
        className="viewer-host"
        ref={hostRef}
        hidden={contents?.kind !== "text"}
      />
    </>
  );
}

/** A click opens the commit in the log, with this file's diff in it. */
const gutterFor = (hunks: BlameHunk[] | null, root: string, path: string): Extension =>
  hunks ? blameGutter(hunks, (id) => void openLogWindow({ root, select: id, file: path })) : [];
