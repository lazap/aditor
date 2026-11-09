/**
 * Where a directory is really a package, and how far one folds.
 *
 * In the JVM languages `com.acme.app` is three nested directories, the outer
 * two holding nothing but the next. The tree shows such a chain as one row.
 */
import type { DirEntry } from "./api";

/**
 * `src/main/java`, `src/test/kotlin`, `src/commonMain/kotlin`, in any module.
 * Matched against the path below the project root: a checkout that happens to
 * live under `~/src/work/java` has no source root by that alone.
 */
const SOURCE_ROOT = /\/src\/[^/]+\/(java|kotlin|scala|groovy)$/;

/** `rel` is the directory's path below the project root, with a leading slash. */
export const isSourceRoot = (rel: string): boolean => SOURCE_ROOT.test(rel);

/** Finder drops these anywhere it has looked; they say nothing about a package. */
const isPackageContent = (e: DirEntry): boolean => e.name !== ".DS_Store";

/**
 * The directories that fold into one row, outermost first: `head`, then each
 * lone subdirectory below it. Stops at the first directory holding anything
 * else -- that one is the package with content, and stays the row's last name.
 *
 * `unlisted` is the directory the walk could not see into yet. Folding needs a
 * listing of directories the user never opened, so the caller fetches it, and
 * the chain grows by one level per pass.
 */
export function packageChain(
  head: DirEntry,
  cache: ReadonlyMap<string, DirEntry[]>,
): { chain: DirEntry[]; unlisted: string | null } {
  const chain = [head];
  for (;;) {
    const tail = chain[chain.length - 1];
    const kids = cache.get(tail.path);
    if (kids === undefined) return { chain, unlisted: tail.path };
    const content = kids.filter(isPackageContent);
    if (content.length !== 1 || !content[0].isDir) return { chain, unlisted: null };
    chain.push(content[0]);
  }
}
