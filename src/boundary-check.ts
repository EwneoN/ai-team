/**
 * Post-execution boundary check for agent PRs.
 *
 * Validates that an agent's PR only modifies files within its declared
 * ownedPaths globs. This provides a hard enforcement layer on top of the
 * prompt-based ownership boundaries.
 */

import { minimatch } from 'minimatch';

/**
 * Extract changed file paths from a unified diff (gh pr diff output).
 * Parses `diff --git a/path b/path` and `--- a/path` / `+++ b/path` headers.
 */
export function getChangedFilesFromDiff(diff: string): string[] {
  const files = new Set<string>();

  // Match "diff --git a/<path> b/<path>" lines
  const diffHeaderRegex = /^diff --git a\/(.+?) b\/(.+?)$/gm;
  let match: RegExpExecArray | null;

  while ((match = diffHeaderRegex.exec(diff)) !== null) {
    // Both a-side and b-side paths — captures renames
    files.add(match[1]);
    files.add(match[2]);
  }

  return [...files];
}

/**
 * Check which files violate the agent's owned path boundaries.
 *
 * @param changedFiles - File paths from the PR diff (repo-relative, forward slashes)
 * @param ownedPaths - Glob patterns from the agent's config (e.g. "src/**", "amplify/functions/**")
 * @returns Array of file paths that don't match any owned path glob. Empty = no violations.
 */
export function checkBoundaryViolations(
  changedFiles: string[],
  ownedPaths: string[],
): string[] {
  if (ownedPaths.length === 0) return []; // No boundaries defined — allow all

  const violations: string[] = [];

  for (const file of changedFiles) {
    const allowed = ownedPaths.some((pattern) =>
      minimatch(file, pattern, { dot: true }),
    );
    if (!allowed) {
      violations.push(file);
    }
  }

  return violations;
}

/**
 * Format boundary violations into a markdown comment for posting on the PR.
 */
export function formatBoundaryViolationComment(
  agentKey: string,
  violations: string[],
  ownedPaths: string[],
): string {
  const fileList = violations.map((f) => `- \`${f}\``).join('\n');
  const patternList = ownedPaths.map((p) => `- \`${p}\``).join('\n');

  return [
    '## ⛔ Boundary Violation Detected',
    '',
    `Agent **${agentKey}** modified files outside its declared ownership boundaries.`,
    '',
    '### Unauthorized files modified:',
    fileList,
    '',
    '### Allowed path patterns:',
    patternList,
    '',
    'This PR has been flagged for human review. The agent cannot proceed until the boundary violation is resolved.',
    '',
    '> To override, manually approve and merge the PR.',
  ].join('\n');
}
