/**
 * Tests for boundary-check.ts
 * Run: npx tsx src/__tests__/boundary-check.test.ts
 */

import { strict as assert } from 'node:assert';
import {
  getChangedFilesFromDiff,
  checkBoundaryViolations,
  formatBoundaryViolationComment,
} from '../boundary-check.js';

// ── getChangedFilesFromDiff ──────────────────────────────────

const sampleDiff = `diff --git a/src/app/page.tsx b/src/app/page.tsx
index 1234567..abcdefg 100644
--- a/src/app/page.tsx
+++ b/src/app/page.tsx
@@ -1,5 +1,5 @@
 import React from 'react';
-export default function Home() {
+export default function HomePage() {
   return <div>Hello</div>;
 }
diff --git a/amplify/functions/handler.ts b/amplify/functions/handler.ts
index 1111111..2222222 100644
--- a/amplify/functions/handler.ts
+++ b/amplify/functions/handler.ts
@@ -1 +1 @@
-export const handler = () => {};
+export const handler = async () => {};
diff --git a/README.md b/README.md
index 3333333..4444444 100644
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-# Old
+# New
`;

const files = getChangedFilesFromDiff(sampleDiff);
assert.deepEqual(files.sort(), [
  'README.md',
  'amplify/functions/handler.ts',
  'src/app/page.tsx',
]);
console.log('✓ getChangedFilesFromDiff — standard diff');

// Rename detection
const renameDiff = `diff --git a/src/old-name.tsx b/src/new-name.tsx
similarity index 95%
rename from src/old-name.tsx
rename to src/new-name.tsx
`;
const renameFiles = getChangedFilesFromDiff(renameDiff);
assert.ok(renameFiles.includes('src/old-name.tsx'), 'includes old name');
assert.ok(renameFiles.includes('src/new-name.tsx'), 'includes new name');
console.log('✓ getChangedFilesFromDiff — rename detection');

// Empty diff
assert.deepEqual(getChangedFilesFromDiff(''), []);
console.log('✓ getChangedFilesFromDiff — empty diff');

// ── checkBoundaryViolations ──────────────────────────────────

// Frontend agent: only src/** and next.config.ts
const frontendPaths = ['src/**', 'next.config.ts'];

// No violations — all files within bounds
assert.deepEqual(
  checkBoundaryViolations(['src/app/page.tsx', 'src/components/Button.tsx'], frontendPaths),
  [],
);
console.log('✓ checkBoundaryViolations — no violations');

// Violation — amplify file not in frontend paths
assert.deepEqual(
  checkBoundaryViolations(
    ['src/app/page.tsx', 'amplify/functions/handler.ts', 'README.md'],
    frontendPaths,
  ),
  ['amplify/functions/handler.ts', 'README.md'],
);
console.log('✓ checkBoundaryViolations — detects violations');

// Exact file match
assert.deepEqual(
  checkBoundaryViolations(['next.config.ts'], frontendPaths),
  [],
);
console.log('✓ checkBoundaryViolations — exact file match');

// Backend agent with nested globs
const backendPaths = ['amplify/functions/**', 'amplify/data/**', 'amplify/shared/**'];
assert.deepEqual(
  checkBoundaryViolations(
    ['amplify/functions/handler.ts', 'amplify/data/schema.ts'],
    backendPaths,
  ),
  [],
);
assert.deepEqual(
  checkBoundaryViolations(
    ['amplify/functions/handler.ts', 'src/app/page.tsx'],
    backendPaths,
  ),
  ['src/app/page.tsx'],
);
console.log('✓ checkBoundaryViolations — backend agent paths');

// QA agent with ** prefix patterns
const qaPaths = ['tests/**', '**/*.test.ts', '**/*.spec.ts'];
assert.deepEqual(
  checkBoundaryViolations(
    ['tests/unit/foo.ts', 'src/lib/auth.test.ts', 'amplify/shared/utils.spec.ts'],
    qaPaths,
  ),
  [],
);
assert.deepEqual(
  checkBoundaryViolations(
    ['tests/unit/foo.ts', 'src/lib/auth.ts'],
    qaPaths,
  ),
  ['src/lib/auth.ts'],
);
console.log('✓ checkBoundaryViolations — QA agent ** prefix patterns');

// Empty ownedPaths = allow all
assert.deepEqual(
  checkBoundaryViolations(['anything/goes.ts'], []),
  [],
);
console.log('✓ checkBoundaryViolations — empty ownedPaths allows all');

// ── formatBoundaryViolationComment ───────────────────────────

const comment = formatBoundaryViolationComment(
  'frontend',
  ['amplify/functions/handler.ts', 'README.md'],
  frontendPaths,
);
assert.ok(comment.includes('Boundary Violation'));
assert.ok(comment.includes('amplify/functions/handler.ts'));
assert.ok(comment.includes('src/**'));
console.log('✓ formatBoundaryViolationComment — format correct');

// ── All passed ───────────────────────────────────────────────
console.log('\n✅ All boundary-check tests passed.');
