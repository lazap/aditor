/**
 * Chords, as one canonical string.
 *
 * `"mod+shift+a"`, `"mod+1"`. On macOS `mod` is Cmd only: Ctrl chords belong
 * to the agent (Ctrl-E, Ctrl-O, Ctrl-W... are Claude Code's), so a Ctrl press
 * there stringifies as `ctrl+…` and never matches a binding. Elsewhere `mod`
 * is Ctrl (or Meta), there being nothing else to bind to.
 *
 * The key half comes from `e.code`, not `e.key`: under Shift, `e.key` for the
 * A row becomes something else entirely on several layouts, which would make
 * `mod+shift+a` unbindable for those users.
 */

const isMac = navigator.userAgent.includes("Mac");

/** Whether the app's modifier is down. See the header for why macOS differs. */
const modDown = (e: KeyboardEvent): boolean =>
  isMac ? e.metaKey : e.metaKey || e.ctrlKey;

/** `e.code` -> the token we store. Anything not here falls through lowercased. */
const CODES: Record<string, string> = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Minus: "-",
  Equal: "=",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  BracketLeft: "[",
  BracketRight: "]",
  Space: "space",
};

/** Codes that are only ever a modifier -- never a chord on their own. */
const BARE = /^(Shift|Control|Alt|Meta)(Left|Right)$|^CapsLock$/;

/**
 * The chord this event represents, or null while only modifiers are held.
 */
export function eventChord(e: KeyboardEvent): string | null {
  if (BARE.test(e.code)) return null;

  let key: string;
  const letter = /^Key([A-Z])$/.exec(e.code);
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(e.code);
  if (letter) key = letter[1].toLowerCase();
  else if (digit) key = digit[1];
  else key = CODES[e.code] ?? e.code.toLowerCase();

  // Fixed order, so the same chord always stringifies the same way.
  const parts: string[] = [];
  if (modDown(e)) parts.push("mod");
  if (isMac && e.ctrlKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  parts.push(key);
  return parts.join("+");
}

/** True for a chord no modifier guards -- those would break typing. */
export function isBare(chord: string): boolean {
  return !chord.startsWith("mod+") && !chord.startsWith("alt+");
}

const GLYPHS: Record<string, string> = {
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  escape: "Esc",
  enter: "↩",
  space: "Space",
  backspace: "⌫",
  delete: "⌦",
  tab: "⇥",
};

/** `"mod+shift+a"` -> `⌘⇧A` on macOS, `Ctrl+Shift+A` elsewhere. */
export function formatChord(chord: string): string {
  const parts = chord.split("+");
  const key = parts.pop() ?? "";
  const label = GLYPHS[key] ?? (key.length === 1 ? key.toUpperCase() : key.toUpperCase());
  if (isMac) {
    let out = "";
    if (parts.includes("mod")) out += "⌘";
    if (parts.includes("alt")) out += "⌥";
    if (parts.includes("shift")) out += "⇧";
    return out + label;
  }
  const mods = parts.map((p) => (p === "mod" ? "Ctrl" : p === "alt" ? "Alt" : "Shift"));
  return [...mods, label].join("+");
}

/**
 * Chords the webview or the OS owns, which the terminal must not forward to
 * the agent but the app does not handle either.
 *
 * Ported as-is from TerminalPane's old `isReservedForApp`, `e.key` checks
 * included: `e.key === "+"` has no tidy `e.code` equivalent, and zoom working
 * is worth more than the symmetry.
 */
export function isSystemReserved(e: KeyboardEvent): boolean {
  const mod = modDown(e);
  if (mod && (e.key === "q" || e.key === "m")) return true; // window mgmt
  if (mod && e.shiftKey && e.key.toLowerCase() === "w") return true; // close window (menu)
  if (mod && e.shiftKey && e.key.toLowerCase() === "r") return true; // reload (dev)
  if (mod && (e.key === "+" || e.key === "-" || e.key === "0")) return true; // zoom
  return false;
}
