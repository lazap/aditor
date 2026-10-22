import type { Extension } from "@codemirror/state";
import { languages } from "@codemirror/language-data";
import { LanguageDescription } from "@codemirror/language";
import type { Parser } from "@lezer/common";

/**
 * Resolve syntax support from a filename, loaded on demand so only the
 * languages actually opened are fetched. Shared by the file and diff views: a
 * diff should highlight like the file it came from.
 */
export async function loadLanguage(path: string): Promise<Extension[]> {
  const name = path.split("/").slice(-1)[0] ?? path;
  const desc = LanguageDescription.matchFilename(languages, name);
  if (!desc) return [];
  try {
    return [(await desc.load()).extension];
  } catch {
    // Highlighting is a nicety; plain text beats a blank pane.
    return [];
  }
}

/**
 * Canonical language name for a filename, or null when nothing matches.
 *
 * Synchronous on purpose: `matchFilename` only inspects the descriptors'
 * extension/filename patterns and never triggers the lazy `load()` above, so
 * this is cheap enough to call once per file tree row. Lets the tree's icon
 * table cover only what it wants to style deliberately and still name the
 * remaining ~140 languages CodeMirror knows about.
 */
export function languageName(filename: string): string | null {
  return LanguageDescription.matchFilename(languages, filename)?.name ?? null;
}

/**
 * The parser for a fenced code block's info string (`ts`, `rust`, ...), loaded
 * on demand like `loadLanguage`. Null when nothing matches or it fails to load:
 * the block then stays plain.
 */
export async function loadParser(name: string): Promise<Parser | null> {
  const desc = LanguageDescription.matchLanguageName(languages, name, true);
  if (!desc) return null;
  try {
    return (await desc.load()).language.parser;
  } catch {
    return null;
  }
}
