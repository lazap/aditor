/**
 * Edits waiting on their autosave, so a window can flush them before it goes.
 *
 * Saving is debounced like IntelliJ's: a short pause after typing, or at once
 * on blur, on switching file and on close. The last of those is the one a
 * component cannot manage alone -- closing a window destroys the page without
 * running effect cleanups -- so each editor registers its flush here and
 * main.tsx awaits them all in the close handler, as it does for settings.
 */
const pending = new Set<() => Promise<void>>();

/** Register a flush; returns the unregister. */
export function trackEdits(flush: () => Promise<void>): () => void {
  pending.add(flush);
  return () => pending.delete(flush);
}

/** Write every unsaved edit in this window. Never rejects. */
export async function flushEdits(): Promise<void> {
  await Promise.allSettled([...pending].map((f) => f()));
}

/** Pause after the last keystroke before the file is written. */
export const AUTOSAVE_MS = 400;
