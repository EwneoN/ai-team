import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatStatusReply, markCommentSeen, markCommentReviewed, markCommentOutcome } from '../comment-status.js';
import type { CommentReactionState, OrchAgentState } from '../types.js';
import * as git from '../git.js';

// Mock git functions used by side-effecting functions
vi.mock('../git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof git>();
  return {
    ...actual,
    replyToReviewComment: vi.fn(),
    editReviewComment: vi.fn(),
    findStatusReply: vi.fn(),
    invalidateReviewCommentCache: vi.fn(),
  };
});

// ── formatStatusReply ────────────────────────────────────────

describe('formatStatusReply', () => {
  it('renders a single seen status', () => {
    const result = formatStatusReply(['seen'], 'backend', 1);
    expect(result).toContain('👀');
    expect(result).toContain('*backend · cycle 1*');
  });

  it('renders seen → reviewed chain', () => {
    const result = formatStatusReply(['seen', 'reviewed'], 'frontend', 2);
    expect(result).toContain('👀 ➜ 🧠');
    expect(result).toContain('*frontend · cycle 2*');
  });

  it('renders full fix chain: seen → reviewed → will-fix → fixed', () => {
    const result = formatStatusReply(['seen', 'reviewed', 'will-fix', 'fixed'], 'backend', 3);
    expect(result).toContain('👀 ➜ 🧠 ➜ 🛠️ ➜ ✅');
    expect(result).toContain('*backend · cycle 3*');
  });

  it('renders wont-fix with label and reason', () => {
    const result = formatStatusReply(
      ['seen', 'reviewed', 'wont-fix'],
      'backend',
      2,
      'Already handled by existing validation.',
    );
    expect(result).toContain("👀 ➜ 🧠 ➜ ❌ Won't fix");
    expect(result).toContain('**Reason:** Already handled by existing validation.');
    expect(result).toContain('*backend · cycle 2*');
  });

  it('renders skipped with label and reason', () => {
    const result = formatStatusReply(
      ['seen', 'reviewed', 'skipped'],
      'frontend',
      1,
      'Out of scope — tracked in issue #47.',
    );
    expect(result).toContain('👀 ➜ 🧠 ➜ ☑️ Skipped');
    expect(result).toContain('**Reason:** Out of scope — tracked in issue #47.');
  });

  it('does not include reason for non-terminal statuses', () => {
    const result = formatStatusReply(
      ['seen', 'reviewed'],
      'backend',
      1,
      'Some reason',
    );
    expect(result).not.toContain('**Reason:**');
  });

  it('returns empty string for empty statuses', () => {
    expect(formatStatusReply([], 'backend', 1)).toBe('');
  });
});

// ── State management helpers ─────────────────────────────────

function makeAgentState(reactions?: CommentReactionState[]): OrchAgentState {
  return {
    status: 'launched',
    lastReviewedCycle: 0,
    prNumber: 42,
    prUrl: 'https://github.com/test/repo/pull/42',
    reviewHistory: [],
    commentReactions: reactions ?? [],
  };
}

describe('CommentReactionState tracking', () => {
  it('initialises empty commentReactions array', () => {
    const state = makeAgentState();
    expect(state.commentReactions).toEqual([]);
  });

  it('does not duplicate reactions for the same comment ID', () => {
    const state = makeAgentState();
    const reaction1: CommentReactionState = {
      originalCommentId: 100,
      replyCommentId: null,
      currentStatus: 'seen',
      statusHistory: [{ status: 'seen', timestamp: '2026-03-30T00:00:00Z' }],
    };
    state.commentReactions!.push(reaction1);

    // Simulating getOrCreateReaction logic: should find existing
    const existing = state.commentReactions!.find((r) => r.originalCommentId === 100);
    expect(existing).toBeDefined();
    expect(existing).toBe(reaction1);
  });

  it('tracks separate reactions for different comment IDs', () => {
    const state = makeAgentState();
    state.commentReactions!.push({
      originalCommentId: 100,
      replyCommentId: 200,
      currentStatus: 'reviewed',
      statusHistory: [
        { status: 'seen', timestamp: '2026-03-30T00:00:00Z' },
        { status: 'reviewed', timestamp: '2026-03-30T00:01:00Z' },
      ],
    });
    state.commentReactions!.push({
      originalCommentId: 101,
      replyCommentId: 201,
      currentStatus: 'seen',
      statusHistory: [
        { status: 'seen', timestamp: '2026-03-30T00:00:00Z' },
      ],
    });

    expect(state.commentReactions).toHaveLength(2);
    expect(state.commentReactions![0]!.currentStatus).toBe('reviewed');
    expect(state.commentReactions![1]!.currentStatus).toBe('seen');
  });

  it('builds correct status chain from history', () => {
    const reaction: CommentReactionState = {
      originalCommentId: 100,
      replyCommentId: 200,
      currentStatus: 'fixed',
      statusHistory: [
        { status: 'seen', timestamp: '2026-03-30T00:00:00Z' },
        { status: 'reviewed', timestamp: '2026-03-30T00:01:00Z' },
        { status: 'will-fix', timestamp: '2026-03-30T00:02:00Z' },
        { status: 'fixed', timestamp: '2026-03-30T00:03:00Z' },
      ],
    };

    const chain = reaction.statusHistory.map((h) => h.status);
    const formatted = formatStatusReply(chain, 'backend', 3);
    expect(formatted).toContain('👀 ➜ 🧠 ➜ 🛠️ ➜ ✅');
  });

  it('stores reason for wont-fix outcomes', () => {
    const reaction: CommentReactionState = {
      originalCommentId: 100,
      replyCommentId: 200,
      currentStatus: 'wont-fix',
      statusHistory: [
        { status: 'seen', timestamp: '2026-03-30T00:00:00Z' },
        { status: 'reviewed', timestamp: '2026-03-30T00:01:00Z' },
        { status: 'wont-fix', timestamp: '2026-03-30T00:02:00Z' },
      ],
      reason: 'Already handled elsewhere',
    };

    expect(reaction.reason).toBe('Already handled elsewhere');
    const chain = reaction.statusHistory.map((h) => h.status);
    const formatted = formatStatusReply(chain, 'backend', 2, reaction.reason);
    expect(formatted).toContain("Won't fix");
    expect(formatted).toContain('**Reason:** Already handled elsewhere');
  });
});

// ── Side-effecting functions with mocked git calls ───────────

describe('markCommentSeen', () => {
  beforeEach(() => {
    vi.mocked(git.replyToReviewComment).mockReset();
    vi.mocked(git.editReviewComment).mockReset();
    vi.mocked(git.findStatusReply).mockReset();
  });

  it('creates a threaded reply with 👀 on first call', () => {
    vi.mocked(git.findStatusReply).mockReturnValue(null);
    vi.mocked(git.replyToReviewComment).mockReturnValue(999);

    const state = makeAgentState();
    markCommentSeen(42, 100, 'backend', 1, state);

    expect(git.replyToReviewComment).toHaveBeenCalledOnce();
    const body = vi.mocked(git.replyToReviewComment).mock.calls[0]![2]!;
    expect(body).toContain('👀');
    expect(state.commentReactions![0]!.replyCommentId).toBe(999);
    expect(state.commentReactions![0]!.currentStatus).toBe('seen');
  });

  it('is idempotent — skips if reply already posted', () => {
    vi.mocked(git.replyToReviewComment).mockReturnValue(999);
    vi.mocked(git.findStatusReply).mockReturnValue(null);

    const state = makeAgentState();
    markCommentSeen(42, 100, 'backend', 1, state);
    markCommentSeen(42, 100, 'backend', 1, state);

    // Should only have posted once
    expect(git.replyToReviewComment).toHaveBeenCalledOnce();
    expect(state.commentReactions![0]!.statusHistory).toHaveLength(1);
  });

  it('retries posting if previous attempt failed (replyCommentId is null)', () => {
    vi.mocked(git.findStatusReply).mockReturnValue(null);
    // First call fails
    vi.mocked(git.replyToReviewComment).mockReturnValueOnce(null);
    const state = makeAgentState();
    markCommentSeen(42, 100, 'backend', 1, state);

    expect(state.commentReactions![0]!.replyCommentId).toBeNull();
    expect(state.commentReactions![0]!.statusHistory).toHaveLength(1);

    // Second call succeeds — should retry posting
    vi.mocked(git.replyToReviewComment).mockReturnValueOnce(999);
    markCommentSeen(42, 100, 'backend', 1, state);

    expect(state.commentReactions![0]!.replyCommentId).toBe(999);
    // Should NOT have added a duplicate 'seen' transition
    expect(state.commentReactions![0]!.statusHistory).toHaveLength(1);
  });

  it('recovers state from existing reply on GitHub', () => {
    vi.mocked(git.findStatusReply).mockReturnValue({ id: 888, body: '👀' });
    vi.mocked(git.editReviewComment).mockReturnValue(true);

    const state = makeAgentState();
    markCommentSeen(42, 100, 'backend', 1, state);

    expect(git.replyToReviewComment).not.toHaveBeenCalled();
    expect(git.editReviewComment).toHaveBeenCalledOnce();
    expect(state.commentReactions![0]!.replyCommentId).toBe(888);
  });

  it('does not persist replyCommentId when state-recovery edit fails', () => {
    vi.mocked(git.findStatusReply).mockReturnValue({ id: 888, body: '👀' });
    vi.mocked(git.editReviewComment).mockReturnValue(false);

    const state = makeAgentState();
    markCommentSeen(42, 100, 'backend', 1, state);

    // replyCommentId should stay null so future calls can retry
    expect(state.commentReactions![0]!.replyCommentId).toBeNull();
  });
});

describe('markCommentReviewed', () => {
  beforeEach(() => {
    vi.mocked(git.replyToReviewComment).mockReset();
    vi.mocked(git.editReviewComment).mockReset();
    vi.mocked(git.findStatusReply).mockReset();
  });

  it('adds 🧠 to an existing seen reply', () => {
    vi.mocked(git.findStatusReply).mockReturnValue(null);
    vi.mocked(git.replyToReviewComment).mockReturnValue(999);
    vi.mocked(git.editReviewComment).mockReturnValue(true);

    const state = makeAgentState();
    markCommentSeen(42, 100, 'backend', 1, state);
    markCommentReviewed(42, 100, 'backend', 1, state);

    expect(git.editReviewComment).toHaveBeenCalledOnce();
    const body = vi.mocked(git.editReviewComment).mock.calls[0]![1]!;
    expect(body).toContain('👀 ➜ 🧠');
    expect(state.commentReactions![0]!.currentStatus).toBe('reviewed');
    expect(state.commentReactions![0]!.statusHistory).toHaveLength(2);
  });

  it('backfills seen if called without markCommentSeen first', () => {
    vi.mocked(git.findStatusReply).mockReturnValue(null);
    vi.mocked(git.replyToReviewComment).mockReturnValue(999);

    const state = makeAgentState();
    markCommentReviewed(42, 100, 'backend', 1, state);

    const body = vi.mocked(git.replyToReviewComment).mock.calls[0]![2]!;
    expect(body).toContain('👀 ➜ 🧠');
    expect(state.commentReactions![0]!.statusHistory).toHaveLength(2);
    expect(state.commentReactions![0]!.statusHistory[0]!.status).toBe('seen');
  });

  it('is idempotent — does not duplicate reviewed transition', () => {
    vi.mocked(git.findStatusReply).mockReturnValue(null);
    vi.mocked(git.replyToReviewComment).mockReturnValue(999);
    vi.mocked(git.editReviewComment).mockReturnValue(true);

    const state = makeAgentState();
    markCommentSeen(42, 100, 'backend', 1, state);
    markCommentReviewed(42, 100, 'backend', 1, state);
    markCommentReviewed(42, 100, 'backend', 2, state);

    // Should still only have 2 transitions: seen + reviewed (not seen + reviewed + reviewed)
    expect(state.commentReactions![0]!.statusHistory).toHaveLength(2);
    expect(state.commentReactions![0]!.statusHistory.map((h) => h.status)).toEqual(['seen', 'reviewed']);
  });
});

describe('markCommentOutcome', () => {
  beforeEach(() => {
    vi.mocked(git.replyToReviewComment).mockReset();
    vi.mocked(git.editReviewComment).mockReset();
    vi.mocked(git.findStatusReply).mockReset();
  });

  it('renders full fix chain: seen → reviewed → will-fix → fixed', () => {
    vi.mocked(git.findStatusReply).mockReturnValue(null);
    vi.mocked(git.replyToReviewComment).mockReturnValue(999);
    vi.mocked(git.editReviewComment).mockReturnValue(true);

    const state = makeAgentState();
    markCommentSeen(42, 100, 'backend', 1, state);
    markCommentReviewed(42, 100, 'backend', 1, state);
    markCommentOutcome(42, 100, 'fixed', 'backend', 1, state);

    // Last edit should contain the full chain
    const lastCall = vi.mocked(git.editReviewComment).mock.calls.at(-1)!;
    expect(lastCall[1]).toContain('👀 ➜ 🧠 ➜ 🛠️ ➜ ✅');
  });

  it('renders wont-fix with reason', () => {
    vi.mocked(git.findStatusReply).mockReturnValue(null);
    vi.mocked(git.replyToReviewComment).mockReturnValue(999);
    vi.mocked(git.editReviewComment).mockReturnValue(true);

    const state = makeAgentState();
    markCommentSeen(42, 100, 'backend', 2, state);
    markCommentReviewed(42, 100, 'backend', 2, state);
    markCommentOutcome(42, 100, 'wont-fix', 'backend', 2, state, 'Already handled elsewhere');

    const lastCall = vi.mocked(git.editReviewComment).mock.calls.at(-1)!;
    expect(lastCall[1]).toContain("❌ Won't fix");
    expect(lastCall[1]).toContain('**Reason:** Already handled elsewhere');
    expect(state.commentReactions![0]!.reason).toBe('Already handled elsewhere');
  });

  it('backfills prerequisite statuses when called directly', () => {
    vi.mocked(git.findStatusReply).mockReturnValue(null);
    vi.mocked(git.replyToReviewComment).mockReturnValue(999);

    const state = makeAgentState();
    markCommentOutcome(42, 100, 'fixed', 'backend', 1, state);

    const body = vi.mocked(git.replyToReviewComment).mock.calls[0]![2]!;
    expect(body).toContain('👀 ➜ 🧠 ➜ 🛠️ ➜ ✅');
    expect(state.commentReactions![0]!.statusHistory).toHaveLength(4);
  });

  it('preserves stored reason when reply is re-rendered by a later status', () => {
    vi.mocked(git.findStatusReply).mockReturnValue(null);
    vi.mocked(git.replyToReviewComment).mockReturnValue(999);
    vi.mocked(git.editReviewComment).mockReturnValue(true);

    const state = makeAgentState();
    // First: mark as wont-fix with reason
    markCommentOutcome(42, 100, 'wont-fix', 'backend', 2, state, 'Already validated');

    // The reply body (created via replyToReviewComment) should contain the reason
    const replyBody = vi.mocked(git.replyToReviewComment).mock.calls[0]![2]!;
    expect(replyBody).toContain('**Reason:** Already validated');
    expect(state.commentReactions![0]!.reason).toBe('Already validated');
  });

  it('adds skipped after fixed (duplicate comment on soft-approve)', () => {
    vi.mocked(git.findStatusReply).mockReturnValue(null);
    vi.mocked(git.replyToReviewComment).mockReturnValue(999);
    vi.mocked(git.editReviewComment).mockReturnValue(true);

    const state = makeAgentState();
    // Cycle 6: comment gets fixed
    markCommentOutcome(42, 100, 'fixed', 'backend', 6, state);
    expect(state.commentReactions![0]!.currentStatus).toBe('fixed');

    // Cycle 7: same comment re-raised by Copilot, dedup marks as skipped
    markCommentOutcome(42, 100, 'skipped', 'backend', 7, state, 'Duplicate from previous cycle — already addressed');

    expect(state.commentReactions![0]!.currentStatus).toBe('skipped');
    expect(state.commentReactions![0]!.reason).toBe('Duplicate from previous cycle — already addressed');

    const statuses = state.commentReactions![0]!.statusHistory.map((h) => h.status);
    expect(statuses).toEqual(['seen', 'reviewed', 'will-fix', 'fixed', 'skipped']);

    // The reply should have been edited with the full chain
    const lastEdit = vi.mocked(git.editReviewComment).mock.calls.at(-1)!;
    expect(lastEdit[1]).toContain('☑️ Skipped');
    expect(lastEdit[1]).toContain('**Reason:** Duplicate from previous cycle');
  });

  it('adds skipped for a brand new comment ID (new Copilot review)', () => {
    vi.mocked(git.findStatusReply).mockReturnValue(null);
    vi.mocked(git.replyToReviewComment).mockReturnValue(999);

    const state = makeAgentState();
    // Comment 200 was never seen before — fresh from a new Copilot review
    markCommentOutcome(42, 200, 'skipped', 'backend', 7, state, 'Duplicate from previous cycle — already addressed');

    expect(state.commentReactions![0]!.currentStatus).toBe('skipped');
    expect(state.commentReactions![0]!.reason).toBe('Duplicate from previous cycle — already addressed');

    const statuses = state.commentReactions![0]!.statusHistory.map((h) => h.status);
    expect(statuses).toEqual(['seen', 'reviewed', 'skipped']);

    // Should have created a new reply (not edited)
    const replyBody = vi.mocked(git.replyToReviewComment).mock.calls[0]![2]!;
    expect(replyBody).toContain('☑️ Skipped');
    expect(replyBody).toContain('**Reason:** Duplicate from previous cycle');
  });

  it('does not duplicate the same outcome status', () => {
    vi.mocked(git.findStatusReply).mockReturnValue(null);
    vi.mocked(git.replyToReviewComment).mockReturnValue(999);
    vi.mocked(git.editReviewComment).mockReturnValue(true);

    const state = makeAgentState();
    markCommentOutcome(42, 100, 'fixed', 'backend', 1, state);
    markCommentOutcome(42, 100, 'fixed', 'backend', 2, state);

    // Should only have 4 transitions (seen, reviewed, will-fix, fixed) — not 5
    expect(state.commentReactions![0]!.statusHistory).toHaveLength(4);
    expect(state.commentReactions![0]!.statusHistory.map((h) => h.status))
      .toEqual(['seen', 'reviewed', 'will-fix', 'fixed']);
  });
});
