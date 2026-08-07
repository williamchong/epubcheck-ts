#!/usr/bin/env -S npx tsx
/**
 * Agent driver for epubcheck-ts.
 *
 * Runs the validator straight from `src/` through tsx, so a change to a
 * validator is observable without a build step, and diffs the result against
 * the Java EPUBCheck CLI.
 *
 * The comparison engine, the corpus definitions and the reporting all live in
 * `scripts/parity/` -- typechecked, linted, and shared with `npm run parity`.
 * This file is the agent-facing CLI over them and nothing more: a measurement
 * rig cannot afford two implementations of its own oracle.
 *
 * Run with no arguments for the command and flag list (see usage() below).
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';

import { JavaCache } from '../../../scripts/parity/cache.js';
import { compare, isCounted } from '../../../scripts/parity/compare.js';
import { compareItem, packagedCorpus, partition } from '../../../scripts/parity/corpus.js';
import {
  ROOT,
  javaVersion,
  mapLimit,
  resolveInput,
  runJava,
  runTs,
} from '../../../scripts/parity/engine.js';
import {
  GREEN,
  GREY,
  OFF,
  RED,
  YELLOW,
  printDisagreements,
  printJson,
  printTotals,
  scopeOf,
} from '../../../scripts/parity/report.js';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;
const CACHE_DIR = join(ROOT, 'test/parity/java');

/** Exit 2 for "you invoked this wrong", distinct from 1 for "the EPUB is bad". */
function fail(message) {
  console.error(message);
  process.exit(2);
}

// ---------------------------------------------------------------- arg parsing

const argv = process.argv.slice(2);
const command = argv.shift();
const paths = [];
const opts = { jobs: 4, cache: 'use', usage: false, dist: false, json: false };

// `cli` forwards its tail to bin/epubcheck.js verbatim. That has to happen before
// the loop below, which would otherwise eat the flags the built CLI defines for
// itself — `--json`/`--profile`/`--mode` silently, and `--version` along with
// whatever argument followed it.
const cliArgs = command === 'cli' ? argv.slice() : [];

function flagValue(flag) {
  const value = argv.shift();
  if (value === undefined) fail(`${flag} needs a value`);
  return value;
}

function positiveInt(flag) {
  const value = Number(flagValue(flag));
  // Number('abc') is NaN, which survives every later guard: Array.from({length:
  // NaN}) is [], so a typo'd --jobs silently runs zero workers.
  if (!Number.isInteger(value) || value < 1) fail(`${flag} needs a positive integer`);
  return value;
}

if (command !== 'cli') {
  while (argv.length) {
    const arg = argv.shift();
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
        // ENOENT stack trace naming a file the caller never mentioned.
        if (arg.startsWith('-')) fail(`unknown flag ${arg}`);
        paths.push(arg);
    }
  }
}

const runOptions = () => ({
  version: opts.version,
  profile: opts.profile,
  mode: opts.mode,
});

/** Shared with `npm run parity`, so a `diff` here costs no Java after the first run. */
async function makeCache() {
  if (opts.cache === 'off') return undefined;
  return new JavaCache(CACHE_DIR, await javaVersion(), opts.cache);
}

async function bothSides(file, cache) {
  const input = resolveInput(file, opts.mode);
  return Promise.all([
    runTs({ file, input, opts: runOptions(), useDist: opts.dist }),
    runJava({ file, input, opts: runOptions(), cache }),
  ]);
}

// --------------------------------------------------------------------- output

const SEVERITY_COLOR = { FATAL: RED, ERROR: RED, WARNING: YELLOW };
const severityColor = (s) => SEVERITY_COLOR[s] ?? GREY;

function printMessages(result) {
  // The engine always collects every severity, so the default view filters here.
  const shown = result.messages.filter((m) => isCounted(m.severity, opts.usage));
  for (const m of shown) {
    const where = m.path ? `${m.path}${m.line ? `:${String(m.line)}` : ''}` : '(no location)';
    console.log(
      `${severityColor(m.severity)}${m.severity.padEnd(7)}${OFF} ${m.id.padEnd(8)} ${GREY}${where}${OFF}  ${m.message}`,
    );
  }
  const c = result.counts;
  console.log(
    `${result.valid ? `${GREEN}VALID${OFF}` : `${RED}INVALID${OFF}`}  ` +
      `${String(c.fatal)} fatal / ${String(c.error)} error / ${String(c.warning)} warning / ` +
      `${String(c.info)} info / ${String(c.usage)} usage`,
  );
}

function usage() {
  console.error(
    `epubcheck-ts driver

  check   <path...>   validate via src/ (no build needed)
  diff    <path...>   differential against Java EPUBCheck (cached)
  corpus  <dir>       batch differential, prints agreement stats
  cli     <args...>   run the built CLI (needs \`npm run build\`)

flags: --usage --dist --json --version <v> --profile <p> --mode <m>
       --jobs <n> --limit <n> --no-cache --refresh

For the committed baseline and the regression gate, use \`npm run parity:check\`.`,
  );
  process.exit(2);
}

// -------------------------------------------------------------------- commands

async function cmdCheck() {
  if (!paths.length) usage();
  // Deliberately sequential: `check` is single-threaded in-process work (all 763
  // fixtures take ~4s total), so a worker pool buys nothing and costs ordering.
  let bad = 0;
  for (const file of paths) {
    const result = await runTs({
      file,
      input: resolveInput(file, opts.mode),
      opts: runOptions(),
      useDist: opts.dist,
    });
    if (!result.valid) bad++;
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      continue;
    }
    if (paths.length > 1) console.log(`\n${GREY}── ${relative(ROOT, file)}${OFF}`);
    printMessages(result);
  }
  process.exitCode = bad ? 1 : 0;
}

async function cmdDiff() {
  if (!paths.length) usage();
  const cache = await makeCache();
  const compared = await mapLimit(paths, opts.jobs, async (file) => {
    const [ts, java] = await bothSides(file, cache);
    return { file, ts, java, cmp: compare(ts, java, opts.usage) };
  });

  let mismatched = 0;
  for (const { file, ts, java, cmp } of compared) {
    if (!cmp.exact) mismatched++;
    if (opts.json) {
      console.log(JSON.stringify({ file, ts, java, cmp }, null, 2));
      continue;
    }
    console.log(`\n${GREY}── ${relative(ROOT, file)}${OFF}`);
    console.log(`  ts   ${ts.valid ? 'VALID  ' : 'INVALID'}  ${JSON.stringify(ts.counts)}`);
    console.log(`  java ${java.valid ? 'VALID  ' : 'INVALID'}  ${JSON.stringify(java.counts)}`);
    if (cmp.exact) {
      console.log(`  ${GREEN}identical${OFF}`);
    } else {
      if (cmp.onlyTs.length) console.log(`  ${RED}only ts:${OFF}   ${cmp.onlyTs.join(', ')}`);
      if (cmp.onlyJava.length)
        console.log(`  ${YELLOW}only java:${OFF} ${cmp.onlyJava.join(', ')}`);
      if (!cmp.verdictMatch) console.log(`  ${RED}verdict differs${OFF}`);
    }
    if (!cmp.versionMatch) {
      console.log(`  ${RED}version differs${OFF} ts=${cmp.tsVersion} java=${cmp.javaVersion}`);
    }
  }
  if (cache) console.error(`${GREY}${cache.summary()}${OFF}`);
  process.exitCode = mismatched ? 1 : 0;
}

async function cmdCorpus() {
  const dir = paths[0] ?? join(ROOT, 'test/fixtures');
  let items = await packagedCorpus(dir);
  if (opts.limit) items = items.slice(0, opts.limit);
  if (!items.length) fail(`no .epub files under ${dir}`);
  const cache = await makeCache();
  console.error(`${items.length} fixtures, ${String(opts.jobs)} jobs...`);

  const req = {
    opts: runOptions(),
    useDist: opts.dist,
    includeUsage: opts.usage,
    cache,
  };
  const rows = await mapLimit(items, opts.jobs, (item) => compareItem(item, req));

  if (opts.json) {
    printJson(rows);
    return;
  }
  printDisagreements(rows);
  printTotals(rows, cache ? cache.summary() : 'cache: disabled', scopeOf(opts.usage));
  // check/diff gate on their result; corpus should too, or CI cannot use it.
  process.exitCode = partition(rows).failed.length ? 1 : 0;
}

async function cmdCli() {
  // bin/epubcheck.js and dist/ are build output (both gitignored); without them
  // node fails with a bare MODULE_NOT_FOUND naming neither.
  for (const artifact of ['bin/epubcheck.js', 'dist/index.js']) {
    if (!existsSync(join(ROOT, artifact)))
      fail(`missing ${artifact} — run \`npm run build\` first`);
  }
  const result = await execFileAsync(
    process.execPath,
    [join(ROOT, 'bin/epubcheck.js'), ...cliArgs],
    { maxBuffer: MAX_BUFFER },
  ).catch((err) => err);

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  // The built CLI exits 1 on validation errors; forward that rather than
  // reporting success. A spawn failure has no captured output at all.
  if (result instanceof Error) {
    if (!result.stdout && !result.stderr) console.error(result.message);
    process.exitCode = result.code ?? 1;
  }
}

const commands = { check: cmdCheck, diff: cmdDiff, corpus: cmdCorpus, cli: cmdCli };
if (!command || !(command in commands)) usage();
try {
  await commands[command]();
} catch (err) {
  // Without this a bad path or an unreadable EPUB prints a raw stack trace.
  fail(`${command}: ${err.message}`);
}
