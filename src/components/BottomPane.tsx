import { useEffect, useRef, useState } from "react";
import { FileViewer, type LineTarget } from "./FileViewer";
import { MarkdownViewer } from "./MarkdownViewer";
import { DiffViewer, type DiffLayout } from "./DiffViewer";
import { BADGE, type ChangeKind } from "../git/api";
import { patchLayout, useSetting } from "../settings/store";
import { chordHint } from "../shortcuts/store";
import { basename, isMarkdown, openViewerWindow, type ViewerMode as Mode } from "../window";
import { setWritable, useWritable } from "../projects";
import { readFile } from "../fs/api";

interface Props {
  /** Workspace the file belongs to; every read is checked against it. */
  root: string;
  path: string;
  /** git status for this path, or null when unchanged / not a repo. */
  status: ChangeKind | null;
  refreshToken: number;
  /** Diffs open in their own window: this pane only ever shows the file. */
  diffInWindow: boolean;
  /** From the tree it opens as the file; from the git list, as the diff. */
  openedAs: Mode;
  /** A line to show, from a `path:line` clicked in the terminal. */
  target: LineTarget | null;
  /** Bumped by the annotate command: toggles the blame gutter. */
  annotateRequest: number;
  /** Bumped when the file is picked: the keyboard goes to its text. */
  focusToken?: number;
  isRepo: boolean;
  onClose(): void;
}

/**
 * Read-only or editable, for one file -- the viewer bar's lock. Unlocked files
 * save themselves as you type, and stay unlocked until locked again. Shared
 * with the file window, and read from settings so both agree.
 */
export function EditToggle({
  root,
  path,
  disabled,
}: {
  root: string;
  path: string;
  disabled?: boolean;
}) {
  const on = useWritable(root, path);
  return (
    <button
      className="viewer-badge viewer-lock"
      data-on={on}
      disabled={disabled}
      onClick={() => setWritable(root, path, !on)}
      title={
        on
          ? "Editable: changes save automatically. Click to make it read-only again."
          : "Read-only: the agent edits this file. Click to edit it yourself."
      }
    >
      {on ? "editing" : "read-only"}
    </button>
  );
}

/**
 * Puts the whole file on the clipboard, read fresh from disk so it is the
 * file's text whichever view -- diff, preview, source -- is up. Shared with
 * the file window.
 */
export function CopyFileButton({ root, path }: { root: string; path: string }) {
  const [note, setNote] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const flash = (text: string) => {
    setNote(text);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setNote(null), 1500);
  };

  const copy = async () => {
    try {
      const c = await readFile(root, path);
      if (c.kind === "binary") return flash("Binary");
      if (c.kind === "tooLarge") return flash("Too large");
      await navigator.clipboard.writeText(c.text);
      flash("Copied");
    } catch {
      flash("Failed");
    }
  };

  return (
    <button
      className="seg-btn viewer-toggle viewer-copy"
      onClick={() => void copy()}
      title="Copy the whole file to the clipboard"
    >
      {note ?? "Copy"}
    </button>
  );
}

/**
 * Rendered / source, for a markdown file -- the third button of the Diff/File
 * pair. Nothing for any other file.
 */
export function PreviewButton({
  path,
  mode,
  onPick,
}: {
  path: string;
  mode: Mode;
  onPick(): void;
}) {
  if (!isMarkdown(path)) return null;
  return (
    <button
      className="seg-btn"
      data-active={mode === "preview"}
      onClick={onPick}
      title="Show the markdown rendered"
    >
      Preview
    </button>
  );
}

/**
 * Markdown opens rendered, unless it is unlocked for editing: then the source
 * is what the user came for.
 */
export const fileModeFor = (path: string, editable: boolean): Mode =>
  isMarkdown(path) && !editable ? "preview" : "file";

/** The blame toggle in a viewer bar, shared with the diff window. */
export function AnnotateToggle({
  on,
  disabled,
  onToggle,
}: {
  on: boolean;
  disabled?: boolean;
  onToggle(): void;
}) {
  return (
    <button
      className="seg-btn viewer-toggle"
      data-active={on}
      disabled={disabled}
      onClick={onToggle}
      title={chordHint(on ? "Hide git blame" : "Annotate with git blame", "git.annotate")}
    >
      Annotate
    </button>
  );
}

/**
 * Unified / Split. Read straight from settings rather than mirrored into state,
 * so the General tab, this pane and the diff window cannot disagree.
 */
export function DiffLayoutToggle() {
  const layout = useSetting((s) => s.layout.diffLayout);
  const choose = (next: DiffLayout) => patchLayout({ diffLayout: next });

  return (
    <div className="seg">
      <button
        className="seg-btn"
        data-active={layout === "unified"}
        onClick={() => choose("unified")}
        title="Unified diff"
      >
        Unified
      </button>
      <button
        className="seg-btn"
        data-active={layout === "split"}
        onClick={() => choose("split")}
        title="Side-by-side diff"
      >
        Split
      </button>
    </div>
  );
}

export function BottomPane({
  root,
  path,
  status,
  refreshToken,
  diffInWindow,
  openedAs,
  target,
  annotateRequest,
  focusToken,
  isRepo,
  onClose,
}: Props) {
  const [annotate, setAnnotate] = useState(false);
  const [annotateError, setAnnotateError] = useState<string | null>(null);
  const editable = useWritable(root, path);
  const pick = (): Mode =>
    openedAs === "diff" && status && !diffInWindow ? "diff" : fileModeFor(path, editable);
  const [mode, setMode] = useState<Mode>(pick);
  const layout = useSetting((s) => s.layout.diffLayout);

  // Re-pick the default when a different file is opened, but not on every
  // watcher refresh -- an explicit choice should survive the agent's edits.
  useEffect(() => {
    setMode(pick());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, openedAs, diffInWindow]);

  // The command shows the file and toggles the gutter on it.
  const lastAnnotate = useRef(annotateRequest);
  useEffect(() => {
    if (annotateRequest === lastAnnotate.current) return;
    lastAnnotate.current = annotateRequest;
    setMode("file");
    setAnnotate((a) => !a);
  }, [annotateRequest]);

  useEffect(() => setAnnotateError(null), [annotate, path]);

  // Unlocking is asking to edit, and only the source can be typed into.
  useEffect(() => {
    if (editable) setMode((m) => (m === "preview" ? "file" : m));
  }, [editable]);

  // A line only means something in the file: show it even if the diff was up.
  useEffect(() => {
    if (target) setMode("file");
  }, [target]);

  return (
    <div className="viewer">
      <div className="viewer-bar">
        <span className="viewer-path" title={path}>
          {basename(path)}
        </span>
        {status && (
          <span className="viewer-status" data-status={status}>
            {BADGE[status]}
          </span>
        )}

        <div className="seg">
          <button
            className="seg-btn"
            data-active={mode === "diff"}
            disabled={!status}
            onClick={() => (diffInWindow ? void openViewerWindow(root, path, "diff") : setMode("diff"))}
            title={
              !status
                ? "No changes to diff"
                : diffInWindow
                  ? "Open the diff against HEAD in its own window"
                  : "Show diff against HEAD"
            }
          >
            Diff
          </button>
          <button
            className="seg-btn"
            data-active={mode === "file"}
            onClick={() => setMode("file")}
          >
            File
          </button>
          <PreviewButton path={path} mode={mode} onPick={() => setMode("preview")} />
        </div>

        {mode === "diff" && status && <DiffLayoutToggle />}
        {mode === "file" && isRepo && (
          <AnnotateToggle on={annotate} onToggle={() => setAnnotate((a) => !a)} />
        )}
        {annotate && annotateError && (
          <span className="viewer-message error viewer-inline">{annotateError}</span>
        )}

        <CopyFileButton root={root} path={path} />
        <EditToggle root={root} path={path} disabled={mode === "diff"} />
        <button className="viewer-close" onClick={onClose} title="Close file">
          ✕
        </button>
      </div>

      {mode === "diff" && status ? (
        <DiffViewer
          root={root}
          path={path}
          layout={layout}
          refreshToken={refreshToken}
          focusToken={focusToken}
        />
      ) : mode === "preview" ? (
        <MarkdownViewer
          root={root}
          path={path}
          refreshToken={refreshToken}
          focusToken={focusToken}
        />
      ) : (
        <FileViewer
          root={root}
          path={path}
          refreshToken={refreshToken}
          target={target}
          focusToken={focusToken}
          annotate={annotate && isRepo}
          onAnnotateError={setAnnotateError}
          editable={editable}
        />
      )}
    </div>
  );
}
