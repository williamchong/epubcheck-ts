---
name: run-epubcheck-ts
description: Build, run, test, and drive epubcheck-ts. Use when asked to run epubcheck-ts, validate an EPUB with it, start or exercise the CLI, run its tests, or compare its output against Java EPUBCheck.
---

`epubcheck-ts` is a library + CLI — a TypeScript port of Java EPUBCheck. There
is no server and no UI; "running it" means validating an EPUB and reading the
messages it emits.

Drive it with `.claude/skills/run-epubcheck-ts/driver.mjs`, which runs the
validator straight out of `src/` (no build step) and can diff the result
against the Java `epubcheck` CLI — the comparison every parity number in
`PROJECT_STATUS.md` is measured with.

All paths below are relative to the repo root.

## Prerequisites

Node (repo pins 22 in `.nvmrc`; verified here on v24.15.0) and the Java
EPUBCheck CLI, which `diff`/`corpus` shell out to:

```bash
epubcheck --version   # → EPUBCheck v5.3.0
```

If it is missing, `brew install epubcheck` puts it on PATH. `check` works
without it; `diff` and `corpus` exit 2 with a message naming the fix.

## Setup

```bash
npm ci      # ~4s
```

That is the whole setup. The RelaxNG/Schematron schemas under `schemas/` are
committed (56 files), so there is no codegen step.

## Run (agent path)

```bash
npx tsx .claude/skills/run-epubcheck-ts/driver.mjs <command> [paths...] [flags]
```

| command | what it does |
|---|---|
| `check <path...>` | Validate via `src/`. One line per message: `SEVERITY  ID  path:line  message`. Exits 1 if any input is invalid. |
| `diff <path...>` | Run this library **and** Java EPUBCheck on the same input, diff the message IDs. Parallel across paths (`--jobs`). Exits 1 on any mismatch. |
| `corpus <dir>` | Batch `diff` over every `.epub` below `<dir>`; prints per-file disagreements then verdict/exact agreement percentages. Exits 1 if any fixture crashed. |
| `cli <args...>` | Run the built CLI from `bin/epubcheck.js` (needs `npm run build` first). Its tail is forwarded verbatim, so the built CLI's own flags work; its exit code is propagated. |

Exit codes: `0` clean, `1` a real result (invalid EPUB / mismatch / crash), `2`
you invoked it wrong (unknown flag, missing path, no Java CLI, missing build).

| flag | effect |
|---|---|
| `-u`, `--usage` | Include USAGE messages — **and** widen `diff` to compare every severity, not just FATAL/ERROR/WARNING. |
| `--dist` | Import the built `dist/` bundle instead of `src/`. Use to confirm a change survives tsup. |
| `--json` | Machine-readable output. |
| `--version <v>` | EPUB version (`2.0`, `3.0`, `3.3`, …). |
| `--profile <p>` | `default` \| `dict` \| `edupub` \| `idx` \| `preview`. |
| `--mode <m>` | `exp` \| `opf` \| `xhtml` \| `svg` \| `nav` \| `mo`. Inferred from the extension when omitted; passing it explicitly forces single-file handling, which is the only way to reach `nav` (an ordinary `.xhtml`). |
| `--jobs <n>` | `diff`/`corpus` concurrency (default 4 — measured best on this machine; 8 was not faster). |
| `--limit <n>` | `corpus`: stop after N fixtures. |

The path selects the entry point, so you do not have to: a **directory** is an
expanded EPUB (`validateExpanded`), a file whose extension names a standalone
content type — `.xhtml`/`.html`/`.svg`/`.opf`/`.smil` — goes to
`validateSingleFile`, and anything else is a zipped publication (`validate`).
An explicit `--mode` overrides the guess. All three were exercised:

```bash
npx tsx .claude/skills/run-epubcheck-ts/driver.mjs check test/fixtures/valid/style-valid.epub
# → VALID  0 fatal / 0 error / 0 warning / 0 info / 0 usage

npx tsx .claude/skills/run-epubcheck-ts/driver.mjs check \
  test/fixtures/invalid/mediaoverlays/mediaoverlays-text-reading-order-error.epub -u
# → USAGE  OPF-097  EPUB/package.opf:13  Resource declared in manifest but not referenced: …
#   USAGE  MED-015  EPUB/content_001.smil:13  Media overlay text must be in reading order; …
#   VALID  0 fatal / 0 error / 0 warning / 0 info / 3 usage
```

### The differential is the main event

Most changes here are validator internals, and the question is always "does
this now agree with Java?" `diff` answers it directly:

```bash
npx tsx .claude/skills/run-epubcheck-ts/driver.mjs diff test/fixtures/invalid/content/id-duplicate-error.epub
# → ts   INVALID  {"fatal":0,"error":2,"warning":0,"info":0,"usage":0}
#   java INVALID  {"fatal":0,"error":1,"warning":0,"info":0,"usage":0}
#   only ts:   RSC-005
```

Over a directory, with agreement percentages in the same shape the commit
messages quote:

```bash
npx tsx .claude/skills/run-epubcheck-ts/driver.mjs corpus test/fixtures/invalid --jobs 8 --limit 80
# → DIFF  test/fixtures/invalid/content/content-css-syntax-error.epub  +java CSS-008
#   VERDICT test/fixtures/invalid/content/foreignObject-html-invalid-error-svg.epub  +java RSC-005
#   …
#   80 compared, 0 crashed
#   verdict agreement      98.8%  (79/80)
#   error/warning ID exact 71.3%  (57/80)
```

Java costs ~1.5s per book, so a `corpus` run is the slow one — 80 fixtures at
`--jobs 8` took ~60s. `test/fixtures` holds 763 `.epub` files; budget ~10min
for the whole thing, or use `--limit`.

## Run (human path)

```bash
npm run build                       # tsup → dist/ + bin/epubcheck.js
node bin/epubcheck.js book.epub     # → ✓ Valid EPUB / error listing
```

Exit code is 0 when valid, 1 on errors. `node bin/epubcheck.js --help` lists
the flags.

## Test

```bash
npm run test:run        # ~2s, no build needed — PROJECT_STATUS.md has the current pass/skip counts
npm run typecheck
npm run lint
npm run format
```

The packaging suite is separate and **does** need a build; it is what
`prepublishOnly` runs:

```bash
npm run build && npm run test:packaging   # 3 passed
```

`test/integration/real-world.test.ts` validates 5 Project Gutenberg books
cached under `test/fixtures/real/` (gitignored). It skips itself when the
cache is absent:

```bash
npm run fetch:real-epubs   # → 0 downloaded, 5 already cached
```

## Gotchas

- **Most fixtures look clean until you pass `-u`.** USAGE-severity messages
  are suppressed by default, and a large share of the `invalid/` fixtures
  assert a USAGE message. `mediaoverlays-text-reading-order-error.epub`
  reports nothing at all without `-u`; the integration test that covers it
  passes `{ includeUsage: true }`. If a fixture "produces no messages,"
  re-run with `-u` before concluding anything.
- **Java writes IDs with an underscore, this port uses a hyphen** — `MED_015`
  vs `MED-015`. The driver normalises to the hyphen form; any hand-rolled
  comparison has to do the same or every ID will look like a mismatch.
- **`diff` ignores USAGE/INFO by default, on purpose.** The headline agreement
  metric counts FATAL/ERROR/WARNING only, matching `PROJECT_STATUS.md`. That
  means real differences hide: the mediaoverlays fixture above reports
  `identical` until you add `-u`, which then surfaces `only ts: OPF-097 x2`.
  Debugging a specific message → always pass `-u`.
- **"EPUB version" means two different things across the two tools.** This
  library reports the version the OPF *declares* (`3.0`); Java reports the
  ruleset it *applied* (`3.3`). They never match exactly on an EPUB 3 book, so
  `diff` compares only the major version — enough to catch the real bug (an
  OEBPS 1.2 package checked as EPUB 3, which 0.6.3 fixed) without flagging
  every file.
- **Java exits 1 when it finds errors**, which `execFile` raises as a failure
  even though the JSON report is sitting on stdout. The driver reads it off
  the error object; a naive `execFile` wrapper loses every invalid file.
- **Java refuses a non-`.epub` input without `--mode`**, and every mode but
  `exp` also needs `-v`. The driver infers both from the path.
- **`npx tsx -e '<script>'` cannot be used to poke the library** — tsx emits
  CJS for `-e` and the entry chain has a top-level `await`, so it dies with
  *"Top-level await is currently not supported with the cjs output format."*
  Write a `.mts` file and run `npx tsx file.mts` instead. This is also why
  `dist/index.cjs` lazy-loads `libxml2-wasm`.
- **`.gitignore` excludes `.claude/*`**, and this skill is tracked only via
  the `!.claude/skills/` negation below it. The pattern is `.claude/*` rather
  than `.claude/` precisely because git will not re-include anything under an
  excluded *directory*. A new file under `.claude/` outside `skills/` is
  silently untracked.
- **`eslint.config.js` ignores `.claude/`.** Without it `npm run lint` fails
  on this driver with *"was not found by the project service"* — the config
  is `strictTypeChecked` and demands a tsconfig project for every file it
  parses. Biome is the opposite: `npm run format` **does** reformat the
  driver (95 files, not 94), so run it after editing. Pointing biome at the
  path directly reports "Checked 0 files" — only the recursive run sees it.

## Troubleshooting

- **`Error: EISDIR: illegal operation on a directory, read`** — you pointed a
  raw `readFile` at a fixture *directory*. `test/fixtures/invalid/` holds
  subdirectories, not `.epub` files; the actual files are one level down
  (`find test/fixtures/invalid -name '*.epub'`). The driver handles
  directories as expanded EPUBs, so this only bites hand-written scripts.
- **`Cannot find module .../dist/index.js` (`MODULE_NOT_FOUND`)** — `dist/`
  and `bin/epubcheck.js` are both build output and both gitignored. Run
  `npm run build`. The driver's `cli` and `--dist` paths check for this and
  exit 2 with the fix instead.
- **`the Java epubcheck CLI is not on PATH`** — `diff`/`corpus` shell out to
  it. `brew install epubcheck`, or use `check`, which is pure TypeScript.
