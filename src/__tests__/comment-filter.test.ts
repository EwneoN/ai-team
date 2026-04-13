import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  classifyCommentsByChangedFiles,
  filterOldCodeComments,
  type ReviewComment,
} from '../comment-filter.js';

// ── Mock Anthropic SDK ──────────────────────────────────────

const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

// ── Helpers ─────────────────────────────────────────────────

function makeComment(path: string, body: string, id?: number): ReviewComment {
  return { id, path, body, line: null };
}

// ── classifyCommentsByChangedFiles ──────────────────────────

describe('classifyCommentsByChangedFiles', () => {
  it('splits comments by whether their file was changed', () => {
    const comments = [
      makeComment('src/handler.ts', 'Fix this'),
      makeComment('src/repo.ts', 'Fix that'),
      makeComment('src/utils.ts', 'And this'),
    ];
    const changedFiles = ['src/handler.ts', 'src/utils.ts'];

    const result = classifyCommentsByChangedFiles(comments, changedFiles);

    expect(result.changedCode).toHaveLength(2);
    expect(result.changedCode.map((c) => c.path)).toEqual(['src/handler.ts', 'src/utils.ts']);
    expect(result.oldCode).toHaveLength(1);
    expect(result.oldCode[0]!.path).toBe('src/repo.ts');
  });

  it('returns all as changedCode when all files match', () => {
    const comments = [makeComment('a.ts', 'x'), makeComment('b.ts', 'y')];
    const result = classifyCommentsByChangedFiles(comments, ['a.ts', 'b.ts']);

    expect(result.changedCode).toHaveLength(2);
    expect(result.oldCode).toHaveLength(0);
  });

  it('returns all as oldCode when no files match', () => {
    const comments = [makeComment('a.ts', 'x'), makeComment('b.ts', 'y')];
    const result = classifyCommentsByChangedFiles(comments, ['c.ts']);

    expect(result.changedCode).toHaveLength(0);
    expect(result.oldCode).toHaveLength(2);
  });

  it('handles empty comments array', () => {
    const result = classifyCommentsByChangedFiles([], ['a.ts']);
    expect(result.changedCode).toHaveLength(0);
    expect(result.oldCode).toHaveLength(0);
  });
});

// ── filterOldCodeComments ───────────────────────────────────

describe('filterOldCodeComments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes all comments through on early cycles (below cutoff)', async () => {
    const comments = [
      makeComment('old-file.ts', 'A nit about wording', 1),
    ];

    const result = await filterOldCodeComments(comments, ['changed.ts'], 2, 3);

    expect(result.forwarded).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('always forwards changed-code comments regardless of severity', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '[{"index": 0, "severity": "NIT"}]' }],
      usage: { input_tokens: 100, output_tokens: 20 },
    });

    const comments = [
      makeComment('changed.ts', 'A nit about wording', 1),
      makeComment('old-file.ts', 'Another nit', 2),
    ];

    const result = await filterOldCodeComments(comments, ['changed.ts'], 3, 3);

    // changed.ts comment forwarded without classification
    expect(result.forwarded.some((c) => c.path === 'changed.ts')).toBe(true);
    // old-file.ts comment classified as NIT and skipped
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.path).toBe('old-file.ts');
  });

  it('forwards old-code CRITICAL/IMPORTANT comments', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '[{"index": 0, "severity": "CRITICAL"}, {"index": 1, "severity": "IMPORTANT"}]' }],
      usage: { input_tokens: 100, output_tokens: 20 },
    });

    const comments = [
      makeComment('old1.ts', 'Race condition risk', 1),
      makeComment('old2.ts', 'Missing auth check', 2),
    ];

    const result = await filterOldCodeComments(comments, ['changed.ts'], 4, 3);

    expect(result.forwarded).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
  });

  it('skips old-code NIT comments with reason', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '[{"index": 0, "severity": "NIT"}]' }],
      usage: { input_tokens: 100, output_tokens: 20 },
    });

    const comments = [
      makeComment('old.ts', 'Consider renaming this variable', 1),
    ];

    const result = await filterOldCodeComments(comments, ['changed.ts'], 3, 3);

    expect(result.forwarded).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toContain('Deferred cosmetic');
  });

  it('defaults to CRITICAL when Haiku API fails', async () => {
    mockCreate.mockRejectedValue(new Error('API timeout'));

    const comments = [
      makeComment('old.ts', 'Some comment', 1),
    ];

    const result = await filterOldCodeComments(comments, ['changed.ts'], 3, 3);

    // Should forward everything (safe default)
    expect(result.forwarded).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });

  it('defaults to CRITICAL when Haiku returns invalid JSON', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'not valid json' }],
      usage: { input_tokens: 100, output_tokens: 20 },
    });

    const comments = [
      makeComment('old.ts', 'Some comment', 1),
    ];

    const result = await filterOldCodeComments(comments, ['changed.ts'], 3, 3);

    expect(result.forwarded).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });

  it('handles mixed changed-code and old-code with mixed severities', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '[{"index": 0, "severity": "CRITICAL"}, {"index": 1, "severity": "NIT"}]' }],
      usage: { input_tokens: 100, output_tokens: 20 },
    });

    const comments = [
      makeComment('changed.ts', 'Comment on changed code', 1),
      makeComment('old-critical.ts', 'Race condition here', 2),
      makeComment('old-nit.ts', 'Consider better naming', 3),
    ];

    const result = await filterOldCodeComments(comments, ['changed.ts'], 5, 3);

    expect(result.forwarded).toHaveLength(2); // changed.ts + old-critical.ts
    expect(result.skipped).toHaveLength(1);   // old-nit.ts
    expect(result.forwarded.map((c) => c.path).sort()).toEqual(['changed.ts', 'old-critical.ts']);
    expect(result.skipped[0]!.path).toBe('old-nit.ts');
  });

  it('returns all forwarded when no old-code comments exist', async () => {
    const comments = [
      makeComment('changed.ts', 'Fix this', 1),
      makeComment('also-changed.ts', 'Fix that', 2),
    ];

    const result = await filterOldCodeComments(comments, ['changed.ts', 'also-changed.ts'], 5, 3);

    expect(result.forwarded).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
    expect(mockCreate).not.toHaveBeenCalled(); // No Haiku call needed
  });
});
