import { useEffect, useRef, useState } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { gitDiff, type FileDiff } from "../git/api";
import { aditorEditorTheme, aditorHighlighting } from "../editor/theme";
import { loadLanguage } from "../editor/language";

export type DiffLayout = "unified" | "split";

interface Props {
  path: string;
  layout: DiffLayout;
  /** Bumped by the watcher, so the diff follows the agent's edits live. */
  refreshToken: number;
}

function formatBytes(n: number): string {
  return n > 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(n / 1024)} KB`;
}

export function DiffViewer({ path, layout, refreshToken }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<EditorView | MergeView | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    setError(null);
    gitDiff(path)
      .then((d) => !stale && setDiff(d))
      .catch((e) => !stale && setError(String(e)));
    return () => {
      stale = true;
    };
  }, [path, refreshToken]);

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
    })();

    return () => {
      disposed = true;
    };
  }, [diff, layout, path]);

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
