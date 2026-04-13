/**
 * comment-filter — post-dedup severity filtering for Copilot review comments.
 *
 * On late review cycles (3+), comments on unchanged code are classified by
 * severity using a cheap Haiku call. NIT-level comments are auto-skipped
 * to reduce unnecessary agent fix cycles.
 */

import Anthropic from '@anthropic-ai/sdk';
import { estimateCost } from './claude.js';
import { agentLog } from './logger.js';

// ── Types ────────────────────────────────────────────────────

export type CommentSeverity = 'CRITICAL' | 'IMPORTANT' | 'NIT';

export interface ReviewComment {
  id?: number;
  path: string;
  body: string;
  line: number | null;
}

export interface FilterResult {
  forwarded: ReviewComment[];
  skipped: Array<ReviewComment & { reason: string }>;
}

// ── Changed-file classification ─────────────────────────────

/**
 * Split comments into those targeting files changed in the latest commit
 * vs. comments on code that hasn't changed since the previous cycle.
 */
export function classifyCommentsByChangedFiles(
  comments: ReviewComment[],
  changedFiles: string[],
): { changedCode: ReviewComment[]; oldCode: ReviewComment[] } {
  const changedSet = new Set(changedFiles);
  const changedCode: ReviewComment[] = [];
  const oldCode: ReviewComment[] = [];

  for (const comment of comments) {
    if (changedSet.has(comment.path)) {
      changedCode.push(comment);
    } else {
      oldCode.push(comment);
    }
  }

  return { changedCode, oldCode };
}

// ── Severity classification via Haiku ───────────────────────

const SEVERITY_MODEL = 'claude-haiku-3-5';

/**
 * Classify old-code comments by severity using a single Haiku API call.
 * On any failure, returns all comments as CRITICAL (safe default).
 */
export async function classifySeverity(
  comments: ReviewComment[],
): Promise<Array<{ comment: ReviewComment; severity: CommentSeverity }>> {
  if (comments.length === 0) return [];

  const defaultResult = comments.map((c) => ({ comment: c, severity: 'CRITICAL' as CommentSeverity }));

  try {
    const client = new Anthropic();

    const numbered = comments
      .map((c, i) => `[${i}] File: ${c.path}\n${c.body}`)
      .join('\n\n---\n\n');

    const response = await client.messages.create({
      model: SEVERITY_MODEL,
      max_tokens: 1024,
      system: [
        'You are a code review triage assistant. Classify each review comment by severity.',
        '',
        'Severity levels:',
        '- CRITICAL: data loss, security vulnerability, stuck state, race condition, missing error handling that causes crashes',
        '- IMPORTANT: incorrect behavior, misleading error messages, missing validation, authorization gaps, concurrency bugs',
        '- NIT: wording improvements, style consistency, comment accuracy, test data formatting, import organization, naming suggestions',
        '',
        'Respond with ONLY a JSON array: [{"index": 0, "severity": "CRITICAL"}, ...]',
        'One entry per comment. No explanation, no markdown fencing.',
      ].join('\n'),
      messages: [
        { role: 'user', content: numbered },
      ],
    });

    const rawText = response.content
      .filter((block) => block.type === 'text')
      .map((block) => (block as Anthropic.TextBlock).text)
      .join('');

    // Strip any accidental markdown fencing
    const cleaned = rawText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(cleaned) as Array<{ index: number; severity: string }>;

    const costUsd = estimateCost(
      response.usage.input_tokens,
      response.usage.output_tokens,
      SEVERITY_MODEL,
    );
    agentLog('filter', `Severity classification: ${comments.length} comment(s), $${costUsd.toFixed(4)}`, 'INFO');

    // Map results back to comments, defaulting to CRITICAL for missing/invalid entries
    return comments.map((comment, i) => {
      const entry = parsed.find((p) => p.index === i);
      const severity = entry?.severity as CommentSeverity | undefined;
      const valid = severity === 'CRITICAL' || severity === 'IMPORTANT' || severity === 'NIT';
      return { comment, severity: valid ? severity : 'CRITICAL' };
    });
  } catch (err) {
    agentLog('filter', `Severity classification failed (defaulting to CRITICAL): ${err}`, 'WARN');
    return defaultResult;
  }
}

// ── Main entry point ────────────────────────────────────────

const SKIP_REASON = 'Deferred cosmetic on unchanged code — will address post-merge';

/**
 * Filter old-code NIT comments on late review cycles.
 *
 * - Cycles before `cycleCutoff`: all comments forwarded (no filtering).
 * - Changed-code comments: always forwarded regardless of severity.
 * - Old-code CRITICAL/IMPORTANT: forwarded.
 * - Old-code NIT: skipped with reason.
 */
export async function filterOldCodeComments(
  newComments: ReviewComment[],
  changedFiles: string[],
  currentCycle: number,
  cycleCutoff: number,
): Promise<FilterResult> {
  // No filtering on early cycles
  if (currentCycle < cycleCutoff) {
    return { forwarded: newComments, skipped: [] };
  }

  const { changedCode, oldCode } = classifyCommentsByChangedFiles(newComments, changedFiles);

  // No old-code comments to filter
  if (oldCode.length === 0) {
    return { forwarded: changedCode, skipped: [] };
  }

  const classified = await classifySeverity(oldCode);

  const forwarded: ReviewComment[] = [...changedCode];
  const skipped: Array<ReviewComment & { reason: string }> = [];

  for (const { comment, severity } of classified) {
    if (severity === 'NIT') {
      skipped.push({ ...comment, reason: SKIP_REASON });
    } else {
      forwarded.push(comment);
    }
  }

  if (skipped.length > 0) {
    agentLog('filter', `Filtered ${skipped.length} old-code nit(s) from ${newComments.length} new comment(s)`, 'INFO');
  }

  return { forwarded, skipped };
}
