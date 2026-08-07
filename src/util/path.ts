/**
 * Container-path helpers. Paths inside an EPUB are always POSIX-style and
 * relative to the container root, so these stay dependency-free rather than
 * delegating to Node's `path`, which the browser build cannot import.
 */

export function dirname(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.substring(0, slash);
}

export function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.substring(slash + 1);
}

/**
 * Resolve `relativePath` against the directory holding `fromFilePath`.
 *
 * The base is a *file* path, not a directory — `resolvePath('EPUB/a.opf', 'b.png')`
 * is `EPUB/b.png`. Compare `resolveManifestHref(opfDir, href)`, which takes a
 * directory; the two are easy to confuse.
 *
 * A leading slash is container-absolute, matching how readers resolve such
 * references against the container root.
 */
export function resolvePath(fromFilePath: string, relativePath: string): string {
  if (relativePath.startsWith('/')) {
    return relativePath.slice(1);
  }

  const baseDir = dirname(fromFilePath);
  const parts = baseDir ? baseDir.split('/') : [];

  for (const part of relativePath.split('/')) {
    if (part === '..') {
      parts.pop();
    } else if (part !== '.' && part !== '') {
      parts.push(part);
    }
  }

  return parts.join('/');
}
