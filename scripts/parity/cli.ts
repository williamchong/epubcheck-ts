#!/usr/bin/env -S npx tsx
/**
 * The parity harness CLI -- `npm run parity` and friends.
 *
 * Usage: npx tsx scripts/parity/cli.ts <command> [flags]
 *
 * Exit codes match the agent driver's contract: 0 clean, 1 a real result
 * (regression, crash), 2 you invoked it wrong.
 */

import { join } from 'node:path';
import { JavaCache } from './cache.js';
import {
  type CompareRequest,
  type CorpusItem,
  type Row,
  STANDALONE_MODES,
  compareItem,
  packagedCorpus,
  partition,
  standaloneCorpus,
} from './corpus.js';
import { ParityUsageError, ROOT, javaAvailable, javaVersion, mapLimit } from './engine.js';
import {
  GREEN,
  GREY,
  OFF,
  RED,
  YELLOW,
  printBreakdown,
  printDisagreements,
  printJson,
  printTotals,
  scopeOf,
} from './report.js';
import { diffBaseline, readBaseline, toBaseline, writeBaseline } from './baseline.js';

const PARITY_DIR = join(ROOT, 'test/parity');
const BASELINE = join(PARITY_DIR, 'baseline.json');

/**
 * Packaged and standalone corpora get separate stores, because `prune` deletes
 * whatever the current run did not touch. Sharing one directory would make
 * `parity:update` (packaged, pruning) silently delete every standalone entry,
 * and vice versa.
 *
 * Only the packaged store is committed. The standalone corpus cannot run at all
 * without `../epubcheck` as a sibling checkout, so committing ~1286 more entries
 * would bulk up the repo for the benefit of people who, by definition, can
 * already regenerate them.
 */
const CACHE_DIR = join(PARITY_DIR, 'java');
const STANDALONE_CACHE_DIR = join(PARITY_DIR, 'java-standalone');

// ---------------------------------------------------------------- arg parsing

const argv = process.argv.slice(2);
const command = argv.shift();
const positional: string[] = [];
const opts = {
  jobs: 4,
  usage: false,
  dist: false,
  json: false,
  cache: 'use' as 'use' | 'refresh' | 'off',
  prune: false,
  version: undefined as string | undefined,
  profile: undefined as string | undefined,
  mode: undefined as string | undefined,
  limit: undefined as number | undefined,
};

function flagValue(flag: string): string {
  const value = argv.shift();
  if (value === undefined) throw new ParityUsageError(`${flag} needs a value`);
  return value;
}

function positiveInt(flag: string): number {
  const value = Number(flagValue(flag));
  // Number('abc') is NaN, which survives every later guard: Array.from({length:
  // NaN}) is [], so a typo'd --jobs silently runs zero workers.
  if (!Number.isInteger(value) || value < 1) {
    throw new ParityUsageError(`${flag} needs a positive integer`);
  }
  return value;
}

function usage(): never {
  console.error(
    `parity harness

  corpus [dir]   measure packaged EPUBs (default test/fixtures)
  standalone     measure Java's single-file fixtures (needs ../epubcheck)
  check          measure, then fail if any fixture regressed against the baseline
  update         measure and rewrite the committed baseline

flags: --usage --dist --json --jobs <n> --limit <n>
       --version <v> --profile <p> --mode <m>
       --no-cache (always run Java)  --refresh (re-run and overwrite)  --prune`,
  );
  process.exit(2);
}

function parseFlags(): void {
  while (argv.length) {
    const arg = argv.shift();
    if (arg === undefined) break;
    switch (arg) {
      case '-u':
      case '--usage':
        opts.usage = true;
        break;
      case '--dist':
        opts.dist = true;
        break;
      case '--json':
        opts.json = true;
        break;
      case '--no-cache':
        opts.cache = 'off';
        break;
      case '--refresh':
        opts.cache = 'refresh';
        break;
      case '--prune':
        opts.prune = true;
        break;
      case '--version':
        opts.version = flagValue(arg);
        break;
      case '--profile':
        opts.profile = flagValue(arg);
        break;
      case '--mode':
        opts.mode = flagValue(arg);
        break;
      case '--jobs':
        opts.jobs = positiveInt(arg);
        break;
      case '--limit':
        opts.limit = positiveInt(arg);
        break;
      default:
        // Without this an unknown flag becomes a "path" and surfaces as an
        // ENOENT naming a file the caller never mentioned.
        if (arg.startsWith('-')) throw new ParityUsageError(`unknown flag ${arg}`);
        positional.push(arg);
    }
  }
}

// -------------------------------------------------------------------- running

async function measure(
  items: CorpusItem[],
  cacheDir: string,
  /** Version to assume when Java is absent; only the gate supplies one. */
  fallbackVersion?: string,
): Promise<{ rows: Row[]; cacheSummary: string }> {
  // Pruning deletes every entry this run did not touch, so a subsetting flag
  // would quietly throw away most of the committed store.
  if (opts.prune && opts.limit !== undefined) {
    throw new ParityUsageError(
      '--prune cannot be combined with --limit (it would delete the rest)',
    );
  }
  const version = await javaVersion(fallbackVersion);
  const offline = !(await javaAvailable());
  // Both flags mean "ask Java again", which is impossible with no Java. Caught
  // once here: left to the per-fixture path it surfaces as one crash row per
  // fixture, so a single mistyped flag reads as 763 broken fixtures.
  if (offline && opts.cache !== 'use') {
    throw new ParityUsageError('--no-cache and --refresh both need Java EPUBCheck on PATH');
  }
  if (offline) {
    console.error(`${GREY}no Java on PATH -- verifying against the committed cache${OFF}`);
  }
  const cache =
    opts.cache === 'off' ? undefined : new JavaCache(cacheDir, version, opts.cache, offline);

  const req: CompareRequest = {
    opts: { version: opts.version, profile: opts.profile, mode: opts.mode },
    useDist: opts.dist,
    includeUsage: opts.usage,
    cache,
  };

  const selected = opts.limit ? items.slice(0, opts.limit) : items;
  if (!selected.length) throw new ParityUsageError('no fixtures selected');
  console.error(`${String(selected.length)} fixtures, ${String(opts.jobs)} jobs...`);

  const rows = await mapLimit(selected, opts.jobs, (item) => compareItem(item, req));

  if (cache && opts.prune) {
    const removed = await cache.prune();
    if (removed.length) console.error(`pruned ${String(removed.length)} orphaned cache entries`);
  }
  return { rows, cacheSummary: cache ? cache.summary() : 'cache: disabled' };
}

// ------------------------------------------------------------------- commands

async function cmdCorpus(items: CorpusItem[]): Promise<void> {
  const { rows, cacheSummary } = await measure(items, CACHE_DIR);
  // check/corpus gate on their result, or CI cannot use them. Set before the
  // --json return: the rows carry the crashes either way, but a caller reading
  // only the exit code would see success.
  process.exitCode = partition(rows).failed.length ? 1 : 0;
  if (opts.json) {
    printJson(rows);
    return;
  }
  printDisagreements(rows);
  printTotals(rows, cacheSummary, scopeOf(opts.usage));
}

async function cmdStandalone(): Promise<void> {
  const items = await standaloneCorpus();
  const { rows, cacheSummary } = await measure(items, STANDALONE_CACHE_DIR);
  const { ok, failed } = partition(rows);
  process.exitCode = failed.length ? 1 : 0;
  if (opts.json) {
    printJson(rows);
    return;
  }

  printBreakdown(
    'mode',
    STANDALONE_MODES.map(({ mode, extension }) => ({
      label: mode,
      rows: ok.filter((r) => r.file.endsWith(extension)),
    })),
  );
  printTotals(rows, cacheSummary, scopeOf(opts.usage));
}

async function cmdCheck(items: CorpusItem[]): Promise<void> {
  const previous = await readBaseline(BASELINE);
  if (!previous) {
    throw new ParityUsageError(
      `no baseline at ${BASELINE} -- run \`npm run parity:update\` to create it`,
    );
  }
  const { rows, cacheSummary } = await measure(items, CACHE_DIR, previous.javaVersion);
  const { ok, failed } = partition(rows);
  const diff = diffBaseline(previous, await javaVersion(previous.javaVersion), opts.usage, ok);

  if (diff.incomparable) {
    console.error(`${YELLOW}baseline not comparable:${OFF} ${diff.incomparable}`);
    console.error('re-run `npm run parity:update` to rebase it');
    process.exitCode = 2;
    return;
  }

  for (const { file, was, now } of diff.regressed) {
    console.log(`${RED}REGRESSED${OFF} ${file}`);
    console.log(`  ${GREY}was${OFF}  exact=${String(was.exact)} verdict=${String(was.verdict)}`);
    console.log(`  ${GREY}now${OFF}  exact=${String(now.exact)} verdict=${String(now.verdict)}`);
    if (now.onlyTs.length) console.log(`  ${RED}+ts${OFF}   ${now.onlyTs.join(', ')}`);
    if (now.onlyJava.length) console.log(`  ${YELLOW}+java${OFF} ${now.onlyJava.join(', ')}`);
  }
  for (const { file } of diff.improved) console.log(`${GREEN}IMPROVED${OFF}  ${file}`);
  for (const file of diff.added) console.log(`${GREY}NEW${OFF}       ${file}`);
  for (const file of diff.removed) console.log(`${GREY}GONE${OFF}      ${file}`);

  printDisagreements(failed);
  console.log(
    `\n${String(diff.regressed.length)} regressed, ${String(diff.improved.length)} improved, ` +
      `${String(diff.added.length)} new, ${String(diff.removed.length)} gone, ` +
      `${String(failed.length)} crashed  ${GREY}${cacheSummary}${OFF}`,
  );
  if (diff.improved.length || diff.added.length) {
    console.log(`${GREY}run \`npm run parity:update\` to record the improvement${OFF}`);
  }
  process.exitCode = diff.regressed.length || failed.length ? 1 : 0;
}

async function cmdUpdate(items: CorpusItem[]): Promise<void> {
  // `parity:update` ships with --prune, so a subsetting flag is destructive in
  // two directions at once: prune would delete every cache entry the subset did
  // not touch, and the baseline would record only the fixtures that ran, making
  // the next `check` report hundreds of fixtures as GONE.
  if (opts.limit !== undefined) {
    throw new ParityUsageError('update measures the whole corpus -- drop --limit');
  }
  if (positional.length) {
    throw new ParityUsageError(
      `update measures the whole corpus -- drop the path argument (${positional.join(' ')})`,
    );
  }
  const { rows, cacheSummary } = await measure(items, CACHE_DIR);
  const { ok, failed } = partition(rows);
  if (failed.length) {
    printDisagreements(failed);
    throw new Error(
      `${String(failed.length)} fixtures crashed -- refusing to bake that into a baseline`,
    );
  }
  await writeBaseline(BASELINE, toBaseline(await javaVersion(), opts.usage, ok));
  printTotals(rows, cacheSummary, scopeOf(opts.usage));
  console.log(`\nwrote ${BASELINE}`);
}

// ----------------------------------------------------------------------- main

async function main(): Promise<void> {
  parseFlags();
  const dir = positional[0] ?? join(ROOT, 'test/fixtures');

  switch (command) {
    case 'corpus':
      return cmdCorpus(await packagedCorpus(dir));
    case 'standalone':
      return cmdStandalone();
    case 'check':
      return cmdCheck(await packagedCorpus(dir));
    case 'update':
      return cmdUpdate(await packagedCorpus(dir));
    default:
      usage();
  }
}

try {
  await main();
} catch (err) {
  if (err instanceof ParityUsageError) {
    console.error(err.message);
    process.exit(2);
  }
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
