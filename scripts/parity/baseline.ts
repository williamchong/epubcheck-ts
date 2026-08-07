/**
 * The parity baseline: a committed snapshot of where every fixture stands, and
 * the comparison that turns a drop in agreement into a failed command.
 *
 * `corpus` has always reported percentages, but it only ever exited non-zero on
 * a crash -- agreement could fall from 88.3% to 70% and the command still
 * passed. A headline percentage also cannot say *which* fixture moved, so a
 * change that fixes four fixtures and breaks three looks like a small win.
 * Recording per-fixture state makes both directions visible and reviewable.
 *
 * Deliberately no timestamp field. Every regeneration would rewrite it, so the
 * diff would always be non-empty and would stop meaning "something changed";
 * git already records when the file was written.
 */

import { readFile, writeFile } from 'node:fs/promises';
import type { Comparison } from './compare.js';
import { isRecord } from './types.js';

export interface FixtureRecord {
  verdict: boolean;
  /** Same distinct IDs, ignoring multiplicity. */
  setMatch: boolean;
  /** Same IDs and the same count of each. */
  exact: boolean;
  onlyTs: string[];
  onlyJava: string[];
}

export interface Baseline {
  javaVersion: string;
  /** Which severities the run counted, since it changes every field below. */
  includeUsage: boolean;
  fixtures: Record<string, FixtureRecord>;
}

export function toBaseline(
  javaVersion: string,
  includeUsage: boolean,
  rows: readonly { file: string; cmp: Comparison }[],
): Baseline {
  const fixtures: Record<string, FixtureRecord> = {};
  // Sorted so the committed file has a stable order and a real change is the
  // only thing that ever shows up in review.
  for (const { file, cmp } of [...rows].sort((a, b) => a.file.localeCompare(b.file))) {
    fixtures[file] = {
      verdict: cmp.verdictMatch,
      setMatch: cmp.setMatch,
      exact: cmp.exact,
      onlyTs: cmp.onlyTs,
      onlyJava: cmp.onlyJava,
    };
  }
  return { javaVersion, includeUsage, fixtures };
}

export async function writeBaseline(path: string, baseline: Baseline): Promise<void> {
  await writeFile(path, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
}

export async function readBaseline(path: string): Promise<Baseline | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) return undefined;
  const fixtures = parsed.fixtures;
  if (!isRecord(fixtures)) return undefined;

  // Validated per record rather than cast wholesale. `rank()` reads these as
  // booleans, and a truthy non-boolean (a merge artifact, a hand-edit) would
  // score a fixture as perfect and let a regression through the gate silently.
  const validated: Record<string, FixtureRecord> = {};
  for (const [file, value] of Object.entries(fixtures)) {
    if (!isFixtureRecord(value)) {
      throw new Error(`${path}: fixture entry ${file} is malformed -- regenerate the baseline`);
    }
    validated[file] = value;
  }
  return {
    javaVersion: typeof parsed.javaVersion === 'string' ? parsed.javaVersion : 'unknown',
    includeUsage: parsed.includeUsage === true,
    fixtures: validated,
  };
}

function isFixtureRecord(value: unknown): value is FixtureRecord {
  if (!isRecord(value)) return false;
  const isIdList = (v: unknown): boolean =>
    Array.isArray(v) && v.every((e) => typeof e === 'string');
  return (
    typeof value.verdict === 'boolean' &&
    typeof value.setMatch === 'boolean' &&
    typeof value.exact === 'boolean' &&
    isIdList(value.onlyTs) &&
    isIdList(value.onlyJava)
  );
}

export interface BaselineDiff {
  regressed: { file: string; was: FixtureRecord; now: FixtureRecord }[];
  improved: { file: string; was: FixtureRecord; now: FixtureRecord }[];
  added: string[];
  removed: string[];
  /** Set when the snapshot was taken under conditions that make it incomparable. */
  incomparable: string | undefined;
}

/**
 * A fixture's standing on a monotone scale, so a drop at any level is a
 * regression. Finding the same problems but reporting one of them twice is
 * worse than exact and better than missing it entirely, and the gate should
 * be able to tell those apart.
 */
const rank = (r: FixtureRecord): number => (r.exact ? 3 : r.setMatch ? 2 : r.verdict ? 1 : 0);

export function diffBaseline(
  was: Baseline,
  javaVersion: string,
  includeUsage: boolean,
  rows: readonly { file: string; cmp: Comparison }[],
): BaselineDiff {
  const now = toBaseline(javaVersion, includeUsage, rows);
  const diff: BaselineDiff = {
    regressed: [],
    improved: [],
    added: [],
    removed: [],
    incomparable: undefined,
  };

  // Comparing across oracle versions or severity filters produces differences
  // that are not regressions. Say so rather than reporting a false failure.
  if (was.javaVersion !== javaVersion) {
    diff.incomparable = `baseline was measured against ${was.javaVersion}, this run used ${javaVersion}`;
  } else if (was.includeUsage !== includeUsage) {
    diff.incomparable = `baseline was measured with includeUsage=${String(was.includeUsage)}`;
  }

  for (const [file, current] of Object.entries(now.fixtures)) {
    const previous = was.fixtures[file];
    if (!previous) {
      diff.added.push(file);
      continue;
    }
    const before = rank(previous);
    const after = rank(current);
    if (after < before) diff.regressed.push({ file, was: previous, now: current });
    else if (after > before) diff.improved.push({ file, was: previous, now: current });
  }
  for (const file of Object.keys(was.fixtures)) {
    if (!(file in now.fixtures)) diff.removed.push(file);
  }
  return diff;
}
