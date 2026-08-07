# Contributing to epubcheck-ts

See [README.md](./README.md) for project overview, architecture, and commands.

**Java reference**: `../epubcheck` (sibling directory)

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/likecoin/epubcheck-ts.git`
3. Install dependencies: `npm install`
4. Create a branch: `git checkout -b feature/your-feature-name`

---

## Coding Standards

### TypeScript
- **Strict mode** - no `any`, explicit return types on public APIs
- **ESM imports** - use `.js` extensions, `import type` for types only
- **Naming**: kebab-case files, PascalCase classes/types, camelCase functions, UPPER_SNAKE_CASE constants

```typescript
// Good
import type { ValidationMessage } from './types.js';
import { Report } from './core/report.js';

// Bad
import { ValidationMessage } from './types';  // Missing .js and type
```

### Message IDs
Use same IDs as Java EPUBCheck (PKG-*, OPF-*, CSS-*, HTM-*, NAV-*, NCX-*, RSC-*, ACC-*, MED-*).

Use the message registry for automatic severity lookup:

```typescript
import { MessageId, pushMessage } from '../messages/index.js';

pushMessage(context.messages, {
  id: MessageId.PKG_006,
  message: 'Mimetype file must be uncompressed',
  location: { path: 'mimetype' },
});

// Suppressed messages are automatically filtered out
// Use severityOverride only when needed (e.g., context-dependent severity)
```

The message registry (`src/messages/messages.ts`, re-exported via `src/messages/index.ts`) maps all message IDs to their default severities, matching Java EPUBCheck's `DefaultSeverities.java` exactly.

### Commit Messages

- `feat: add OPF metadata validation`
- `fix: handle empty mimetype file`
- `docs: update API documentation`
- `test: add tests for ZIP reader`
- `refactor: simplify validation context`
- `chore: update dependencies`

---

## Testing

- Co-locate unit tests: `foo.ts` → `foo.test.ts` (or `test/unit/`)
- Integration tests: `test/integration/`
- Use Vitest with globals

```typescript
import { describe, it, expect } from 'vitest';

describe('ZipReader', () => {
  it('should read mimetype file', async () => {
    const zip = await ZipReader.open(data);
    expect(zip.readText('mimetype')).toBe('application/epub+zip');
  });
});
```

### E2E / Integration Tests (Critical Rules)
- **E2E tests imported from Java EPUBCheck are the source of truth.** They define the expected validation behaviour.
- **Never modify e2e test expectations** to make them pass. If a test fails, fix the implementation, not the test.
- **Use `it.skip`** only for features that are pending/unimplemented. Skipped tests are a backlog, not a workaround.
- **The only exception** for changing e2e test behaviour vs the original Java test is when a behavioural mismatch is caused by an inherent limitation in our TypeScript dependencies (e.g., libxml2-wasm XPath, fflate ZIP deduplication, css-tree forgiving parsing). In that case, document the reason in the skip annotation and in `PROJECT_STATUS.md`.

### Parity Testing (the differential)

The suite cannot see the two failure modes that matter most: a scenario ported with a subtly wrong expectation passes forever, and a check that fires where Java stays silent breaks no test at all. The harness in `scripts/parity/` catches both by running Java EPUBCheck over the same bytes and diffing.

```bash
npm run parity          # measure the packaged corpus
npm run parity:check    # fail if any fixture regressed against the baseline
npm run parity:update   # rewrite the baseline after an intended change
```

- **If your change moves parity, `npm run parity:update` belongs in the same commit.** The diff to `test/parity/baseline.json` is the evidence; a reviewer can see which fixtures moved and in which direction.
- **`parity:check` fails only on regressions**, never on improvements — it tells you to run `parity:update` instead.
- **Java's answers are committed** under `test/parity/java/`, keyed by content, so the gate needs no JVM and a warm run takes seconds. Editing a fixture invalidates its entry automatically; you need Java on PATH only to re-measure what changed.
- **Never hand-edit `test/parity/`.** Both the baseline and the cache are generated; editing either fakes the measurement the gate exists to make.

---

## Porting from Java

1. **Verify against Java implementation** - Always cross-reference the Java source (`../epubcheck`) when implementing or fixing validation logic. The Java implementation is the reference; any new logic or logic fix must produce the same validation results for the same inputs.
2. **Use TypeScript idioms** - don't translate Java patterns directly
3. **Preserve message IDs** - compatibility matters

```java
// Java
if (!mimetype.equals("application/epub+zip")) {
    report.message(MessageId.PKG_007, ...);
}
```

```typescript
// TypeScript
const mimetype = context.files.get('mimetype');
if (mimetype !== 'application/epub+zip') {
  context.messages.push({
    id: 'PKG-007',
    severity: 'error',
    message: 'Mimetype file must contain "application/epub+zip"',
    location: { path: 'mimetype' },
  });
}
```

---

## Common Tasks

### Adding a Validator
1. Create `src/module/validator.ts`
2. Implement validation logic
3. Add to pipeline in `checker.ts`
4. Add tests
5. Update exports

### Adding a Message ID
1. Add to `src/messages/messages.ts` (contains both IDs and severities)
2. Match severity from Java's `DefaultSeverities.java`
3. Reference Java EPUBCheck for consistency

### Adding Schemas
1. Add to `schemas/` directory
2. Run `npm run generate:schemas`
3. Schemas auto-compressed with gzip, lazy-loaded at runtime

---

## Critical Implementation Notes

### libxml2-wasm Memory Management
Always dispose resources:

```typescript
const doc = XmlDocument.fromString(xml);
try {
  // Use doc
} finally {
  doc.dispose();  // Critical!
}
```

### Browser Compatibility
- Use `Uint8Array`, not `Buffer`
- Avoid Node.js-specific APIs (`fs`, `path`)
- Test in both Node.js and browsers

### Performance
- Lazy load WASM (~1.5MB)
- Cache schema validators
- Stream large files when possible

---

## What to Update

`PROJECT_STATUS.md` is the **only file** that tracks volatile status. Update it when:

- **New feature implemented** → Move from "Not Implemented" / "Partially Implemented" to "Fully Implemented". Update the overview completion percentages. Unskip any e2e tests that now pass.
- **New e2e/integration tests ported** → Update the "E2E Test Coverage vs Java" table and test count totals.
- **Bug fix or logic change** → If it resolves a known issue or unblocks skipped tests, update "Known Issues" and "Skipped Tests" sections.
- **New message ID added** → Update the "Message IDs" counts.
- **New dependency limitation discovered** → Add to "Known Issues" with affected test references.
- **Agreement with Java moved** → Re-run `npm run parity` and update the "Measured Parity" tables from its output. Commit the regenerated `test/parity/baseline.json` alongside. Quote measured figures, never estimates.

Do **not** duplicate status information in other docs.

---

## Pull Request Process

1. Ensure all tests pass
2. Run `npm run parity:check`; if it reports improvements, commit a regenerated baseline
3. Update `PROJECT_STATUS.md` if applicable (see above)
4. Add a clear description of changes
5. Reference any related issues
