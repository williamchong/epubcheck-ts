/**
 * What "the corpus" means, and how one fixture gets compared.
 *
 * The selection rules matter as much as the results. PROJECT_STATUS quotes a
 * standalone table at n=1286 (489 opf / 745 xhtml / 52 svg) whose membership
 * lived only in a scratchpad file listing; reconstructing it meant deducing the
 * rule back out of three published counts. It is written down here now, so the
 * numbers can be regenerated, and contradicted, by anyone.
 */

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import {
  type JavaRun,
  ParityUsageError,
  ROOT,
  type TsRun,
  findEpubs,
  resolveInput,
  runJava,
  runTs,
} from './engine.js';
import type { JavaCache } from './cache.js';
import { type Comparison, compare } from './compare.js';
import type { RunOptions } from './types.js';

export interface CorpusItem {
  /** Display label, and the key used in the committed baseline. */
  label: string;
  /** Real path to the bytes. */
  file: string;
  /** Name to address the fixture by, when it differs from `file`. */
  asName: string | undefined;
  /** Directory the Java CLI runs in, paired with `asName`. */
  cwd: string | undefined;
}

/** Packaged EPUBs -- the headline corpus, and the one the CI gate runs on. */
export async function packagedCorpus(dir: string): Promise<CorpusItem[]> {
  return (await findEpubs(dir)).map((file) => ({
    label: relative(ROOT, file),
    file,
    asName: undefined,
    cwd: undefined,
  }));
}

/** Where Java's own single-file fixtures live, as a sibling checkout. */
export const JAVA_RESOURCES = resolve(ROOT, '../epubcheck/src/test/resources');

const STANDALONE_ROOT = join(JAVA_RESOURCES, 'epub3');

/**
 * The standalone content types, and the buckets the per-mode table reports.
 * One list, because a fixture extension the table does not know about would be
 * measured and then silently dropped from the breakdown.
 */
export const STANDALONE_MODES = [
  { mode: 'opf', extension: '.opf' },
  { mode: 'xhtml', extension: '.xhtml' },
  { mode: 'svg', extension: '.svg' },
] as const;

const STANDALONE_EXTENSIONS: readonly string[] = STANDALONE_MODES.map((m) => m.extension);

/**
 * Java's standalone single-file fixtures: everything under `epub3/` with an
 * extension naming a content type, minus `test-files-unused/`.
 *
 * The exclusion is not incidental -- those are fixtures Java's own suite
 * stopped referencing, so a disagreement there is measured against files the
 * oracle itself no longer exercises. Including them also breaks the published
 * counts: `epub3/` holds 496 opf / 757 xhtml / 52 svg, and dropping the 7 opf
 * and 12 xhtml under `test-files-unused/` is exactly the quoted 489 / 745 / 52.
 */
export async function standaloneCorpus(): Promise<CorpusItem[]> {
  if (!existsSync(STANDALONE_ROOT)) {
    throw new ParityUsageError(
      `standalone fixtures need the Java source as a sibling checkout: expected ${STANDALONE_ROOT}`,
    );
  }
  const items: CorpusItem[] = [];
  for (const entry of await readdir(STANDALONE_ROOT, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    if (!STANDALONE_EXTENSIONS.includes(extname(entry.name).toLowerCase())) continue;
    const file = join(entry.parentPath, entry.name);
    if (relative(STANDALONE_ROOT, file).split(/[\\/]/)[0] === 'test-files-unused') continue;
    items.push({
      label: relative(JAVA_RESOURCES, file),
      file,
      // Addressed by basename from its own directory, on both sides. See the
      // RSC-026 warning on runTs -- getting this wrong does not fail loudly, it
      // just silently reports a near-zero score.
      asName: basename(file),
      cwd: dirname(file),
    });
  }
  return items.sort((a, b) => a.label.localeCompare(b.label));
}

export interface CompareRequest {
  opts: RunOptions;
  useDist: boolean;
  includeUsage: boolean;
  cache: JavaCache | undefined;
}

export interface CompareRow {
  file: string;
  cmp: Comparison;
}

export interface FailedRow {
  file: string;
  failed: { name: string; code: string | undefined; message: string };
}

export type Row = CompareRow | FailedRow;

export const isFailed = (row: Row): row is FailedRow => 'failed' in row;

/**
 * Split rows into the ones that produced a comparison and the ones that blew
 * up. Callers need both halves and the narrowing predicate is not inferable
 * from `filter` alone, so it lived inline at five call sites before this.
 */
export function partition(rows: readonly Row[]): { ok: CompareRow[]; failed: FailedRow[] } {
  const ok: CompareRow[] = [];
  const failed: FailedRow[] = [];
  for (const row of rows) {
    if (isFailed(row)) failed.push(row);
    else ok.push(row);
  }
  return { ok, failed };
}

export async function compareItem(item: CorpusItem, req: CompareRequest): Promise<Row> {
  try {
    const input = resolveInput(item.file, req.opts.mode);
    // Both sides are told the same story about what the input is called; see
    // the RSC-026 warning on TsRun.execName.
    const addressing = {
      ...(item.asName ? { execName: item.asName } : {}),
    };
    const tsRun: TsRun = {
      file: item.file,
      input,
      opts: req.opts,
      useDist: req.useDist,
      ...addressing,
    };
    const javaRun: JavaRun = {
      file: item.file,
      input,
      opts: req.opts,
      cache: req.cache,
      ...addressing,
      ...(item.cwd ? { cwd: item.cwd } : {}),
    };
    const [ts, java] = await Promise.all([runTs(tsRun), runJava(javaRun)]);
    return { file: item.label, cmp: compare(ts, java, req.includeUsage) };
  } catch (err) {
    // Triage is the whole point of a corpus run, and a truncated one-line
    // message makes a clipped Java report look like a validator crash.
    if (err instanceof ParityUsageError) throw err;
    const error = err instanceof Error ? err : new Error(String(err));
    const code = (error as { code?: unknown }).code;
    return {
      file: item.label,
      failed: {
        name: error.name,
        code: typeof code === 'string' ? code : undefined,
        message: error.message,
      },
    };
  }
}
