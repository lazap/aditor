import { useEffect, useRef, useState } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { gitCommitFileDiff, gitDiff, type FileDiff } from "../git/api";
import { aditorEditorTheme, aditorHighlighting, darkMode, darkModeFor } from "../editor/theme";
import { loadLanguage } from "../editor/language";
import { vimMode, vimMotions } from "../editor/vim";
import { useSetting } from "../settings/store";
import { useTheme } from "../theme";

export type DiffLayout = "unified" | "split";

interface Props {
  /** Workspace the file belongs to; every read is checked against it. */
  root: string;
  path: string;
  layout: DiffLayout;
  /** Bumped by the watcher, so the diff follows the agent's edits live. */
  refreshToken: number;
  /** Take focus once built, so vim motions work without a click first. */
  autoFocus?: boolean;
  /** Bumped to put the keyboard in the diff, once it is built. */
  focusToken?: number;
  /**
   * Show what this commit did to the file (its first parent against it)
   * instead of HEAD against the working tree.
   */
  commit?: { id: string; oldPath: string | null };
}

function formatBytes(n: number): string {
  return n > 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(n / 1024)} KB`;
}

/** The editors behind an instance, new side first. */
function editorsOf(instance: EditorView | MergeView | null): EditorView[] {
  if (!instance) return [];
  return instance instanceof MergeView ? [instance.b, instance.a] : [instance];
}

export function DiffViewer({
  root,
  path,
  layout,
  refreshToken,
  autoFocus,
  focusToken,
  commit,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<EditorView | MergeView | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
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
  // Each token is applied once, to the diff of the path it arrived with: a
  // watcher refresh rebuilds the view, and should not take focus back.
  const pathRef = useRef(path);
  pathRef.current = path;
  const builtPathRef = useRef<string | null>(null);
  const focusTokenRef = useRef(focusToken);
  focusTokenRef.current = focusToken;
  const focusedRef = useRef<number | undefined>(undefined);
  const takeFocus = () => {
    const view = editorsOf(instanceRef.current)[0];
    const t = focusTokenRef.current;
    if (!view || !t || t === focusedRef.current) return;
    if (builtPathRef.current !== pathRef.current) return;
    focusedRef.current = t;
    view.focus();
  };

  // By value, so a new `commit` object with the same fields does not refetch.
  const commitId = commit?.id;
  const oldPath = commit?.oldPath ?? null;
  useEffect(() => {
    let stale = false;
    setError(null);
    const load = commitId
      ? gitCommitFileDiff(root, commitId, { path, oldPath })
      : gitDiff(root, path);
    load
      .then((d) => !stale && setDiff(d))
      .catch((e) => !stale && setError(String(e)));
    return () => {
      stale = true;
    };
  }, [root, path, refreshToken, commitId, oldPath]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || diff?.kind !== "text") return;

    let disposed = false;
    const { old: oldText, new: newText } = diff;

    (async () => {
      const lang = await loadLanguage(path);
      if (disposed) return;

      const base: Extension[] = [
        lineNumbers(),
        aditorEditorTheme,
        aditorHighlighting,
        EditorState.readOnly.of(true),
        vimMode.of(vimMotions(vimRef.current)),
        darkMode.of(darkModeFor(themeRef.current)),
        ...lang,
      ];

      instanceRef.current?.destroy();
      host.replaceChildren();

      if (layout === "unified") {
        // Doc is the new text; the original is supplied to the extension.
        // mergeControls off -- this is an observation view, not a merge tool.
        instanceRef.current = new EditorView({
          state: EditorState.create({
            doc: newText,
            extensions: [
              ...base,
              EditorView.lineWrapping,
              unifiedMergeView({ original: oldText, mergeControls: false }),
            ],
          }),
          parent: host,
        });
      } else {
        instanceRef.current = new MergeView({
          a: { doc: oldText, extensions: base },
          b: { doc: newText, extensions: base },
          parent: host,
          // Long unchanged stretches would otherwise bury a two-line change.
          collapseUnchanged: { margin: 3, minSize: 6 },
        });
      }

      builtPathRef.current = path;
      if (autoFocusRef.current) editorsOf(instanceRef.current)[0]?.focus();
      takeFocus();
    })();

    return () => {
      disposed = true;
    };
  }, [diff, layout, path]);

  useEffect(() => takeFocus(), [focusToken]);

  useEffect(() => {
    const effects = vimMode.reconfigure(vimMotions(vim));
    for (const view of editorsOf(instanceRef.current)) view.dispatch({ effects });
  }, [vim]);

  useEffect(() => {
    const effects = darkMode.reconfigure(darkModeFor(theme));
    for (const view of editorsOf(instanceRef.current)) view.dispatch({ effects });
  }, [theme]);

  useEffect(
    () => () => {
      instanceRef.current?.destroy();
      instanceRef.current = null;
    },
    [],
  );

  return (
    <>
      {error && <div className="viewer-message error">{error}</div>}
      {diff?.kind === "binary" && (
        <div className="viewer-message">Binary file — no text diff</div>
      )}
      {diff?.kind === "tooLarge" && (
        <div className="viewer-message">
          {formatBytes(diff.bytes)} — too large to diff
        </div>
      )}
      {diff?.kind === "notRepo" && (
        <div className="viewer-message">Not a git repository</div>
      )}
      <div
        className="viewer-host"
        ref={hostRef}
        hidden={diff?.kind !== "text"}
      />
    </>
  );
}
