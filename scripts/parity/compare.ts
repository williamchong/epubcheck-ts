/**
 * Diffing one fixture's two results, and rolling many of those up into the
 * figures PROJECT_STATUS quotes.
 *
 * Message-ID agreement was the only thing the throwaway harness computed here.
 * The location and severity figures in PROJECT_STATUS ("62.9% carry a line
 * number", "87.2% of lines match", "severity agrees on 100%") came from
 * one-off scripts that no longer exist, so nothing in the repo could
 * regenerate or contradict them. They are computed here now.
 */

import type { EngineResult, ParityMessage, Severity } from './types.js';

/**
 * Only FATAL/ERROR/WARNING count toward agreement -- the metric PROJECT_STATUS
 * quotes. `--usage` widens every figure below to all severities, which is what
 * you want when debugging one message rather than measuring the corpus.
 */
const SIGNIFICANT = new Set<Severity>(['FATAL', 'ERROR', 'WARNING']);

export const isCounted = (severity: Severity, includeUsage: boolean): boolean =>
  includeUsage || SIGNIFICANT.has(severity);

export interface FixtureMetrics {
  tsMessages: number;
  tsWithLine: number;
  javaMessages: number;
  javaWithLine: number;
  /** Messages both engines emit with the same ID on the same file. */
  pairable: number;
  /** Of those, how many agree on the line number (both sides must have one). */
  lineComparable: number;
  lineMatch: number;
  /** Of those, how many agree on severity. */
  severityMatch: number;
}

export interface Comparison {
  verdictMatch: boolean;
  versionMatch: boolean;
  tsVersion: string | null;
  javaVersion: string | null;
  /** Same IDs *and* the same number of each. The strictest ID metric. */
  exact: boolean;
  /**
   * Same set of distinct IDs, ignoring how many times each fired.
   *
   * Kept separate from `exact` because the two answer different questions and
   * PROJECT_STATUS publishes both: "do we find the same problems?" versus "do
   * we report them the same number of times?". Collapsing them is what makes an
   * 88.3% and a 67.2% look like a contradiction rather than two measurements.
   */
  setMatch: boolean;
  onlyTs: string[];
  onlyJava: string[];
  metrics: FixtureMetrics;
}

function tally(messages: readonly ParityMessage[], includeUsage: boolean): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of messages) {
    if (!isCounted(m.severity, includeUsage)) continue;
    counts.set(m.id, (counts.get(m.id) ?? 0) + 1);
  }
  return counts;
}

const pairKey = (m: ParityMessage): string => `${m.id}\0${m.path ?? ''}`;

/**
 * Sort by line so the n-th occurrence in one engine lines up with the n-th in
 * the other; nulls sort last so a located message is never paired with an
 * unlocated one while a located counterpart is still available.
 */
const byLine = (a: ParityMessage, b: ParityMessage): number =>
  (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER);

/** Takes an already-filtered list; re-applying the severity predicate here
 * walked every message array a second time for no gain. */
function groupByIdAndPath(messages: readonly ParityMessage[]): Map<string, ParityMessage[]> {
  const groups = new Map<string, ParityMessage[]>();
  for (const m of messages) {
    const key = pairKey(m);
    const bucket = groups.get(key);
    if (bucket) bucket.push(m);
    else groups.set(key, [m]);
  }
  return groups;
}

/**
 * Pair messages the two engines agree exist, then ask the narrower questions:
 * did we put it on the same line, and at the same severity?
 *
 * Pairing on (ID, file) rather than on position is deliberate. The same ID can
 * legitimately fire several times in one file, and the two engines do not emit
 * in the same order, so index-wise pairing would compare unrelated messages and
 * report line disagreement that is really ordering.
 */
function measure(ts: EngineResult, java: EngineResult, includeUsage: boolean): FixtureMetrics {
  const counted = (r: EngineResult): ParityMessage[] =>
    r.messages.filter((m) => isCounted(m.severity, includeUsage));

  const tsCounted = counted(ts);
  const javaCounted = counted(java);
  const tsGroups = groupByIdAndPath(tsCounted);
  const javaGroups = groupByIdAndPath(javaCounted);

  let pairable = 0;
  let lineComparable = 0;
  let lineMatch = 0;
  let severityMatch = 0;

  for (const [key, tsBucket] of tsGroups) {
    const javaBucket = javaGroups.get(key);
    if (!javaBucket) continue;
    const left = [...tsBucket].sort(byLine);
    const right = [...javaBucket].sort(byLine);

    for (let i = 0; i < Math.min(left.length, right.length); i++) {
      const a = left[i];
      const b = right[i];
      if (!a || !b) continue;
      pairable++;
      if (a.severity === b.severity) severityMatch++;
      if (a.line !== null && b.line !== null) {
        lineComparable++;
        if (a.line === b.line) lineMatch++;
      }
    }
  }

  return {
    tsMessages: tsCounted.length,
    tsWithLine: tsCounted.filter((m) => m.line !== null).length,
    javaMessages: javaCounted.length,
    javaWithLine: javaCounted.filter((m) => m.line !== null).length,
    pairable,
    lineComparable,
    lineMatch,
    severityMatch,
  };
}

export function compare(ts: EngineResult, java: EngineResult, includeUsage: boolean): Comparison {
  const a = tally(ts.messages, includeUsage);
  const b = tally(java.messages, includeUsage);
  const onlyTs: string[] = [];
  const onlyJava: string[] = [];
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
  const major = (v: string | null): string | null => (v ? (v.split('.')[0] ?? null) : null);
  // Java reports no version at all for a standalone file -- there is no
  // publication to detect one from. Comparing against that would flag every
  // single-file fixture as a version mismatch, burying the real signal in 1286
  // false alarms. An absent version is not comparable, not a disagreement.
  const versionComparable = ts.version !== null && java.version !== null;

  return {
    verdictMatch: ts.valid === java.valid,
    versionMatch: !versionComparable || major(ts.version) === major(java.version),
    tsVersion: ts.version,
    javaVersion: java.version,
    exact: onlyTs.length === 0 && onlyJava.length === 0,
    setMatch: a.size === b.size && [...a.keys()].every((id) => b.has(id)),
    onlyTs: onlyTs.sort(),
    onlyJava: onlyJava.sort(),
    metrics: measure(ts, java, includeUsage),
  };
}

// ------------------------------------------------------------- corpus rollup

export interface Totals extends FixtureMetrics {
  compared: number;
  verdict: number;
  exact: number;
  setMatch: number;
  versionMismatch: number;
}

const ZERO: Totals = {
  compared: 0,
  verdict: 0,
  exact: 0,
  setMatch: 0,
  versionMismatch: 0,
  tsMessages: 0,
  tsWithLine: 0,
  javaMessages: 0,
  javaWithLine: 0,
  pairable: 0,
  lineComparable: 0,
  lineMatch: 0,
  severityMatch: 0,
};

export function accumulate(rows: readonly Comparison[]): Totals {
  const t: Totals = { ...ZERO };
  for (const r of rows) {
    t.compared++;
    if (r.verdictMatch) t.verdict++;
    if (r.exact) t.exact++;
    if (r.setMatch) t.setMatch++;
    if (!r.versionMatch) t.versionMismatch++;
    t.tsMessages += r.metrics.tsMessages;
    t.tsWithLine += r.metrics.tsWithLine;
    t.javaMessages += r.metrics.javaMessages;
    t.javaWithLine += r.metrics.javaWithLine;
    t.pairable += r.metrics.pairable;
    t.lineComparable += r.metrics.lineComparable;
    t.lineMatch += r.metrics.lineMatch;
    t.severityMatch += r.metrics.severityMatch;
  }
  return t;
}

/** `n/d` as a percentage, or `n/a` when the denominator is zero. */
export function pct(n: number, d: number): string {
  return d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`;
}

/**
 * Which message IDs drive the remaining disagreement. PROJECT_STATUS's "next
 * up" list is ordered by exactly this, and it was previously recomputed by hand.
 */
export function idHistogram(rows: readonly Comparison[]): {
  onlyTs: [string, number][];
  onlyJava: [string, number][];
} {
  const count = (pick: (r: Comparison) => string[]): [string, number][] => {
    const tallies = new Map<string, number>();
    for (const row of rows) {
      for (const entry of pick(row)) {
        // Entries are `RSC-005` or `RSC-005 x3`; the multiplier is occurrences.
        const [id = entry, times] = entry.split(' x');
        tallies.set(id, (tallies.get(id) ?? 0) + (times ? Number(times) : 1));
      }
    }
    return [...tallies].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
  };
  return { onlyTs: count((r) => r.onlyTs), onlyJava: count((r) => r.onlyJava) };
}
