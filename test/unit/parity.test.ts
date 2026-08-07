/**
 * Tests for the parity harness itself.
 *
 * The harness is what CI gates on and what every figure in PROJECT_STATUS is
 * measured with, so a silent bug here is worse than a silent bug in a
 * validator: it does not make a check wrong, it makes every check *unverifiable*
 * while still printing a confident percentage. Both failures reproduced below
 * were real, and neither was visible in the output — a path-keyed cache serving
 * stale answers, and a location metric pinned at 100%.
 */

import { describe, expect, it } from 'vitest';
import { JavaCache, digestBytes, digestTree } from '../../scripts/parity/cache.js';
import { compare } from '../../scripts/parity/compare.js';
import type { EngineResult, ParityMessage, Severity } from '../../scripts/parity/types.js';

const cache = (version = 'EPUBCheck v5.3.0'): JavaCache => new JavaCache('/tmp/unused', version);

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('JavaCache.key', () => {
  const base = () => cache().key('test/fixtures/a.epub', ['--json', '-', '-u'], 'digest-a');

  it('is stable for identical inputs', () => {
    expect(base()).toBe(base());
  });

  it('changes when the fixture contents change', () => {
    // The bug this exists to prevent: an earlier harness keyed on the path
    // alone, so rewriting a fixture's bytes silently reused the old answer.
    const other = cache().key('test/fixtures/a.epub', ['--json', '-', '-u'], 'digest-b');
    expect(other).not.toBe(base());
  });

  it('changes when the path changes but the bytes do not', () => {
    // Java's standalone modes are addressed by basename, so the name really
    // does change the output even for identical bytes.
    const other = cache().key('test/fixtures/b.epub', ['--json', '-', '-u'], 'digest-a');
    expect(other).not.toBe(base());
  });

  it('changes when the Java version changes', () => {
    const other = cache('EPUBCheck v5.4.0').key(
      'test/fixtures/a.epub',
      ['--json', '-', '-u'],
      'digest-a',
    );
    expect(other).not.toBe(base());
  });

  it('changes when the Java argv changes', () => {
    const other = cache().key(
      'test/fixtures/a.epub',
      ['--json', '-', '-u', '--profile', 'dict'],
      'digest-a',
    );
    expect(other).not.toBe(base());
  });

  it('does not confuse field boundaries', () => {
    // Fields are length-prefixed, not delimiter-joined: without that, a value
    // containing the separator could make two different inputs collide.
    const a = cache().key('ab', ['c'], 'd');
    const b = cache().key('a', ['bc'], 'd');
    expect(a).not.toBe(b);
  });
});

describe('digestTree', () => {
  it('ignores insertion order', () => {
    const one = new Map([
      ['a.txt', bytes('A')],
      ['b.txt', bytes('B')],
    ]);
    const two = new Map([
      ['b.txt', bytes('B')],
      ['a.txt', bytes('A')],
    ]);
    expect(digestTree(one)).toBe(digestTree(two));
  });

  it('distinguishes a rename between same-sized files', () => {
    const one = new Map([['a.txt', bytes('A')]]);
    const two = new Map([['b.txt', bytes('A')]]);
    expect(digestTree(one)).not.toBe(digestTree(two));
  });

  it('distinguishes content', () => {
    expect(digestBytes(bytes('A'))).not.toBe(digestBytes(bytes('B')));
  });
});

// ------------------------------------------------------------------- compare

const msg = (
  id: string,
  severity: Severity = 'ERROR',
  path: string | null = 'EPUB/x.xhtml',
  line: number | null = 1,
): ParityMessage => ({ id, severity, path, line, message: id });

const result = (messages: ParityMessage[], valid = false): EngineResult => ({
  valid,
  counts: { fatal: 0, error: messages.length, warning: 0, info: 0, usage: 0 },
  version: '3.0',
  messages,
});

describe('compare', () => {
  it('separates ID-set agreement from count agreement', () => {
    // The distinction PROJECT_STATUS publishes as two different rows: finding
    // the same problems, versus reporting them the same number of times.
    const ts = result([msg('RSC-005'), msg('RSC-005', 'ERROR', 'EPUB/x.xhtml', 9)]);
    const java = result([msg('RSC-005')]);
    const cmp = compare(ts, java, false);

    expect(cmp.setMatch).toBe(true);
    expect(cmp.exact).toBe(false);
    expect(cmp.onlyTs).toEqual(['RSC-005']);
  });

  it('reports exact agreement when IDs and counts both match', () => {
    const cmp = compare(result([msg('OPF-003')]), result([msg('OPF-003')]), false);
    expect(cmp.exact).toBe(true);
    expect(cmp.setMatch).toBe(true);
    expect(cmp.onlyTs).toEqual([]);
    expect(cmp.onlyJava).toEqual([]);
  });

  it('excludes USAGE from the default scope and includes it under includeUsage', () => {
    const ts = result([msg('RSC-005'), msg('OPF-097', 'USAGE')]);
    const java = result([msg('RSC-005')]);

    expect(compare(ts, java, false).exact).toBe(true);
    expect(compare(ts, java, true).exact).toBe(false);
  });

  it('does not count an absent line as a located message', () => {
    // Java encodes "no line" as -1, normalized to null upstream. Counting it as
    // a location pins the metric at 100%, which is not a measurement.
    const ts = result([msg('RSC-005', 'ERROR', 'EPUB/x.xhtml', null)]);
    const java = result([msg('RSC-005', 'ERROR', 'EPUB/x.xhtml', null)]);
    const cmp = compare(ts, java, false);

    expect(cmp.metrics.tsWithLine).toBe(0);
    expect(cmp.metrics.javaWithLine).toBe(0);
    expect(cmp.metrics.lineComparable).toBe(0);
  });

  it('pairs repeated IDs by line rather than by emission order', () => {
    const ts = result([
      msg('RSC-005', 'ERROR', 'EPUB/x.xhtml', 40),
      msg('RSC-005', 'ERROR', 'EPUB/x.xhtml', 10),
    ]);
    const java = result([
      msg('RSC-005', 'ERROR', 'EPUB/x.xhtml', 10),
      msg('RSC-005', 'ERROR', 'EPUB/x.xhtml', 40),
    ]);
    const cmp = compare(ts, java, false);

    expect(cmp.metrics.pairable).toBe(2);
    expect(cmp.metrics.lineMatch).toBe(2);
  });

  it('treats an absent version as not comparable rather than as a mismatch', () => {
    // Java reports no version for a standalone file; comparing against that
    // would flag all 1286 single-file fixtures.
    const ts = { ...result([]), version: '3.0' };
    const java = { ...result([]), version: null };
    expect(compare(ts, java, false).versionMatch).toBe(true);
  });

  it('still catches a real version-family mismatch', () => {
    const ts = { ...result([]), version: '2.0' };
    const java = { ...result([]), version: '3.3' };
    expect(compare(ts, java, false).versionMatch).toBe(false);
  });

  it('reports a verdict disagreement independently of message IDs', () => {
    const cmp = compare(result([msg('RSC-005')], true), result([msg('RSC-005')], false), false);
    expect(cmp.exact).toBe(true);
    expect(cmp.verdictMatch).toBe(false);
  });
});
