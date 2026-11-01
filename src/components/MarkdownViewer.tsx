import { useEffect, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { highlightCode } from "@lezer/highlight";
import { StyleModule } from "style-mod";
import { openUrl } from "@tauri-apps/plugin-opener";
import { readFile, type FileContents } from "../fs/api";
import { loadParser } from "../editor/language";
import { highlight } from "../editor/theme";
import { formatBytes } from "./FileViewer";

interface Props {
  /** Workspace the file belongs to; every read is checked against it. */
  root: string;
  path: string;
  /** Bumped by the watcher; re-renders when the agent rewrites the file. */
  refreshToken: number;
  /** Bumped to put the keyboard in the page, once it is rendered. */
  focusToken?: number;
}

// The highlight style's classes only exist once something mounts its rules;
// an editor does that for itself, the preview has to ask.
if (highlight.module) StyleModule.mount(document, highlight.module);

/**
 * Markdown to HTML that is safe to put in this window. The CSP is off and the
 * page can reach the backend, so a README's raw `<script>` or `onerror` must
 * never run: everything goes through DOMPurify.
 */
const render = (text: string): string =>
  DOMPurify.sanitize(marked.parse(text, { gfm: true, async: false }));

const slug = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");

/** GitHub-style heading ids, so `#section` links land. */
function addHeadingIds(host: HTMLElement) {
  const seen = new Map<string, number>();
  for (const h of host.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")) {
    const base = slug(h.textContent ?? "");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    h.id = n ? `${base}-${n}` : base;
  }
}

/** Colour fenced blocks with the editor's own highlighting, as it loads. */
function highlightBlocks(host: HTMLElement, isStale: () => boolean) {
  for (const code of host.querySelectorAll<HTMLElement>("pre > code[class*='language-']")) {
    const lang = /language-(\S+)/.exec(code.className)?.[1];
    if (!lang) continue;
    void loadParser(lang).then((parser) => {
      if (!parser || isStale()) return;
      const text = code.textContent ?? "";
      const out = document.createDocumentFragment();
      highlightCode(
        text,
        parser.parse(text),
        highlight,
        (chunk, classes) => {
          if (!classes) return void out.append(chunk);
          const span = document.createElement("span");
          span.className = classes;
          span.textContent = chunk;
          out.append(span);
        },
        () => out.append("\n"),
      );
      code.replaceChildren(out);
    });
  }
}

/** A markdown file, rendered. Read-only: editing happens in the File view. */
export function MarkdownViewer({ root, path, refreshToken, focusToken }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [contents, setContents] = useState<FileContents | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pathRef = useRef(path);
  pathRef.current = path;
  /** Which path `contents` was read for; it lags `path` while a read is out. */
  const loadedPathRef = useRef<string | null>(null);

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

  // The host stays mounted across refreshes and only its HTML is swapped, so
  // an agent rewriting the file does not throw the reader back to the top.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || contents?.kind !== "text") return;
    let stale = false;
    host.innerHTML = render(contents.text);
    addHeadingIds(host);
    highlightBlocks(host, () => stale);
    takeFocus();
    return () => {
      stale = true;
    };
  }, [contents]);

  // Same once-per-token arrangement as the file view; the page has no caret,
  // so focus is what keeps ⌘A to it.
  const focusTokenRef = useRef(focusToken);
  focusTokenRef.current = focusToken;
  const focusedRef = useRef<number | undefined>(undefined);
  const takeFocus = () => {
    const host = hostRef.current;
    const t = focusTokenRef.current;
    if (!host || host.hidden || !t || t === focusedRef.current) return;
    if (loadedPathRef.current !== pathRef.current) return;
    focusedRef.current = t;
    host.focus({ preventScroll: true });
  };
  useEffect(() => takeFocus(), [focusToken]);

  // A new file starts at its top.
  useEffect(() => {
    if (hostRef.current) hostRef.current.scrollTop = 0;
  }, [path]);

  /** Links never navigate this window: out to the browser, or within the page. */
  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#")) {
      const id = decodeURIComponent(href.slice(1));
      hostRef.current?.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView();
    } else if (/^(https?|mailto):/i.test(href)) {
      void openUrl(href);
    }
  };

  /** Select all is the page's text, not the whole window's. */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "a") return;
    const host = hostRef.current;
    if (!host) return;
    e.preventDefault();
    window.getSelection()?.selectAllChildren(host);
  };

  return (
    <>
      {error && <div className="viewer-message error">{error}</div>}
      {contents?.kind === "tooLarge" && (
        <div className="viewer-message">
          {formatBytes(contents.bytes)} — too large to display
        </div>
      )}
      {contents?.kind === "binary" && <div className="viewer-message">Binary file</div>}
      <div
        className="viewer-host markdown-body"
        ref={hostRef}
        tabIndex={-1}
        onClick={onClick}
        onKeyDown={onKeyDown}
        hidden={contents?.kind !== "text"}
      />
    </>
  );
}
