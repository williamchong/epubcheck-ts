/**
 * Shared types for the parity harness, plus a validating parser for Java
 * EPUBCheck's JSON report.
 *
 * The parser matters more than it looks. Java's report reaches us two ways --
 * fresh off a subprocess pipe, or out of the on-disk cache -- and both can be
 * truncated (a clipped `maxBuffer`, a run killed mid-write). An unchecked
 * `JSON.parse` turns that into `undefined` reads deep inside the comparison,
 * which surface as a "validator crash" against the wrong file. Validating at
 * the boundary keeps a bad report a bad report.
 */

/**
 * Thrown for "this run cannot produce a valid measurement" -- a bad flag, a
 * missing tool, an oracle that does not look like the one we calibrated
 * against. The CLI maps it to exit 2, and the per-fixture error handler
 * rethrows it rather than turning it into a crash row: a misconfiguration
 * should stop the run once, not be reported 763 times as fixture failures.
 */
export class ParityUsageError extends Error {}

/** Severities EPUBCheck emits. Anything else is a version skew worth failing on. */
export const SEVERITIES = ['FATAL', 'ERROR', 'WARNING', 'INFO', 'USAGE', 'SUPPRESSED'] as const;

export type Severity = (typeof SEVERITIES)[number];

const SEVERITY_SET = new Set<string>(SEVERITIES);

export interface Counts {
  fatal: number;
  error: number;
  warning: number;
  info: number;
  usage: number;
}

/** One message, normalized to the shape both engines are compared in. */
export interface ParityMessage {
  id: string;
  severity: Severity;
  path: string | null;
  line: number | null;
  message: string;
}

/** The normalized result of running either engine over one input. */
export interface EngineResult {
  valid: boolean;
  counts: Counts;
  version: string | null;
  messages: ParityMessage[];
}

/**
 * How an input is fed to the validator. A directory is an expanded EPUB, a file
 * whose extension names a standalone content type is single-file, anything else
 * is a zipped publication.
 */
export type InputKind = 'expanded' | 'single' | 'zipped';

export interface ResolvedInput {
  kind: InputKind;
  /** EPUBCheck mode (`exp`, `xhtml`, `opf`, ...). Absent for a plain zipped EPUB. */
  mode: string | undefined;
}

/** Options that change what either engine emits, and therefore the cache key. */
export interface RunOptions {
  version: string | undefined;
  profile: string | undefined;
  mode: string | undefined;
}

// ------------------------------------------------------- Java report parsing

interface JavaLocation {
  path?: string | null;
  line?: number | null;
}

interface JavaMessage {
  ID: string;
  severity: string;
  message: string;
  locations?: JavaLocation[] | null;
}

export interface JavaReport {
  checker: {
    nFatal: number;
    nError: number;
    nWarning: number;
    nInfo?: number;
    nUsage: number;
  };
  publication?: { ePubVersion?: string | null } | null;
  messages: JavaMessage[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isJavaMessage(value: unknown): value is JavaMessage {
  if (!isRecord(value)) return false;
  if (typeof value.ID !== 'string') return false;
  if (typeof value.message !== 'string') return false;
  // Severity is validated rather than widened: an unrecognised one means the
  // Java CLI on PATH is not the baseline this harness was calibrated against,
  // and silently bucketing it would quietly skew every percentage.
  return typeof value.severity === 'string' && SEVERITY_SET.has(value.severity.toUpperCase());
}

/**
 * Validate an already-parsed report. Exported so the on-disk cache, which has
 * necessarily parsed its entry already, can reach the guard without
 * re-serializing a multi-megabyte object just to hand it back to a string API.
 */
export function isJavaReport(value: unknown): value is JavaReport {
  if (!isRecord(value)) return false;
  const { checker, messages } = value;
  if (!isRecord(checker)) return false;
  for (const field of ['nFatal', 'nError', 'nWarning', 'nUsage']) {
    if (typeof checker[field] !== 'number') return false;
  }
  return Array.isArray(messages) && messages.every(isJavaMessage);
}

/**
 * Parse and validate a Java EPUBCheck JSON report.
 *
 * `source` names where the bytes came from (a path, or the CLI) so a failure
 * points at the file to delete rather than at the fixture being measured.
 */
export function parseJavaReport(raw: string, source: string): JavaReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`${source}: not valid JSON (${detail}) -- likely a truncated report`);
  }
  if (!isJavaReport(parsed)) {
    throw new Error(`${source}: JSON is not an EPUBCheck report (missing checker/messages)`);
  }
  return parsed;
}

/** Narrow a severity string, failing loudly on anything unrecognised. */
export function toSeverity(raw: string, source: string): Severity {
  const upper = raw.toUpperCase();
  // Fatal rather than per-fixture: an unknown severity means the engine on PATH
  // is not the one these percentages were calibrated against, so every figure
  // the run would go on to print is meaningless.
  if (!SEVERITY_SET.has(upper)) throw new ParityUsageError(`${source}: unknown severity ${raw}`);
  return upper as Severity;
}
