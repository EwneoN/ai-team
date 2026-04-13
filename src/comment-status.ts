/**
 * Comment status tracking — emoji-based status replies on PR review comments.
 *
 * The orchestrator and co-agents post threaded reply comments on each review
 * comment to indicate processing status:
 *   👀 Seen → 🧠 Reviewed → 🛠️/❌ Will Fix / Won't Fix → ✅/☑️ Fixed / Skipped
 *
 * Each original comment gets a single reply that is edited in-place as status
 * progresses, keeping PR threads clean.
 */

import { replyToReviewComment, editReviewComment, findStatusReply, invalidateReviewCommentCache } from './git.js';
import { agentLog } from './logger.js';
import type { CommentStatus, CommentReactionState, OrchAgentState } from './types.js';

// ── Emoji map ────────────────────────────────────────────────

const EMOJI_MAP: Record<CommentStatus, string> = {
  'seen': '👀',
  'reviewed': '🧠',
  'will-fix': '🛠️',
  'wont-fix': '❌',
  'fixed': '✅',
  'skipped': '☑️',
};

const STATUS_LABELS: Partial<Record<CommentStatus, string>> = {
  'wont-fix': "Won't fix",
  'skipped': 'Skipped',
};

// ── Status reply formatting ──────────────────────────────────

/**
 * Format the evolving status reply body from a list of statuses.
 *
 * Example outputs:
 *   👀
 *   👀 ➜ 🧠
 *   👀 ➜ 🧠 ➜ 🛠️ ➜ ✅
 *   👀 ➜ 🧠 ➜ ❌ Won't fix
 *
 *   **Reason:** Already handled by existing validation.
 *
 *   *backend · cycle 3*
 */
export function formatStatusReply(
  statuses: CommentStatus[],
  agentKey: string,
  cycle: number,
  reason?: string,
): string {
  if (statuses.length === 0) return '';

  const lastStatus = statuses[statuses.length - 1]!;
  const emojiChain = statuses.map((s) => EMOJI_MAP[s]).join(' ➜ ');

  const label = STATUS_LABELS[lastStatus];
  const statusLine = label ? `${emojiChain} ${label}` : emojiChain;

  const lines = [statusLine];

  if (reason && (lastStatus === 'wont-fix' || lastStatus === 'skipped')) {
    lines.push('', `**Reason:** ${reason}`);
  }

  lines.push('', `*${agentKey} · cycle ${cycle}*`);

  return lines.join('\n');
}

// ── State helpers ────────────────────────────────────────────

function getOrCreateReaction(
  agentState: OrchAgentState,
  commentId: number,
): CommentReactionState {
  if (!agentState.commentReactions) {
    agentState.commentReactions = [];
  }

  let reaction = agentState.commentReactions.find(
    (r) => r.originalCommentId === commentId,
  );

  if (!reaction) {
    reaction = {
      originalCommentId: commentId,
      replyCommentId: null,
      currentStatus: 'seen',
      statusHistory: [],
    };
    agentState.commentReactions.push(reaction);
  }

  return reaction;
}

function addStatusTransition(reaction: CommentReactionState, status: CommentStatus): void {
  reaction.currentStatus = status;
  reaction.statusHistory.push({
    status,
    timestamp: new Date().toISOString(),
  });
}

function getStatusChain(reaction: CommentReactionState): CommentStatus[] {
  return reaction.statusHistory.map((h) => h.status);
}

// ── Core status update functions ─────────────────────────────

/**
 * Post or edit the status reply with a new status.
 * Creates a threaded reply on first call, edits the existing reply thereafter.
 */
function updateStatusReply(
  prNumber: number,
  commentId: number,
  reaction: CommentReactionState,
  agentKey: string,
  cycle: number,
  reason?: string,
): boolean {
  const effectiveReason = reason ?? reaction.reason;
  const body = formatStatusReply(getStatusChain(reaction), agentKey, cycle, effectiveReason);

  if (reaction.replyCommentId) {
    // Edit existing reply
    return editReviewComment(reaction.replyCommentId, body);
  }

  // Check if we already have a reply from a previous run (state was lost)
  const existing = findStatusReply(prNumber, commentId);
  if (existing) {
    const updated = editReviewComment(existing.id, body);
    if (updated) {
      reaction.replyCommentId = existing.id;
    }
    return updated;
  }

  // Create new threaded reply
  const replyId = replyToReviewComment(prNumber, commentId, body);
  if (replyId) {
    reaction.replyCommentId = replyId;
    // Invalidate cache since we added a new comment
    invalidateReviewCommentCache(prNumber);
    return true;
  }

  return false;
}

/**
 * Mark a comment as seen (👀). Called by the orchestrator when it first reads
 * review comments from a PR.
 */
export function markCommentSeen(
  prNumber: number,
  commentId: number,
  agentKey: string,
  cycle: number,
  agentState: OrchAgentState,
): void {
  const reaction = getOrCreateReaction(agentState, commentId);

  // Only add the 'seen' transition once, but still attempt the reply
  // if it failed previously (replyCommentId will be null)
  if (reaction.statusHistory.length === 0) {
    addStatusTransition(reaction, 'seen');
  }

  // Skip if the reply was already successfully posted
  if (reaction.replyCommentId) return;

  if (!updateStatusReply(prNumber, commentId, reaction, agentKey, cycle)) {
    agentLog(agentKey, `Failed to post status reply for comment ${commentId}`, 'WARN');
  }
}

/**
 * Mark a comment as reviewed (🧠). Called by the orchestrator after it has
 * analyzed the review and is about to dispatch a fix agent.
 */
export function markCommentReviewed(
  prNumber: number,
  commentId: number,
  agentKey: string,
  cycle: number,
  agentState: OrchAgentState,
): void {
  const reaction = getOrCreateReaction(agentState, commentId);

  // Ensure 'seen' is in the chain first
  if (reaction.statusHistory.length === 0) {
    addStatusTransition(reaction, 'seen');
  }

  // Don't duplicate 'reviewed' if already in the chain
  const statuses = getStatusChain(reaction);
  if (!statuses.includes('reviewed')) {
    addStatusTransition(reaction, 'reviewed');
  } else {
    // Already reviewed — only retry the reply if it wasn't posted yet
    if (reaction.replyCommentId) return;
  }

  if (!updateStatusReply(prNumber, commentId, reaction, agentKey, cycle)) {
    agentLog(agentKey, `Failed to update status reply for comment ${commentId}`, 'WARN');
  }
}

/**
 * Mark a comment with a final outcome. Called after the co-agent completes
 * and reports back via comment-outcomes.json.
 */
export function markCommentOutcome(
  prNumber: number,
  commentId: number,
  outcome: 'will-fix' | 'wont-fix' | 'fixed' | 'skipped',
  agentKey: string,
  cycle: number,
  agentState: OrchAgentState,
  reason?: string,
): void {
  const reaction = getOrCreateReaction(agentState, commentId);

  // Ensure prerequisite statuses are in the chain
  const statuses = getStatusChain(reaction);
  if (!statuses.includes('seen')) addStatusTransition(reaction, 'seen');
  if (!statuses.includes('reviewed')) addStatusTransition(reaction, 'reviewed');

  // For 'fixed', add 'will-fix' first if not already present
  if (outcome === 'fixed' && !statuses.includes('will-fix')) {
    addStatusTransition(reaction, 'will-fix');
  }

  // Don't duplicate the same outcome
  if (statuses.includes(outcome)) {
    agentLog(agentKey, `markCommentOutcome: comment ${commentId} already has '${outcome}' — skipping`, 'INFO');
    return;
  }

  if (reason) {
    reaction.reason = reason;
  }

  addStatusTransition(reaction, outcome);
  agentLog(agentKey, `markCommentOutcome: comment ${commentId} → ${outcome} (chain: ${getStatusChain(reaction).join(' → ')})`, 'INFO');

  if (!updateStatusReply(prNumber, commentId, reaction, agentKey, cycle, reason)) {
    agentLog(agentKey, `Failed to update status reply for comment ${commentId} (outcome: ${outcome})`, 'WARN');
  }
}

/**
 * Batch-mark all comments as seen with a small delay between API calls
 * to avoid hitting GitHub rate limits.
 */
export async function markCommentsSeen(
  prNumber: number,
  commentIds: number[],
  agentKey: string,
  cycle: number,
  agentState: OrchAgentState,
): Promise<void> {
  for (const commentId of commentIds) {
    markCommentSeen(prNumber, commentId, agentKey, cycle, agentState);
    // Small delay to avoid rate limiting
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/**
 * Batch-mark all comments as reviewed with a small delay.
 */
export async function markCommentsReviewed(
  prNumber: number,
  commentIds: number[],
  agentKey: string,
  cycle: number,
  agentState: OrchAgentState,
): Promise<void> {
  for (const commentId of commentIds) {
    markCommentReviewed(prNumber, commentId, agentKey, cycle, agentState);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
