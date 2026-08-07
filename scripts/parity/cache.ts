/**
 * Content-addressed cache for Java EPUBCheck output.
 *
 * Java costs ~1.5s per book. Over the 763-fixture corpus that is ~11 minutes a
 * run, which is why parity gets asserted from memory instead of measured. The
 * TS side is ~4s for the same corpus, so caching the oracle is what turns a
 * coffee-break command into one you run per edit.
 *
 * The key covers everything that can change Java's answer:
 *
 *   sha256(magic, java version, input path, argv signature, input bytes)
 *
 * Both halves of that are load-bearing. Keying on the path alone -- what the
 * throwaway version of this harness did -- survives a fixture rewrite and
 * happily serves stale results: commit 4b855e9 replaced every placeholder image
 * with real image data, which a path-keyed cache would have reported as a
 * parity improvement that never happened. Keying on content alone would share
 * one entry between two byte-identical fixtures with different names, and Java's
 * standalone modes are addressed by basename, so the name really does change the
 * output. The Java version is in the key so `brew upgrade epubcheck` invalidates
 * the store cleanly instead of corrupting it -- PROJECT_STATUS quotes figures
 * against a named baseline, and this is what keeps that honest.
 *
 * Entries store Java's report verbatim. It is the oracle; normalizing before
 * writing would bake today's comparison logic into the artifact and make every
 * later metric unrecoverable without a full re-run.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type JavaReport, ParityUsageError, isJavaReport, isRecord } from './types.js';

/** Bump when the key inputs or entry shape change, to orphan old entries. */
const MAGIC = 'epubcheck-ts-parity-v1';

/** How a run treats the store: read+write, re-run and overwrite, or ignore. */
export type CacheMode = 'use' | 'refresh' | 'off';

const isNotFound = (err: unknown): boolean =>
  isRecord(err) && (err as { code?: unknown }).code === 'ENOENT';

export interface CacheEntry {
  tool: string;
  javaVersion: string;
  /** Repo-relative input path, for auditing an entry without a side index. */
  input: string;
  /** The Java argv this report came from, minus the input path itself. */
  argv: string[];
  report: JavaReport;
}

export interface CacheStats {
  hit: number;
  miss: number;
  written: number;
}

export class JavaCache {
  readonly stats: CacheStats = { hit: 0, miss: 0, written: 0 };
  /** Keys touched this run, so `prune` can drop entries nothing references. */
  private readonly used = new Set<string>();
  private ready: Promise<void> | undefined;

  constructor(
    private readonly dir: string,
    private readonly javaVersion: string,
    /** `--no-cache` reads nothing and writes nothing; `--refresh` only skips reads. */
    private readonly mode: CacheMode = 'use',
    /**
     * No Java on PATH, so the cache is the only oracle available. A miss cannot
     * silently fall through to a subprocess that does not exist -- it has to
     * name the fixture the committed store is missing.
     */
    private readonly offline = false,
  ) {}

  private async ensureDir(): Promise<void> {
    this.ready ??= mkdir(this.dir, { recursive: true }).then(() => undefined);
    await this.ready;
  }

  key(input: string, argv: string[], contentDigest: string): string {
    const hash = createHash('sha256');
    // Fields are length-prefixed rather than delimiter-joined: a separator that
    // can occur inside a field lets two different inputs collide on one key.
    for (const part of [MAGIC, this.javaVersion, input, argv.join(' '), contentDigest]) {
      hash.update(`${String(part.length)}:${part}\0`);
    }
    return hash.digest('hex');
  }

  private path(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  async read(key: string, label: string): Promise<JavaReport | undefined> {
    this.used.add(key);
    if (this.mode !== 'use') return undefined;

    const file = this.path(key);
    let raw: string;
    try {
      // Read directly rather than existsSync-then-read: one syscall instead of
      // two, and no window in which the entry can vanish between the check and
      // the read.
      raw = await readFile(file, 'utf8');
    } catch (err) {
      if (!isNotFound(err)) throw err;
      this.stats.miss++;
      if (this.offline) {
        throw new ParityUsageError(
          `${label}: not in the committed cache and no Java EPUBCheck on PATH -- ` +
            'the fixture changed without `npm run parity:update` being re-run',
        );
      }
      return undefined;
    }
    const entry = parseCacheEntry(raw, file);
    this.stats.hit++;
    return entry.report;
  }

  async write(key: string, entry: Omit<CacheEntry, 'tool' | 'javaVersion'>): Promise<void> {
    if (this.mode === 'off') return;
    await this.ensureDir();
    const full: CacheEntry = { tool: MAGIC, javaVersion: this.javaVersion, ...entry };
    // Minified on purpose. A content change rewrites the key, so entries are
    // added and removed wholesale rather than diffed line by line; pretty
    // printing would roughly double a store that is already megabytes.
    await writeFile(this.path(key), JSON.stringify(full), 'utf8');
    this.stats.written++;
  }

  /**
   * Delete entries no run touched. Without this the committed store grows
   * monotonically: rewriting a fixture orphans its old entry forever, since the
   * new bytes hash to a different name rather than overwriting the old one.
   */
  async prune(): Promise<string[]> {
    if (!existsSync(this.dir)) return [];
    const removed: string[] = [];
    for (const name of await readdir(this.dir)) {
      if (!name.endsWith('.json')) continue;
      if (this.used.has(name.slice(0, -'.json'.length))) continue;
      await unlink(join(this.dir, name));
      removed.push(name);
    }
    return removed;
  }

  /** One line, so a cached number is never mistaken for a freshly measured one. */
  summary(): string {
    const { hit, miss, written } = this.stats;
    if (this.mode === 'off') return 'cache: disabled';
    const label = this.mode === 'refresh' ? 'refreshed' : 'cache';
    return `${label}: ${String(hit)} hit / ${String(miss)} miss / ${String(written)} written`;
  }
}

function parseCacheEntry(raw: string, file: string): CacheEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`${file}: corrupt cache entry (${detail}) -- delete it and re-run`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`${file}: corrupt cache entry -- delete it and re-run`);
  }
  const record = parsed;
  // Validated in place. Round-tripping through JSON to reuse the string-based
  // parser would re-serialize and re-parse every entry on every cache hit --
  // megabytes of pointless work across a 763-fixture run.
  if (!isJavaReport(record.report)) {
    throw new Error(`${file}: cache entry holds no valid EPUBCheck report -- delete it`);
  }
  const report = record.report;
  return {
    tool: typeof record.tool === 'string' ? record.tool : '',
    javaVersion: typeof record.javaVersion === 'string' ? record.javaVersion : '',
    input: typeof record.input === 'string' ? record.input : '',
    argv: Array.isArray(record.argv) ? record.argv.map(String) : [],
    report,
  };
}

/** sha256 of a single file's bytes. */
export function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * sha256 of an expanded EPUB's whole tree. Sorted by path and length-prefixed
 * so neither directory-iteration order nor a rename between two same-sized
 * files can produce the same digest.
 */
export function digestTree(files: Map<string, Uint8Array>): string {
  const hash = createHash('sha256');
  for (const path of [...files.keys()].sort()) {
    const bytes = files.get(path);
    if (!bytes) continue;
    hash.update(`${String(path.length)}:${path}\0`);
    hash.update(digestBytes(bytes));
  }
  return hash.digest('hex');
}
