import { useSyncExternalStore } from "react";
import { patch, settings } from "../settings/store";
import { COMMANDS, commandById, type CommandId } from "./registry";
import { eventChord, formatChord, isSystemReserved } from "./keys";

/**
 * The live keymap: defaults from the registry, with the user's rebindings on
 * top.
 *
 * A module store rather than context or props, because TerminalPane has to ask
 * "is this chord mine?" from inside an xterm key handler. Going through React
 * would mean re-rendering the pane to change a binding, and everything that
 * re-enters that component is one step closer to the effect that kills and
 * respawns the agent's PTY. Here it is a plain function call at key time.
 */

/** id -> chord, or null for a binding the user cleared. */
type Overrides = Partial<Record<CommandId, string | null>>;

let overrides: Overrides = {};
let bindings = buildBindings();
let byChord = buildByChord();

const listeners = new Set<() => void>();

/**
 * Take the rebindings from the settings document.
 *
 * Called once from `main.tsx`, after the document is loaded and before React
 * mounts. It cannot be done at module scope: imports are evaluated before
 * anything gets to await the disk read, so this module would adopt the
 * defaults and never hear about the file.
 */
export function adopt(): void {
  overrides = sane(settings().shortcuts);
  bindings = buildBindings();
  byChord = buildByChord();
  for (const fn of listeners) fn();
}

/** Drop anything that is not a command we still ship. */
function sane(raw: Overrides): Overrides {
  const out: Overrides = {};
  for (const c of COMMANDS) {
    if (!(c.id in raw)) continue;
    const v = raw[c.id];
    if (v === null || typeof v === "string") out[c.id] = v;
  }
  return out;
}

function buildBindings(): ReadonlyMap<CommandId, string | null> {
  return new Map(
    COMMANDS.map((c) => [c.id, c.id in overrides ? overrides[c.id]! : c.chord]),
  );
}

function buildByChord(): ReadonlyMap<string, CommandId> {
  const m = new Map<string, CommandId>();
  for (const [id, chord] of bindings) if (chord) m.set(chord, id);
  return m;
}

function commit(): void {
  bindings = buildBindings();
  byChord = buildByChord();
  patch({ shortcuts: overrides });
  for (const fn of listeners) fn();
}

/** chord -> command. The dispatch table. */
export const keymap = (): ReadonlyMap<string, CommandId> => byChord;

/** id -> chord, or null when unbound. The display table. */
export const allBindings = (): ReadonlyMap<CommandId, string | null> => bindings;

export const chordFor = (id: CommandId): string | null => bindings.get(id) ?? null;

export const isOverridden = (id: CommandId): boolean => id in overrides;

/**
 * Bind `chord` to `id`. A chord can only mean one thing, so whatever held it
 * is unbound; the displaced command is returned so the caller can say so.
 */
export function setBinding(id: CommandId, chord: string): CommandId | null {
  const taken = byChord.get(chord);
  const displaced = taken && taken !== id ? taken : null;
  if (displaced) overrides[displaced] = null;

  const fallback = COMMANDS.find((c) => c.id === id)!.chord;
  if (chord === fallback) delete overrides[id];
  else overrides[id] = chord;

  commit();
  return displaced;
}

export function clearBinding(id: CommandId): void {
  // Clearing a command that ships unbound is a return to its default, not an
  // override of it.
  if (commandById(id).chord === null) delete overrides[id];
  else overrides[id] = null;
  commit();
}

export function resetAll(): void {
  overrides = {};
  bindings = buildBindings();
  byChord = buildByChord();
  patch({ shortcuts: overrides });
  for (const fn of listeners) fn();
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Re-renders on every rebinding. For the shortcuts panel. */
export const useBindings = (): ReadonlyMap<CommandId, string | null> =>
  useSyncExternalStore(subscribe, allBindings, allBindings);

/**
 * Keys Aditor keeps for itself; everything else goes to the agent.
 *
 * TerminalPane's gate. Registered shortcuts are covered automatically, which
 * is the point of routing both through the registry -- a rebinding takes
 * effect in the terminal with nothing to keep in step.
 */
export function isReservedForApp(e: KeyboardEvent): boolean {
  if (isSystemReserved(e)) return true;
  const chord = eventChord(e);
  return chord !== null && byChord.has(chord);
}

/** A tooltip that names the chord, and stays honest once it is rebound. */
export function chordHint(text: string, id: CommandId): string {
  const chord = chordFor(id);
  return chord ? `${text} (${formatChord(chord)})` : text;
}
