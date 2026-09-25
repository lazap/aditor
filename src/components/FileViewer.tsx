import { useEffect, useRef, useState } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { readFile, type FileContents } from "../fs/api";
import { aditorEditorTheme, aditorHighlighting } from "../editor/theme";
import { loadLanguage } from "../editor/language";

interface Props {
  path: string;
  /** Bumped by the watcher; reloads when the agent rewrites the file. */
  refreshToken: number;
}

function formatBytes(n: number): string {
  return n > 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(n / 1024)} KB`;
}

export function FileViewer({ path, refreshToken }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [contents, setContents] = useState<FileContents | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    setError(null);
    readFile(path)
      .then((c) => !stale && setContents(c))
      .catch((e) => !stale && setError(String(e)));
    return () => {
      stale = true;
    };
  }, [path, refreshToken]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || contents?.kind !== "text") return;

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
        ...lang,
      ];

      viewRef.current?.destroy();
      viewRef.current = new EditorView({
        state: EditorState.create({ doc: text, extensions }),
        parent: host,
      });
    })();

    return () => {
      disposed = true;
    };
  }, [contents, path]);

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
