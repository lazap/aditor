import { useEffect, useRef, useState } from "react";
import { Annotation, Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { readFile, writeFile, type FileContents } from "../fs/api";
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
}

function formatBytes(n: number): string {
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

  /** Write whatever is waiting, now. Safe to call with nothing waiting. */
  const flushRef = useRef(async () => {});
  flushRef.current = async () => {
    window.clearTimeout(saveTimer.current);
    const job = unsavedRef.current;
    if (!job) return;
    unsavedRef.current = null;
    try {
      await writeFile(job.root, job.path, job.text);
      setSaveError(null);
    } catch (e) {
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
      if (unsavedRef.current || live.state.doc.toString() === text) return;
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
          unsavedRef.current = { root, path, text: u.state.doc.toString() };
          window.clearTimeout(saveTimer.current);
          saveTimer.current = window.setTimeout(() => void flushRef.current(), AUTOSAVE_MS);
        }),
        // IntelliJ saves when focus leaves the editor; so does this.
        EditorView.domEventHandlers({ blur: () => void flushRef.current() }),
        vimMode.of(vimMotions(vimRef.current)),
        darkMode.of(darkModeFor(themeRef.current)),
        jumpLine,
        blame.of(gutterFor(hunksRef.current, root, path)),
        ...lang,
      ];

      viewRef.current?.destroy();
      viewRef.current = new EditorView({
        state: EditorState.create({ doc: text, extensions }),
        parent: host,
      });
      viewPathRef.current = path;
      if (autoFocusRef.current) viewRef.current.focus();
      jump();
    })();

    return () => {
      disposed = true;
    };
  }, [contents, path]);

  // The file may already be up (another line in the open file), or not yet, in
  // which case the build above takes the jump when it lands.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => jump(), [target?.token]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: vimMode.reconfigure(vimMotions(vim)) });
  }, [vim]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: editMode.reconfigure(editFor(editable)) });
    if (!editable) void flushRef.current();
  }, [editable]);

  // Switching to another file saves this one first; the next build replaces
  // the view, and its text with it.
  useEffect(() => () => void flushRef.current(), [root, path]);

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
