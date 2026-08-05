#!/usr/bin/env -S npx tsx
/**
 * Agent driver for epubcheck-ts.
 *
 * Runs the validator straight from `src/` through tsx, so a change to a
 * validator is observable without a build step, and diffs the result against
 * the Java EPUBCheck CLI — the comparison every parity claim in this repo is
 * measured with.
 *
 * Run with no arguments for the command and flag list (see usage() below).
 */

import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const MAX_BUFFER = 64 * 1024 * 1024;

/** Exit 2 for "you invoked this wrong", distinct from 1 for "the EPUB is bad". */
function fail(message) {
  console.error(message);
  process.exit(2);
}

// ---------------------------------------------------------------- arg parsing

const argv = process.argv.slice(2);
const command = argv.shift();
const paths = [];
const opts = { jobs: 4 };

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

// ------------------------------------------------------------------ TS runner

/**
 * `src/index.ts` is the layer PRs touch, so it is the default. `--dist` swaps in
 * the built bundle to check that a change survives tsup (the CJS build has
 * broken independently of source before — see the 0.6.2 lazy-import fix).
 */
let epubCheckPromise;
function loadEpubCheck() {
  epubCheckPromise ??= (async () => {
    const spec = opts.dist ? join(ROOT, 'dist/index.js') : join(ROOT, 'src/index.ts');
    if (opts.dist && !existsSync(spec)) fail('missing dist/index.js — run `npm run build` first');
    return (await import(spec)).EpubCheck;
  })();
  return epubCheckPromise;
}

function validateOptions() {
  const o = {};
  if (opts.usage) o.includeUsage = true;
  if (opts.version) o.version = opts.version;
  if (opts.profile) o.profile = opts.profile;
  if (opts.mode) o.mode = opts.mode;
  return o;
}

/**
 * Three entry points, picked from the path so the caller does not have to: a
 * directory is an expanded EPUB, a file whose extension names a standalone
 * content type is single-file, anything else is a zipped publication. An
 * explicit `--mode` wins, which is the only way to reach `nav` (indistinguishable
 * from any other .xhtml) and the modes with no extension of their own.
 */
const SINGLE_FILE_MODES = {
  '.xhtml': 'xhtml',
  '.html': 'xhtml',
  '.svg': 'svg',
  '.opf': 'opf',
  '.smil': 'mo',
};

function resolveInput(file) {
  if (!existsSync(file)) fail(`no such file or directory: ${file}`);
  if (statSync(file).isDirectory()) return { kind: 'expanded', mode: opts.mode ?? 'exp' };

  const byExtension = SINGLE_FILE_MODES[extname(file).toLowerCase()];
  const mode = opts.mode ?? byExtension;
  // `--mode exp` on a file is meaningless; every other explicit mode names a
  // standalone content type, so it forces single-file even for an odd extension.
  const single = mode !== undefined && mode !== 'exp' && (byExtension !== undefined || opts.mode);
  return { kind: single ? 'single' : 'zipped', mode };
}

async function readTree(dir) {
  const files = new Map();
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const abs = join(entry.parentPath, entry.name);
    // OCF paths are '/'-separated by spec; without this the map keys would be
    // backslashed on Windows and every manifest lookup would miss. Matches
    // bin/epubcheck.ts and test/integration/conformance.integration.test.ts.
    files.set(relative(dir, abs).split(sep).join('/'), new Uint8Array(await readFile(abs)));
  }
  return files;
}

async function runTs(file, { kind, mode }) {
  const EpubCheck = await loadEpubCheck();
  const o = { ...validateOptions(), ...(mode ? { mode } : {}) };

  let result;
  if (kind === 'expanded') {
    result = await EpubCheck.validateExpanded(await readTree(file), o);
  } else if (kind === 'single') {
    result = await EpubCheck.validateSingleFile(await readFile(file), file, o);
  } else {
    result = await EpubCheck.validate(await readFile(file), o, file);
  }

  return {
    valid: result.valid,
    counts: {
      fatal: result.fatalCount,
      error: result.errorCount,
      warning: result.warningCount,
      info: result.infoCount,
      usage: result.usageCount,
    },
    version: result.version,
    elapsedMs: result.elapsedMs,
    messages: result.messages.map((m) => ({
      id: m.id,
      severity: String(m.severity).toUpperCase(),
      path: m.location?.path ?? null,
      line: m.location?.line ?? null,
      message: m.message,
    })),
  };
}

// ---------------------------------------------------------------- Java runner

/**
 * Java reports IDs with an underscore (`MED_015`); this port uses a hyphen
 * (`MED-015`). Every comparison below normalises to the hyphen form.
 */
const normalizeId = (id) => id.replace(/_/g, '-');

async function runJava(file, { kind, mode }) {
  const args = [file, '--json', '-'];
  if (opts.usage) args.push('-u');
  if (opts.profile) args.push('--profile', opts.profile);

  // Java refuses a non-.epub input without an explicit --mode, and every mode
  // but `exp` also needs -v.
  if (kind !== 'zipped') args.push('--mode', mode);
  if (opts.version) args.push('-v', opts.version);
  else if (kind === 'single') args.push('-v', '3.0');

  let stdout;
  try {
    // Java exits 1 when it finds errors, which execFile treats as a failure;
    // the JSON is still on stdout, so read it off the error object.
    ({ stdout } = await execFileAsync('epubcheck', args, { maxBuffer: MAX_BUFFER }));
  } catch (err) {
    if (err.code === 'ENOENT') {
      fail(
        'the Java `epubcheck` CLI is not on PATH — `brew install epubcheck` (diff/corpus need it)',
      );
    }
    if (typeof err.stdout !== 'string' || !err.stdout.trim()) throw err;
    stdout = err.stdout;
  }

  const report = JSON.parse(stdout);
  const c = report.checker;
  return {
    valid: c.nFatal === 0 && c.nError === 0,
    counts: {
      fatal: c.nFatal,
      error: c.nError,
      warning: c.nWarning,
      info: c.nInfo ?? 0,
      usage: c.nUsage,
    },
    version: report.publication?.ePubVersion ?? null,
    messages: report.messages.map((m) => ({
      id: normalizeId(m.ID),
      severity: m.severity,
      path: m.locations?.[0]?.path ?? null,
      line: m.locations?.[0]?.line ?? null,
      message: m.message,
    })),
  };
}

// -------------------------------------------------------------------- compare

/**
 * Only FATAL/ERROR/WARNING count toward agreement — the metric PROJECT_STATUS
 * quotes. `--usage` widens the comparison to every severity, which is what you
 * want when debugging a specific message rather than measuring the corpus.
 */
const SIGNIFICANT = new Set(['FATAL', 'ERROR', 'WARNING']);
const counted = (severity) => opts.usage || SIGNIFICANT.has(severity);

function tally(messages) {
  const counts = new Map();
  for (const m of messages) {
    if (!counted(m.severity)) continue;
    counts.set(m.id, (counts.get(m.id) ?? 0) + 1);
  }
  return counts;
}

function compare(ts, java) {
  const a = tally(ts.messages);
  const b = tally(java.messages);
  const onlyTs = [];
  const onlyJava = [];
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    const delta = (a.get(id) ?? 0) - (b.get(id) ?? 0);
    if (delta > 0) onlyTs.push(`${id}${delta > 1 ? ` x${String(delta)}` : ''}`);
    if (delta < 0) onlyJava.push(`${id}${delta < -1 ? ` x${String(-delta)}` : ''}`);
  }
  // Validating under the wrong version family is the parity bug 0.6.3 fixed (an
  // OEBPS 1.2 package checked as EPUB 3 turned 1 Java message into 12), and it
  // can happen while the message IDs still line up. Only the *major* version is
  // comparable: we report the version the OPF declares ("3.0") while Java
  // reports the ruleset it applied ("3.3"), so an exact match never holds.
  // Reported separately rather than folded into `exact`, which stays the
  // ID-agreement metric PROJECT_STATUS quotes.
  const tsVersion = ts.version ?? null;
  const javaVersion = java.version ?? null;
  const major = (v) => (v ? String(v).split('.')[0] : null);

  return {
    verdictMatch: ts.valid === java.valid,
    versionMatch: major(tsVersion) === major(javaVersion),
    tsVersion,
    javaVersion,
    exact: onlyTs.length === 0 && onlyJava.length === 0,
    onlyTs: onlyTs.sort(),
    onlyJava: onlyJava.sort(),
  };
}

// --------------------------------------------------------------------- output

const GREY = '\x1b[90m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const OFF = '\x1b[0m';

const SEVERITY_COLOR = { FATAL: RED, ERROR: RED, WARNING: YELLOW };
const severityColor = (s) => SEVERITY_COLOR[s] ?? GREY;

function printMessages(result) {
  for (const m of result.messages) {
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

// -------------------------------------------------------------------- helpers

async function findEpubs(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith('.epub'))
      out.push(join(entry.parentPath, entry.name));
  }
  return out.sort();
}

/** Java takes ~1.5s per book, so the corpus run is worth parallelising. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}

function usage() {
  console.error(
    `epubcheck-ts driver

  check   <path...>   validate via src/ (no build needed)
  diff    <path...>   differential against Java EPUBCheck
  corpus  <dir>       batch differential, prints agreement stats
  cli     <args...>   run the built CLI (needs \`npm run build\`)

flags: --usage --dist --json --version <v> --profile <p> --mode <m>
       --jobs <n> --limit <n>`,
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
    const result = await runTs(file, resolveInput(file));
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
  // Unlike `check`, each item spends ~1.5s in a Java subprocess, so this runs
  // through the same worker pool as `corpus`; mapLimit keeps results in order.
  const compared = await mapLimit(paths, opts.jobs, async (file) => {
    const input = resolveInput(file);
    const [ts, java] = await Promise.all([runTs(file, input), runJava(file, input)]);
    return { file, ts, java, cmp: compare(ts, java) };
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
  process.exitCode = mismatched ? 1 : 0;
}

async function cmdCorpus() {
  const dir = paths[0] ?? join(ROOT, 'test/fixtures');
  let files = await findEpubs(dir);
  if (opts.limit) files = files.slice(0, opts.limit);
  if (!files.length) fail(`no .epub files under ${dir}`);
  console.error(`${files.length} fixtures, ${String(opts.jobs)} jobs...`);

  const rows = await mapLimit(files, opts.jobs, async (file) => {
    try {
      const input = resolveInput(file);
      const [ts, java] = await Promise.all([runTs(file, input), runJava(file, input)]);
      return { file: relative(ROOT, file), ...compare(ts, java) };
    } catch (err) {
      // Triage is the whole point of `corpus`, and a truncated one-line message
      // makes a JSON.parse of clipped Java output look like a validator crash.
      return {
        file: relative(ROOT, file),
        failed: { name: err.name, code: err.code, message: err.message },
      };
    }
  });

  const ok = rows.filter((r) => !r.failed);
  const verdict = ok.filter((r) => r.verdictMatch).length;
  const exact = ok.filter((r) => r.exact).length;
  const pct = (n) => (ok.length ? `${((n / ok.length) * 100).toFixed(1)}%` : 'n/a');

  if (opts.json) {
    console.log(JSON.stringify({ total: rows.length, verdict, exact, rows }, null, 2));
    return;
  }

  for (const r of rows) {
    if (r.failed) {
      const { name, code, message } = r.failed;
      const label = [name, code].filter(Boolean).join('/');
      console.log(`${RED}CRASH${OFF}  ${r.file}  ${label}: ${message.split('\n')[0]}`);
    } else if (!r.exact || !r.versionMatch) {
      const bits = [];
      if (r.onlyTs.length) bits.push(`+ts ${r.onlyTs.join(',')}`);
      if (r.onlyJava.length) bits.push(`+java ${r.onlyJava.join(',')}`);
      if (!r.versionMatch) bits.push(`version ts=${r.tsVersion} java=${r.javaVersion}`);
      const flag = r.verdictMatch ? `${YELLOW}DIFF ${OFF}` : `${RED}VERDICT${OFF}`;
      console.log(`${flag} ${r.file}  ${GREY}${bits.join('  ')}${OFF}`);
    }
  }
  const crashed = rows.length - ok.length;
  console.log(
    `\n${String(ok.length)} compared, ${String(crashed)} crashed\n` +
      `verdict agreement      ${pct(verdict)}  (${String(verdict)}/${String(ok.length)})\n` +
      `error/warning ID exact ${pct(exact)}  (${String(exact)}/${String(ok.length)})`,
  );
  // check/diff gate on their result; corpus should too, or CI cannot use it.
  process.exitCode = crashed ? 1 : 0;
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
