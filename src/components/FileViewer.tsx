import { useEffect, useRef, useState } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { readFile, type FileContents } from "../fs/api";
import { aditorEditorTheme, aditorHighlighting, darkMode, darkModeFor } from "../editor/theme";
import { loadLanguage } from "../editor/language";
import { vimMode, vimMotions } from "../editor/vim";
import { jumpLine, jumpToLine } from "../editor/jumpLine";
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
  path: string;
  /** Bumped by the watcher; reloads when the agent rewrites the file. */
  refreshToken: number;
  /** Take focus once built, so the keyboard lands in the file without a click. */
  autoFocus?: boolean;
  /** Scroll to and mark this line once the file is up. */
  target?: LineTarget | null;
}

function formatBytes(n: number): string {
  return n > 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(n / 1024)} KB`;
}

export function FileViewer({ path, refreshToken, autoFocus, target }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [contents, setContents] = useState<FileContents | null>(null);
  const [error, setError] = useState<string | null>(null);
  const vim = useSetting((s) => s.keyboardMode === "vim");
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
    readFile(path)
      .then((c) => {
        if (stale) return;
        loadedPathRef.current = path;
        setContents(c);
      })
      .catch((e) => !stale && setError(String(e)));
    return () => {
      stale = true;
    };
  }, [path, refreshToken]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || contents?.kind !== "text") return;
    // Still the previous file's text: wait for this one's rather than dress
    // the old text in the new file's language.
    if (loadedPathRef.current !== path) return;

    let disposed = false;
    const text = contents.text;

    (async () => {
      const lang = await loadLanguage(path);
      if (disposed) return;

      const extensions: Extension[] = [
        lineNumbers(),
        aditorEditorTheme,
        aditorHighlighting,
        EditorView.lineWrapping,
        // Read-only for now; writable buffers are bucket 4.
        EditorState.readOnly.of(true),
        vimMode.of(vimMotions(vimRef.current)),
        darkMode.of(darkModeFor(themeRef.current)),
        jumpLine,
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
    viewRef.current?.dispatch({ effects: darkMode.reconfigure(darkModeFor(theme)) });
  }, [theme]);

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
