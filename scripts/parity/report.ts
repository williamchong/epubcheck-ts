/**
 * Terminal rendering for a corpus run, shared by `npm run parity` and the agent
 * driver under `.claude/skills/`.
 *
 * Both CLIs previously carried their own copy of this. They had already drifted
 * -- one printed the location metrics and the ID histogram, the other did not --
 * which is the failure mode that matters here: two tools reporting the same run
 * differently, with no signal about which one is missing something.
 */

import { type Comparison, type Totals, accumulate, idHistogram, pct } from './compare.js';
import { type CompareRow, type Row, isFailed, partition } from './corpus.js';

export const GREY = '\x1b[90m';
export const RED = '\x1b[31m';
export const YELLOW = '\x1b[33m';
export const GREEN = '\x1b[32m';
export const OFF = '\x1b[0m';

/** Which severities a run counted; every figure below depends on it. */
export type Scope = 'err+warn' | 'all sev';

export const scopeOf = (includeUsage: boolean): Scope => (includeUsage ? 'all sev' : 'err+warn');

export function printDisagreements(rows: readonly Row[]): void {
  for (const row of rows) {
    if (isFailed(row)) {
      const { name, code, message } = row.failed;
      const label = [name, code].filter(Boolean).join('/');
      console.log(`${RED}CRASH${OFF}  ${row.file}  ${label}: ${message.split('\n')[0] ?? ''}`);
      continue;
    }
    const { cmp } = row;
    if (cmp.exact && cmp.versionMatch) continue;
    const bits: string[] = [];
    if (cmp.onlyTs.length) bits.push(`+ts ${cmp.onlyTs.join(',')}`);
    if (cmp.onlyJava.length) bits.push(`+java ${cmp.onlyJava.join(',')}`);
    if (!cmp.versionMatch) {
      bits.push(`version ts=${cmp.tsVersion ?? 'none'} java=${cmp.javaVersion ?? 'none'}`);
    }
    const flag = cmp.verdictMatch ? `${YELLOW}DIFF ${OFF}` : `${RED}VERDICT${OFF}`;
    console.log(`${flag} ${row.file}  ${GREY}${bits.join('  ')}${OFF}`);
  }
}

const metricLine = (label: string, n: number, d: number): string =>
  `${label.padEnd(26)}${pct(n, d).padStart(6)}  ${GREY}(${String(n)}/${String(d)})${OFF}`;

export function printTotals(rows: readonly Row[], cacheSummary: string, scope: Scope): void {
  const { ok, failed } = partition(rows);
  const t = accumulate(ok.map((r) => r.cmp));

  console.log(
    `\n${String(ok.length)} compared, ${String(failed.length)} crashed  ` +
      `${GREY}${cacheSummary}${OFF}`,
  );
  console.log(metricLine('verdict agreement', t.verdict, t.compared));
  console.log(metricLine(`message-ID set (${scope})`, t.setMatch, t.compared));
  console.log(metricLine(`IDs + counts (${scope})`, t.exact, t.compared));
  console.log(metricLine('severity agreement', t.severityMatch, t.pairable));
  console.log(metricLine('line present (ts)', t.tsWithLine, t.tsMessages));
  console.log(metricLine('line present (java)', t.javaWithLine, t.javaMessages));
  console.log(metricLine('line agreement', t.lineMatch, t.lineComparable));
  if (t.versionMismatch) {
    console.log(`${YELLOW}version family differs on ${String(t.versionMismatch)} fixtures${OFF}`);
  }

  const hist = idHistogram(ok.map((r) => r.cmp));
  const top = (entries: [string, number][]): string =>
    entries
      .slice(0, 6)
      .map(([id, n]) => `${id} (${String(n)})`)
      .join(', ') || 'none';
  console.log(`\n${GREY}top false positives (ts only): ${top(hist.onlyTs)}${OFF}`);
  console.log(`${GREY}top gaps (java only):          ${top(hist.onlyJava)}${OFF}`);
}

export function printJson(rows: readonly Row[]): void {
  const { ok } = partition(rows);
  console.log(JSON.stringify({ totals: accumulate(ok.map((r) => r.cmp)), rows }, null, 2));
}

/** One row of the per-mode standalone table. */
export function printBreakdown(
  header: string,
  groups: readonly { label: string; rows: readonly CompareRow[] }[],
): void {
  const row = (label: string, t: Totals): string =>
    `${label.padEnd(10)}${String(t.compared).padStart(6)}` +
    `${pct(t.exact, t.compared).padStart(9)}${pct(t.verdict, t.compared).padStart(10)}`;

  console.log(
    `\n${header.padEnd(10)}${'n'.padStart(6)}${'exact'.padStart(9)}${'verdict'.padStart(10)}`,
  );
  const all: Comparison[] = [];
  for (const group of groups) {
    const cmps = group.rows.map((r) => r.cmp);
    all.push(...cmps);
    console.log(row(group.label, accumulate(cmps)));
  }
  console.log(row('total', accumulate(all)));
}
