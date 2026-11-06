import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { EditorView } from "@codemirror/view";
import { activeSession, ptyPaste } from "../pty/api";
import { gitStatus } from "../git/api";
import { settings } from "../settings/store";
import { basename } from "../window";
import { voiceCancel, voiceStart, voiceStop } from "./api";

export type DictationPhase = "idle" | "listening" | "transcribing";

/** Held at least this long, the shortcut was push-to-talk: letting go ends it. */
const HOLD_MS = 400;

/** Whisper reads only the last couple of hundred tokens of a prompt. */
const PROMPT_CHARS = 600;

/**
 * Where the words go, decided when listening starts: the place the user was
 * looking at when they began talking, not wherever focus wandered since.
 */
type Target =
  | { kind: "editor"; view: EditorView }
  | { kind: "field"; el: HTMLInputElement | HTMLTextAreaElement }
  | { kind: "agent"; session: string | null };

function captureTarget(): Target {
  const el = document.activeElement;
  if (el instanceof HTMLElement && !el.closest(".xterm")) {
    const cm = el.closest<HTMLElement>(".cm-editor");
    const view = cm ? EditorView.findFromDOM(cm) : null;
    if (view && !view.state.readOnly) return { kind: "editor", view };
    const field =
      el instanceof HTMLTextAreaElement ||
      (el instanceof HTMLInputElement && /^(text|search)$/.test(el.type));
    if (field && !el.readOnly && !el.disabled) return { kind: "field", el };
  }
  return { kind: "agent", session: activeSession() };
}

/** A space between this and what is already before the caret, if needed. */
const spaced = (before: string, text: string) =>
  before && !/\s$/.test(before) ? ` ${text}` : text;

/**
 * Words Whisper would otherwise spell like English: the project's name, its
 * branch, and the files being worked on. Best effort -- not every project is
 * a repository.
 */
async function vocabulary(root: string | null): Promise<string> {
  if (!root) return "";
  const words = [basename(root)];
  try {
    const status = await gitStatus(root);
    if (status.branch) words.push(status.branch);
    for (const f of status.files) words.push(basename(f.path));
  } catch {
    /* not a repository */
  }
  const unique = [...new Set(words)];
  let out = "";
  for (const w of unique) {
    if (out.length + w.length + 2 > PROMPT_CHARS) break;
    out = out ? `${out}, ${w}` : w;
  }
  return out;
}

interface Options {
  /** The project on screen, for its vocabulary. */
  root(): string | null;
  /** Put the caret back in the agent, once the words are there. */
  focusAgent(): void;
  onError(message: string): void;
}

/**
 * Dictation for one editor window.
 *
 * `press` is the Dictate shortcut. A tap starts listening and the next one
 * stops; held past `HOLD_MS` it is push-to-talk, and letting go stops. Esc
 * throws the recording away. Stopping transcribes on the backend and types the
 * text where the user was: an editable file, a text field, or the agent.
 */
export function useDictation({ root, focusAgent, onError }: Options) {
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [level, setLevel] = useState(0);
  const phaseRef = useRef<DictationPhase>("idle");
  const starting = useRef<Promise<boolean> | null>(null);
  const target = useRef<Target>({ kind: "agent", session: null });
  const words = useRef<Promise<string>>(Promise.resolve(""));
  const opts = useRef({ root, focusAgent, onError });
  opts.current = { root, focusAgent, onError };

  const go = (next: DictationPhase) => {
    phaseRef.current = next;
    setPhase(next);
    if (next !== "listening") setLevel(0);
  };

  const insert = useCallback(async (text: string) => {
    const t = target.current;
    if (t.kind === "editor" && t.view.dom.isConnected) {
      const { state } = t.view;
      const at = state.selection.main.from;
      t.view.dispatch(state.replaceSelection(spaced(state.sliceDoc(Math.max(0, at - 1), at), text)));
      t.view.focus();
      return;
    }
    if (t.kind === "field" && t.el.isConnected) {
      t.el.focus();
      const at = t.el.selectionStart ?? t.el.value.length;
      // execCommand rather than assigning `value`: it is what React's onChange
      // hears, and it lands on the field's undo stack.
      document.execCommand("insertText", false, spaced(t.el.value.slice(0, at), text));
      return;
    }
    const session = (t.kind === "agent" && t.session) || activeSession();
    if (!session) {
      opts.current.onError("No agent is running to dictate to.");
      return;
    }
    // A trailing space, so the next dictation does not run into this one.
    await ptyPaste(session, `${text} `);
    opts.current.focusAgent();
  }, []);

  const start = useCallback(() => {
    target.current = captureTarget();
    words.current = vocabulary(opts.current.root());
    go("listening");
    const { model } = settings().voice;
    starting.current = voiceStart(model)
      .then(() => true)
      .catch((e) => {
        go("idle");
        opts.current.onError(String(e));
        return false;
      });
  }, []);

  const finish = useCallback(async () => {
    if (phaseRef.current !== "listening") return;
    go("transcribing");
    if (!(await starting.current)) return;
    try {
      const text = await voiceStop(await words.current, settings().voice.language);
      if (text) await insert(text);
    } catch (e) {
      opts.current.onError(String(e));
    } finally {
      go("idle");
    }
  }, [insert]);

  const cancel = useCallback(async () => {
    if (phaseRef.current !== "listening") return;
    go("idle");
    if (await starting.current) await voiceCancel().catch(() => {});
  }, []);

  /**
   * The shortcut went down. With the event, letting go of it after `HOLD_MS`
   * stops too. macOS sends no keyup for a letter released while ⌘ is still
   * down, so releasing any key of the chord counts.
   */
  const press = useCallback(
    (e?: KeyboardEvent) => {
      if (e?.repeat) return;
      if (phaseRef.current === "listening") return void finish();
      if (phaseRef.current === "transcribing") return;
      start();
      if (!e) return;
      const down = performance.now();
      const keys = new Set([e.code]);
      if (e.metaKey) keys.add("MetaLeft").add("MetaRight");
      if (e.ctrlKey) keys.add("ControlLeft").add("ControlRight");
      if (e.shiftKey) keys.add("ShiftLeft").add("ShiftRight");
      if (e.altKey) keys.add("AltLeft").add("AltRight");
      const release = () => {
        window.removeEventListener("keyup", onUp, true);
        window.removeEventListener("blur", release);
        if (performance.now() - down >= HOLD_MS) void finish();
      };
      const onUp = (u: KeyboardEvent) => {
        if (keys.has(u.code)) release();
      };
      window.addEventListener("keyup", onUp, true);
      window.addEventListener("blur", release);
    },
    [start, finish],
  );

  // Esc while listening is ours: in the capture phase, before the terminal
  // sees it -- to Claude Code an Escape interrupts the agent.
  useEffect(() => {
    if (phase !== "listening") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      void cancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [phase, cancel]);

  // The meter, sent to this window only while it is the one recording.
  useEffect(() => {
    const unlisten = getCurrentWindow().listen<number>("voice://level", ({ payload }) => {
      if (phaseRef.current === "listening") setLevel(payload);
    });
    return () => void unlisten.then((u) => u());
  }, []);

  // A window closed mid-sentence must not leave the microphone open.
  useEffect(
    () => () => {
      if (phaseRef.current === "listening") void voiceCancel().catch(() => {});
    },
    [],
  );

  return { phase, level, press, finish, cancel };
}
