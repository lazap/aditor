import type { Extension } from "@codemirror/state";
import { languages } from "@codemirror/language-data";
import { LanguageDescription } from "@codemirror/language";

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
