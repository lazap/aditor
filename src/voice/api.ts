import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { VoiceModel } from "../settings/schema";

/** What `voice_models` reports per model: what is on disk, what is coming. */
export interface ModelInfo {
  id: VoiceModel;
  bytes: number;
  downloaded: boolean;
  /** Bytes so far, while this one is downloading. */
  receiving: number | null;
}

/** `voice://download`, from the thread fetching a model. */
type DownloadEvent =
  | { id: VoiceModel; state: "progress"; received: number; total: number }
  | { id: VoiceModel; state: "done" | "cancelled" }
  | { id: VoiceModel; state: "error"; error: string };

/** How Settings describes each model. The sizes come from `voice.rs`. */
export const MODEL_LABELS: Record<VoiceModel, { name: string; blurb: string }> = {
  "large-v3-turbo-q5_0": {
    name: "Whisper large-v3 turbo",
    blurb: "The most accurate, in any language. About a gigabyte of memory while in use.",
  },
  "small.en-q5_1": {
    name: "Whisper small (English)",
    blurb: "A third of the size, English only. Gets more identifiers wrong.",
  },
};

/** The languages offered for the multilingual model; Whisper knows more. */
export const LANGUAGES: ReadonlyArray<[code: string, name: string]> = [
  ["auto", "Detect automatically"],
  ["en", "English"],
  ["de", "German"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["it", "Italian"],
  ["pt", "Portuguese"],
  ["nl", "Dutch"],
  ["pl", "Polish"],
  ["cs", "Czech"],
  ["sr", "Serbian"],
  ["hr", "Croatian"],
  ["bg", "Bulgarian"],
  ["ru", "Russian"],
  ["uk", "Ukrainian"],
  ["tr", "Turkish"],
  ["ja", "Japanese"],
  ["zh", "Chinese"],
  ["ko", "Korean"],
];

export const voiceModels = () => invoke<ModelInfo[]>("voice_models");
export const voiceDownload = (id: VoiceModel) => invoke<void>("voice_download", { id });
export const voiceDownloadCancel = () => invoke<void>("voice_download_cancel");
export const voiceRemove = (id: VoiceModel) => invoke<void>("voice_remove", { id });

/** Resolves once the microphone is open. */
export const voiceStart = (model: VoiceModel) => invoke<void>("voice_start", { model });

/** Stop listening; resolves to the transcript, empty when nothing was said. */
export const voiceStop = (prompt: string, language: string) =>
  invoke<string>("voice_stop", { prompt, language });

export const voiceCancel = () => invoke<void>("voice_cancel");

/** `574041195` -> `"574 MB"`. Decimal, as download sizes are quoted. */
export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  return `${Math.round(n / 1e6)} MB`;
}

/**
 * The model list, kept current: every window hears `voice://download`, so a
 * download started in Settings shows in any other window that asks.
 */
export function useVoiceModels(onError: (message: string) => void) {
  const [models, setModels] = useState<ModelInfo[]>([]);

  const refresh = useCallback(() => {
    void voiceModels()
      .then(setModels)
      .catch((e) => onError(String(e)));
  }, [onError]);

  useEffect(() => {
    refresh();
    const unlisten = listen<DownloadEvent>("voice://download", ({ payload }) => {
      if (payload.state === "progress") {
        setModels((ms) =>
          ms.map((m) => (m.id === payload.id ? { ...m, receiving: payload.received } : m)),
        );
        return;
      }
      if (payload.state === "error") onError(`The download failed: ${payload.error}`);
      refresh();
    });
    return () => void unlisten.then((u) => u());
  }, [refresh, onError]);

  const download = (id: VoiceModel) => {
    setModels((ms) => ms.map((m) => (m.id === id ? { ...m, receiving: 0 } : m)));
    void voiceDownload(id).catch((e) => {
      onError(String(e));
      refresh();
    });
  };
  const cancel = () => void voiceDownloadCancel().catch(() => {});
  const remove = (id: VoiceModel) =>
    void voiceRemove(id)
      .then(refresh)
      .catch((e) => onError(String(e)));

  return { models, download, cancel, remove };
}
