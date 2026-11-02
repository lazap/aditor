import { createElement, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { DialogResult, DialogSpec } from "../components/Modal";

/** `askpass://prompt`: one of ssh's or git's questions. */
interface Prompt {
  id: number;
  prompt: string;
  /** Typed hidden: a passphrase or password, not a host key's "yes". */
  secret: boolean;
}

/** The user's answer to prompt `id`, or null when they cancelled. */
const askpassAnswer = (id: number, answer: string | null) =>
  invoke<void>("askpass_answer", { id, answer });

/**
 * ssh's and git's prompts, put up in this window: a key's passphrase, an
 * unknown host's key, an HTTPS password. The backend sends each one to a
 * single editor window and holds git until the answer comes back; see
 * `askpass.rs`. Off macOS only -- there ssh asks through its own dialog.
 *
 * Scoped to this window, like the template picker's insert: a global listener
 * would hear every window's prompts.
 */
export function useAskpass(ask: (spec: DialogSpec) => Promise<DialogResult | null>): void {
  useEffect(() => {
    const unlisten = getCurrentWindow().listen<Prompt>("askpass://prompt", ({ payload }) => {
      void ask({
        title: "git",
        // A host key question runs to several lines; keep them.
        body: createElement("span", { className: "modal-text-pre" }, payload.prompt),
        input: { label: "Answer", secret: payload.secret },
        confirm: "OK",
      })
        .then((r) => askpassAnswer(payload.id, r ? r.text : null))
        .catch(() => {});
    });
    return () => void unlisten.then((u) => u());
  }, [ask]);
}
