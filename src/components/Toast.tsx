import { useEffect } from "react";

export interface ToastMessage {
  /** Bumped per message, so a repeat of the same text restarts the timer. */
  id: number;
  text: string;
  tone: "info" | "error";
}

/** Errors are worth reading twice. */
const DWELL = { info: 4000, error: 7000 } as const;

interface Props {
  message: ToastMessage | null;
  onDone(): void;
}

/**
 * A line of feedback for things that happen with nothing on screen to show
 * them -- an account switched by shortcut while the agent panel is closed, or
 * the refusal that stopped it.
 *
 * Deliberately not focusable and not dismissable by key: it must never pull
 * the caret out of the agent, which is where the user was typing.
 */
export function Toast({ message, onDone }: Props) {
  useEffect(() => {
    if (!message) return;
    const id = window.setTimeout(onDone, DWELL[message.tone]);
    return () => window.clearTimeout(id);
  }, [message, onDone]);

  if (!message) return null;

  return (
    <div className="toast" data-tone={message.tone} role="status" aria-live="polite">
      {message.text}
    </div>
  );
}
