/**
 * Git and GitHub CLI helpers.
 * Wraps common git and gh operations.
 */

import { execFileSafe, writeUtf8, ensureDir } from './helpers.js';
import { getLogsDir, getSignalsDir } from './config.js';
import { join, relative } from 'node:path';
import { unlinkSync } from 'node:fs';

// ── Cached API helpers ───────────────────────────────────────

interface RawReviewComment {
  id: number;
  in_reply_to_id?: number;
  user: { login: string };
  path: string;
  body: string;
  line: number | null;
  created_at?: string;
}

const reviewCommentCache = new Map<number, RawReviewComment[]>();
let cachedLogin: string | null = null;

/**
 * Fetch all review comments for a PR with pagination, cached per PR number
 * for the lifetime of the process. Both findStatusReply() and
 * getCopilotReviewComments() use this to avoid redundant API calls.
 */
function fetchAllPRReviewComments(prNumber: number): RawReviewComment[] {
  const cached = reviewCommentCache.get(prNumber);
  if (cached) return cached;

  const { code, stdout } = execFileSafe(
    'gh', ['api', '--paginate', '--slurp', `repos/{owner}/{repo}/pulls/${prNumber}/comments`],
  );
  if (code !== 0 || !stdout) return [];

  try {
    // --slurp wraps each page's array in an outer array: [[page1...], [page2...]]
    const pages = JSON.parse(stdout) as RawReviewComment[] | RawReviewComment[][];
    const flat = Array.isArray(pages[0]) ? (pages as RawReviewComment[][]).flat() : pages as RawReviewComment[];
    reviewCommentCache.set(prNumber, flat);
    return flat;
  } catch {
    return [];
  }
}

/**
 * Invalidate the review comment cache for a PR. Call after posting a new
 * review comment so subsequent lookups see the new reply. Edits to existing
 * comments do not require invalidation since they don't change structural
 * fields (id, in_reply_to_id, author) used by findStatusReply().
 */
export function invalidateReviewCommentCache(prNumber: number): void {
  reviewCommentCache.delete(prNumber);
}

/**
 * Get the authenticated user's login, cached for the process lifetime.
 */
function getAuthenticatedLogin(): string | null {
  if (cachedLogin) return cachedLogin;
  const { code, stdout } = execFileSafe(
    'gh', ['api', 'user', '--jq', '.login'],
  );
  if (code !== 0 || !stdout?.trim()) return null;
  cachedLogin = stdout.trim();
  return cachedLogin;
}

/**
 * Get the current branch name in a directory.
 */
export function getCurrentBranch(cwd: string): string {
  const { code, stdout } = execFileSafe('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  if (code !== 0) throw new Error(`git rev-parse failed in ${cwd}`);
  return stdout;
}

/**
 * Checkout a branch in a directory. Returns true on success.
 * Falls back to creating a local tracking branch from origin if the branch
 * doesn't exist locally (common after a fetch).
 * Stashes uncommitted changes (from a previous agent run) if they block checkout.
 */
export function checkoutBranch(branch: string, cwd: string): boolean {
  const { code } = execFileSafe('git', ['checkout', branch, '--quiet'], { cwd });
  if (code === 0) return true;

  // Stash any dirty working tree left by a prior agent on a different branch
  const { code: stashCode } = execFileSafe('git', ['stash', '--quiet'], { cwd });
  const stashed = stashCode === 0;

  // Try checkout again (may exist locally now after stash freed dirty files)
  const { code: retryCode } = execFileSafe('git', ['checkout', branch, '--quiet'], { cwd });
  if (retryCode === 0) {
    if (stashed) execFileSafe('git', ['stash', 'drop', '--quiet'], { cwd });
    return true;
  }

  // Local branch doesn't exist — try creating from origin
  const { code: trackCode } = execFileSafe(
    'git', ['checkout', '-b', branch, `origin/${branch}`, '--quiet'], { cwd },
  );
  if (trackCode === 0) {
    if (stashed) execFileSafe('git', ['stash', 'drop', '--quiet'], { cwd });
    return true;
  }

  // Restore stash if all attempts failed
  if (stashed) execFileSafe('git', ['stash', 'pop', '--quiet'], { cwd });
  return false;
}

/**
 * Create a branch from a base. Returns true on success.
 */
export function createBranch(branch: string, base: string, cwd: string): boolean {
  const { code } = execFileSafe('git', ['checkout', '-b', branch, `origin/${base}`, '--quiet'], { cwd });
  return code === 0;
}

/**
 * Push a branch to origin. Returns true on success.
 */
export function pushBranch(branch: string, cwd: string): boolean {
  const { code } = execFileSafe('git', ['push', '-u', 'origin', branch, '--quiet'], { cwd });
  return code === 0;
}

/**
 * Revert specific files in the working directory to their state on the base branch.
 * Used to auto-revert boundary-violating files from an agent's PR branch.
 * Commits the revert and pushes. Returns true on success.
 */
export function revertBoundaryFiles(
  files: string[],
  baseBranch: string,
  agentBranch: string,
  cwd: string,
): boolean {
  // Ensure we're on the right branch and have latest
  fetchOrigin(cwd);
  const branch = getCurrentBranch(cwd);
  if (branch !== agentBranch) {
    checkoutBranch(agentBranch, cwd);
  }

  // Revert each violating file to its state on the base branch
  for (const file of files) {
    const { code } = execFileSafe('git', ['checkout', `origin/${baseBranch}`, '--', file], { cwd });
    if (code !== 0) {
      // File may not exist on base branch (newly added) — remove it
      execFileSafe('git', ['rm', '-f', '--', file], { cwd });
    }
  }

  // Stage only the reverted files (not everything in the workspace)
  execFileSafe('git', ['add', '--', ...files], { cwd });
  const { code: commitCode } = execFileSafe(
    'git',
    ['commit', '-m', `revert: auto-revert ${files.length} boundary-violating file(s)\n\nReverted: ${files.join(', ')}\n\nAgent boundary enforcement — these files are outside this agent's owned paths.`],
    { cwd },
  );
  if (commitCode !== 0) return false;

  return pushBranch(agentBranch, cwd);
}

/**
 * Pull latest from origin for a branch.
 */
export function pullBranch(branch: string, cwd: string): boolean {
  const { code } = execFileSafe('git', ['pull', 'origin', branch, '--quiet'], { cwd });
  return code === 0;
}

/**
 * Merge origin/{batchBranch} into the currently checked-out branch.
 * Assumes origin has already been fetched. Returns true on success.
 */
export function mergeBatchBranch(batchBranch: string, cwd: string): boolean {
  const { code } = execFileSafe('git', ['merge', `origin/${batchBranch}`, '--no-edit'], { cwd });
  return code === 0;
}

/**
 * Stage, commit, and push signal files. Returns true if successful or
 * if there was nothing to commit. Returns false on error.
 */
export function commitAndPushSignals(cwd: string): boolean {
  // Stage signal files — compute relative path from cwd to signals dir
  const signalsDir = getSignalsDir();
  const stagePath = relative(cwd, signalsDir) || '.';
  const { code: addCode } = execFileSafe('git', ['add', stagePath], { cwd });
  if (addCode !== 0) return false;

  // Check if there are staged changes
  const { code: diffCode } = execFileSafe('git', ['diff', '--cached', '--quiet'], { cwd });
  if (diffCode === 0) return true; // nothing to commit

  // Commit
  const { code: commitCode } = execFileSafe(
    'git', ['commit', '-m', 'chore: update orchestrator signals [skip ci]'], { cwd },
  );
  if (commitCode !== 0) return false;

  // Push
  const { code: pushCode } = execFileSafe('git', ['push', 'origin', 'HEAD', '--quiet'], { cwd });
  return pushCode === 0;
}

/**
 * Commit and push all .ai-team/ housekeeping changes (signals, archived logs,
 * deleted state files) after a batch completes.
 */
export function commitBatchHousekeeping(batchName: string, cwd: string): boolean {
  const projectDir = join(getSignalsDir(), '..');
  const stagePath = relative(cwd, projectDir) || '.';

  // Stage all changes under .ai-team/
  const { code: addCode } = execFileSafe('git', ['add', stagePath], { cwd });
  if (addCode !== 0) return false;

  // Check if there are staged changes
  const { code: diffCode } = execFileSafe('git', ['diff', '--cached', '--quiet'], { cwd });
  if (diffCode === 0) return true; // nothing to commit

  const { code: commitCode } = execFileSafe(
    'git', ['commit', '-m', `chore: batch ${batchName} housekeeping [skip ci]`], { cwd },
  );
  if (commitCode !== 0) return false;

  const { code: pushCode } = execFileSafe('git', ['push', 'origin', 'HEAD', '--quiet'], { cwd });
  return pushCode === 0;
}

/**
 * Check if a branch exists on origin.
 * Note: `git ls-remote` exits 0 even when no matching ref is found,
 * so we must check stdout for actual output.
 */
export function remoteBranchExists(branch: string, cwd: string): boolean {
  const { code, stdout } = execFileSafe('git', ['ls-remote', '--heads', 'origin', branch], { cwd });
  return code === 0 && stdout.trim().length > 0;
}

/**
 * Fetch from origin.
 */
export function fetchOrigin(cwd: string): boolean {
  const { code } = execFileSafe('git', ['fetch', 'origin', '--prune', '--quiet'], { cwd });
  return code === 0;
}

/**
 * Delete a remote branch on origin. Returns true on success, false if the
 * branch doesn't exist or the delete fails (best-effort).
 */
export function deleteRemoteBranch(branch: string): boolean {
  const { code } = execFileSafe('git', ['push', 'origin', '--delete', branch]);
  return code === 0;
}

/**
 * Delete a local branch (force). Returns true on success, false if the
 * branch doesn't exist or can't be deleted (best-effort).
 */
export function deleteLocalBranch(branch: string, cwd?: string): boolean {
  const { code } = execFileSafe('git', ['branch', '-D', branch], cwd ? { cwd } : undefined);
  return code === 0;
}

// ── GitHub CLI wrappers ──────────────────────────────────────

/**
 * Get the diff for a PR. Returns the diff text or null on failure.
 */
export function getPRDiff(prNumber: number): string | null {
  const { code, stdout } = execFileSafe('gh', ['pr', 'diff', String(prNumber)]);
  if (code !== 0) return null;
  return stdout;
}

/**
 * Get the list of files changed in the latest commit on a PR.
 * Used by the severity filter to distinguish "code the agent just touched"
 * from "code that hasn't changed since the previous cycle".
 * Returns an empty array on failure.
 */
export function getLatestPRCommitFiles(prNumber: number): string[] {
  // Get the SHA of the latest commit on the PR
  const { code: prCode, stdout: prStdout } = execFileSafe(
    'gh', ['pr', 'view', String(prNumber), '--json', 'commits', '--jq', '.commits[-1].oid'],
  );
  if (prCode !== 0 || !prStdout?.trim()) return [];

  const sha = prStdout.trim();

  // Get files changed in that commit
  const { code, stdout } = execFileSafe(
    'gh', ['api', `repos/{owner}/{repo}/commits/${sha}`, '--jq', '.files[].filename'],
  );
  if (code !== 0 || !stdout) return [];

  return stdout.trim().split('\n').filter(Boolean);
}

/**
 * Get PR metadata (title, body). Returns null on failure.
 */
export function getPRMetadata(prNumber: number): { title: string; body: string } | null {
  const { code, stdout } = execFileSafe('gh', ['pr', 'view', String(prNumber), '--json', 'title,body']);
  if (code !== 0 || !stdout) return null;
  try {
    const data = JSON.parse(stdout) as { title: string; body: string };
    return data;
  } catch {
    return null;
  }
}

/**
 * Get PR review comments. Returns array of comment texts.
 */
export function getPRReviewComments(prNumber: number): string[] {
  const { code, stdout } = execFileSafe('gh', ['pr', 'view', String(prNumber), '--json', 'reviews,comments']);
  if (code !== 0 || !stdout) return [];
  try {
    const data = JSON.parse(stdout) as {
      reviews?: Array<{ state: string; body: string }>;
      comments?: Array<{ body: string }>;
    };
    const parts: string[] = [];
    for (const review of data.reviews ?? []) {
      if (review.body) {
        parts.push(`**Review (${review.state}):**\n${review.body}`);
      }
    }
    for (const comment of data.comments ?? []) {
      if (comment.body) {
        parts.push(`**Comment:**\n${comment.body}`);
      }
    }
    return parts;
  } catch {
    return [];
  }
}

/**
 * Post a comment on a PR. Uses a temp file to avoid shell escaping issues.
 */
export function postPRComment(prNumber: number, body: string): boolean {
  const tmpFile = join(getLogsDir(), `pr-comment-${prNumber}-${Date.now()}.md`);
  ensureDir(getLogsDir());
  writeUtf8(tmpFile, body);
  try {
    const { code } = execFileSafe('gh', ['pr', 'comment', String(prNumber), '--body-file', tmpFile]);
    try {
      unlinkSync(tmpFile);
    } catch { /* ignore cleanup errors */ }
    return code === 0;
  } catch {
    return false;
  }
}

/**
 * Merge a PR and delete the branch. Returns true on success.
 */
export function mergePR(prNumber: number): boolean {
  const { code } = execFileSafe('gh', ['pr', 'merge', String(prNumber), '--merge', '--delete-branch']);
  return code === 0;
}

/**
 * Get the state of a PR: OPEN, MERGED, or CLOSED.
 */
export function getPRState(prNumber: number): 'OPEN' | 'MERGED' | 'CLOSED' | null {
  const { code, stdout } = execFileSafe('gh', ['pr', 'view', String(prNumber), '--json', 'state', '--jq', '.state']);
  if (code !== 0) return null;
  const state = stdout.trim() as 'OPEN' | 'MERGED' | 'CLOSED';
  return ['OPEN', 'MERGED', 'CLOSED'].includes(state) ? state : null;
}

/**
 * Create a PR via gh CLI. Returns the PR number and URL, or null on failure.
 * Uses a temp file for the body to avoid shell escaping issues.
 */
export function createPR(opts: {
  base: string;
  head: string;
  title: string;
  body: string;
}): { number: number; url: string } | null {
  const tmpFile = join(getLogsDir(), `pr-body-${Date.now()}.md`);
  ensureDir(getLogsDir());
  writeUtf8(tmpFile, opts.body);
  try {
    const { code, stdout, stderr } = execFileSafe(
      'gh', ['pr', 'create', '--base', opts.base, '--head', opts.head, '--title', opts.title, '--body-file', tmpFile],
    );
    try { unlinkSync(tmpFile); } catch { /* ignore cleanup */ }

    if (code !== 0 || !stdout.trim()) {
      // If a PR already exists for this head branch, try to find it
      if (stderr.includes('already exists')) {
        const existing = execFileSafe('gh', ['pr', 'view', opts.head, '--json', 'number,url']);
        if (existing.code === 0) {
          try {
            const data = JSON.parse(existing.stdout) as { number: number; url: string };
            console.log(`  ℹ PR already exists (#${data.number}) — reusing.`);
            return { number: data.number, url: data.url };
          } catch { /* fall through */ }
        }
      }
      console.error(`  gh pr create failed (exit ${code}): ${stderr || stdout || '(no output)'}`);
      return null;
    }

    const url = stdout.trim();
    const match = url.match(/\/pull\/(\d+)/);
    if (!match) return null;
    return { number: parseInt(match[1], 10), url };
  } catch (err) {
    try { unlinkSync(tmpFile); } catch { /* ignore cleanup */ }
    console.error(`  gh pr create threw: ${err}`);
    return null;
  }
}

export interface PRCheckResult {
  name: string;
  state: string;
  bucket: string;
}

/**
 * Get the CI check statuses for a PR. Returns null on failure.
 *
 * `gh pr checks --json` exposes `state` (e.g. SUCCESS, FAILURE, PENDING)
 * and `bucket` (pass, fail, pending) — there is no `conclusion` field.
 */
export function getPRChecks(prNumber: number): PRCheckResult[] | null {
  const { code, stdout } = execFileSafe(
    'gh', ['pr', 'checks', String(prNumber), '--json', 'name,state,bucket'],
  );
  if (code !== 0) return null;
  try {
    return JSON.parse(stdout.trim()) as PRCheckResult[];
  } catch {
    return null;
  }
}

// ── GitHub Copilot review helpers ────────────────────────────

/**
 * Add GitHub Copilot as a reviewer on a PR.
 * If Copilot has already submitted a review, remove the reviewer first
 * then re-add so GitHub re-triggers a fresh review on the latest code.
 * (Dismiss doesn't work on COMMENTED reviews, so remove+add is the workaround.)
 * Returns true on success.
 */
export function requestCopilotReview(prNumber: number): boolean {
  // Remove Copilot as reviewer first (no-op if not currently requested).
  // This ensures --add-reviewer below actually triggers a new review
  // even if Copilot already submitted one on an earlier commit.
  execFileSafe(
    'gh', ['api', `repos/{owner}/{repo}/pulls/${prNumber}/requested_reviewers`, '-X', 'DELETE', '-f', 'reviewers[]=copilot-pull-request-reviewer'],
  );

  const { code } = execFileSafe('gh', ['pr', 'edit', String(prNumber), '--add-reviewer', 'copilot-pull-request-reviewer']);
  return code === 0;
}

export type CopilotReviewState = 'PENDING' | 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'NOT_FOUND';

export interface CopilotReviewResult {
  state: CopilotReviewState;
  body: string;
  comments: Array<{ id?: number; path: string; body: string; line: number | null }>;
}

/**
 * Check if Copilot has submitted a review on a PR.
 * Returns the review state and feedback, or null if no Copilot review exists yet.
 *
 * @param afterTimestamp — If provided, only consider reviews submitted AFTER this
 *   ISO-8601 timestamp. This prevents stale reviews from previous cycles being
 *   mistaken for the response to a freshly-requested review.
 */
export function getCopilotReview(prNumber: number, afterTimestamp?: string): CopilotReviewResult | null | 'api-error' {
  // Use REST API directly to get review IDs (gh pr view doesn't expose them)
  const { code, stdout } = execFileSafe(
    'gh', ['api', `repos/{owner}/{repo}/pulls/${prNumber}/reviews?per_page=100`, '--paginate'],
  );
  if (code !== 0 || !stdout) return 'api-error';

  // Also check for pending review requests
  const { code: reqCode, stdout: reqOut } = execFileSafe(
    'gh', ['pr', 'view', String(prNumber), '--json', 'reviewRequests', '--jq', '.reviewRequests'],
  );

  try {
    const reviews = JSON.parse(stdout) as Array<{
      id: number;
      user: { login: string };
      state: string;
      body: string;
      submitted_at?: string;
    }>;

    const COPILOT_LOGINS = new Set(['copilot-pull-request-reviewer', 'copilot-pull-request-reviewer[bot]', 'Copilot', 'copilot']);

    // Find Copilot reviews, optionally filtering to only those after our request time
    const afterMs = afterTimestamp ? new Date(afterTimestamp).getTime() : 0;
    const copilotReviews = reviews.filter((r) => {
      if (!COPILOT_LOGINS.has(r.user.login)) return false;
      if (afterTimestamp && r.submitted_at) {
        return new Date(r.submitted_at).getTime() > afterMs;
      }
      return !afterTimestamp;
    });

    if (copilotReviews.length === 0) {
      // No new reviews yet — check if a review request is still pending
      if (reqCode === 0 && reqOut) {
        // Review requests data available but no matching reviews — still waiting
        void reqOut;
      }
      return null; // Still waiting
    }

    // Prefer the latest review that has inline comments. When multiple reviews
    // qualify (e.g. a real review with comments + a later re-review with none),
    // the one with comments is the actionable one. Fall back to the latest if
    // no reviews have comments (genuine clean approval).
    // Also invalidate the general comment cache so findStatusReply() sees fresh data
    invalidateReviewCommentCache(prNumber);

    let chosen: typeof copilotReviews[number] | null = null;
    let chosenComments: Array<{ id?: number; path: string; body: string; line: number | null }> = [];

    // Walk from newest to oldest — pick the first review that has comments
    for (let i = copilotReviews.length - 1; i >= 0; i--) {
      const review = copilotReviews[i]!;
      const comments = getReviewComments(prNumber, review.id);
      if (comments.length > 0) {
        chosen = review;
        chosenComments = comments;
        break;
      }
    }

    // If no review has comments, use the latest (genuine clean review or propagation delay)
    if (!chosen) {
      chosen = copilotReviews[copilotReviews.length - 1]!;
    }

    // Map GitHub's review states
    let state: CopilotReviewState;
    switch (chosen.state) {
      case 'APPROVED':
        state = 'APPROVED';
        break;
      case 'CHANGES_REQUESTED':
        state = 'CHANGES_REQUESTED';
        break;
      case 'COMMENTED':
        state = 'COMMENTED';
        break;
      case 'DISMISSED':
        state = 'DISMISSED';
        break;
      default:
        state = 'PENDING';
    }

    // Guard against API propagation delay: review exists but comments haven't
    // propagated yet. Return null to trigger a re-poll rather than false-approving.
    // Copilot's review body says "generated N comments" — if N > 0 but we found 0,
    // it's a propagation delay. If the body says "no comments" or "no new comments",
    // it's a genuine clean review.
    if (state === 'COMMENTED' && chosenComments.length === 0) {
      const bodyClaimsComments = /generated \d+ comment/i.test(chosen.body ?? '');
      if (bodyClaimsComments) {
        console.log(`  ℹ Copilot review on PR #${prNumber} claims comments in body but 0 found via API — treating as pending (API propagation delay)`);
        return null;
      }
    }

    return { state, body: chosen.body ?? '', comments: chosenComments };
  } catch {
    return 'api-error';
  }
}

/**
 * Get inline comments for a specific review via the review-specific endpoint.
 * Uses `GET /repos/{owner}/{repo}/pulls/{pr}/reviews/{review_id}/comments`
 * which returns only comments from that review — no pagination needed for
 * typical Copilot reviews (< 30 comments), and no timestamp filtering needed.
 */
function getReviewComments(prNumber: number, reviewId: number): Array<{ id?: number; path: string; body: string; line: number | null }> {
  const { code, stdout } = execFileSafe(
    'gh', ['api', `repos/{owner}/{repo}/pulls/${prNumber}/reviews/${reviewId}/comments?per_page=100`, '--paginate'],
  );
  if (code !== 0 || !stdout) return [];

  try {
    const raw = JSON.parse(stdout) as Array<{
      id: number;
      path: string;
      body: string;
      line: number | null;
      in_reply_to_id?: number;
    }>;
    // Only include top-level comments, not replies (which have in_reply_to_id)
    return raw
      .filter((c) => !c.in_reply_to_id)
      .map((c) => ({ id: c.id, path: c.path, body: c.body, line: c.line }));
  } catch {
    return [];
  }
}

// ── PR Review Thread Resolution ──────────────────────────────

/**
 * Resolve all open review threads on a PR.
 *
 * Uses the GitHub GraphQL API to fetch all review threads and resolve
 * any that are still unresolved. This keeps the PR clean after an agent
 * has addressed Copilot's feedback — the human can see at a glance that
 * every comment has been actioned.
 *
 * Returns the number of threads resolved (0 if none or on error).
 */
export function resolveAllPRReviewThreads(prNumber: number): number {
  // Step 1: Get the PR's node ID
  const { code: idCode, stdout: idOut } = execFileSafe(
    'gh', ['api', 'graphql', '-f', `query={ repository(owner:"{owner}", name:"{repo}") { pullRequest(number: ${prNumber}) { id } } }`, '--jq', '.data.repository.pullRequest.id'],
  );
  if (idCode !== 0 || !idOut?.trim()) return 0;

  const prNodeId = idOut.trim();

  // Step 2: Fetch all review threads (paginated — PRs with many reviews can exceed 100 threads)
  const threads: Array<{ id: string; isResolved: boolean }> = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const afterClause = cursor ? `, after: "${cursor}"` : '';
    const { code: threadCode, stdout: threadOut } = execFileSafe(
      'gh', ['api', 'graphql', '-f', `query={ node(id: "${prNodeId}") { ... on PullRequest { reviewThreads(first: 100${afterClause}) { nodes { id isResolved } pageInfo { hasNextPage endCursor } } } } }`, '--jq', '.data.node.reviewThreads'],
    );
    if (threadCode !== 0 || !threadOut?.trim()) break;

    try {
      const result = JSON.parse(threadOut.trim()) as {
        nodes: Array<{ id: string; isResolved: boolean }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
      threads.push(...result.nodes);
      if (!result.pageInfo.hasNextPage) break;
      cursor = result.pageInfo.endCursor;
    } catch {
      break;
    }
  }
  if (threads.length === 0) return 0;

  const unresolved = threads.filter((t) => !t.isResolved);
  if (unresolved.length === 0) return 0;

  // Step 3: Resolve each unresolved thread
  let resolved = 0;
  for (const thread of unresolved) {
    const { code } = execFileSafe(
      'gh', ['api', 'graphql', '-f', `query=mutation { resolveReviewThread(input: { threadId: "${thread.id}" }) { thread { isResolved } } }`],
    );
    if (code === 0) resolved++;
  }

  return resolved;
}

/**
 * Format Copilot review feedback into a markdown string suitable for agent consumption.
 */
export function formatCopilotFeedback(review: CopilotReviewResult): string {
  const lines: string[] = [
    '# GitHub Copilot Review Feedback',
    '',
    `**Verdict:** ${review.state}`,
    '',
  ];

  if (review.body) {
    lines.push('## Summary', '', review.body, '');
  }

  if (review.comments.length > 0) {
    lines.push('## Inline Comments', '');
    lines.push(`There are **${review.comments.length}** comments. You MUST address every one.`, '');
    for (let i = 0; i < review.comments.length; i++) {
      const c = review.comments[i]!;
      const lineRef = c.line ? ` (line ${c.line})` : '';
      const commentIdRef = c.id ? ` [comment-id:${c.id}]` : '';
      lines.push(`### Comment ${i + 1} of ${review.comments.length}: ${c.path}${lineRef}${commentIdRef}`, '', c.body, '');
    }
  }

  return lines.join('\n');
}

// ── Comment status tracking helpers ──────────────────────────

/**
 * Post a threaded reply to a review comment on a PR.
 * Uses the GitHub REST API with `in_reply_to` to create a threaded response.
 * Returns the new comment's ID, or null on failure.
 */
export function replyToReviewComment(prNumber: number, inReplyToId: number, body: string): number | null {
  const tmpFile = join(getLogsDir(), `pr-reply-${prNumber}-${Date.now()}.md`);
  ensureDir(getLogsDir());
  writeUtf8(tmpFile, body);
  try {
    const { code, stdout } = execFileSafe(
      'gh', [
        'api', `repos/{owner}/{repo}/pulls/${prNumber}/comments`,
        '-X', 'POST',
        '-F', `body=@${tmpFile}`,
        '-F', `in_reply_to=${inReplyToId}`,
        '--jq', '.id',
      ],
    );
    try { unlinkSync(tmpFile); } catch { /* ignore cleanup */ }
    if (code !== 0 || !stdout) return null;
    const id = parseInt(stdout.trim(), 10);
    return Number.isFinite(id) ? id : null;
  } catch {
    try { unlinkSync(tmpFile); } catch { /* ignore cleanup */ }
    return null;
  }
}

/**
 * Edit an existing review comment on a PR.
 * Uses the GitHub REST API PATCH endpoint.
 * Returns true on success.
 */
export function editReviewComment(commentId: number, body: string): boolean {
  const tmpFile = join(getLogsDir(), `pr-edit-${commentId}-${Date.now()}.md`);
  ensureDir(getLogsDir());
  writeUtf8(tmpFile, body);
  try {
    const { code } = execFileSafe(
      'gh', [
        'api', `repos/{owner}/{repo}/pulls/comments/${commentId}`,
        '-X', 'PATCH',
        '-F', `body=@${tmpFile}`,
      ],
    );
    try { unlinkSync(tmpFile); } catch { /* ignore cleanup */ }
    return code === 0;
  } catch {
    try { unlinkSync(tmpFile); } catch { /* ignore cleanup */ }
    return false;
  }
}

/**
 * Find our bot's existing status reply to a specific review comment.
 * Searches all replies in the PR review comment thread for one authored
 * by the current authenticated user (the bot running the CLI).
 * Returns the reply's ID and body, or null if not found.
 */
export function findStatusReply(prNumber: number, originalCommentId: number): { id: number; body: string } | null {
  const myLogin = getAuthenticatedLogin();
  if (!myLogin) return null;

  const comments = fetchAllPRReviewComments(prNumber);
  if (comments.length === 0) return null;

  // Find all replies to the original comment authored by us
  const matches = comments.filter(
    (c) => c.in_reply_to_id === originalCommentId && c.user.login === myLogin,
  );

  if (matches.length === 0) return null;

  if (matches.length > 1) {
    console.warn(
      `findStatusReply: ${matches.length} matching replies for PR #${prNumber}, comment ${originalCommentId}. Using newest.`,
    );
  }

  // Pick the newest reply (highest ID) to avoid editing a stale one
  const newest = matches.reduce((a, b) => (b.id > a.id ? b : a));
  return { id: newest.id, body: newest.body };
}
