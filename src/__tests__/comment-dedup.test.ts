import { describe, it, expect } from 'vitest';
import {
  normaliseBody,
  areSimilar,
  deduplicateComments,
} from '../commands/orchestrate.js';
import type { ReviewHistoryEntry } from '../types.js';

// ── normaliseBody ────────────────────────────────────────────

describe('normaliseBody', () => {
  it('removes fenced code blocks', () => {
    const input = 'Before\n```ts\nconst x = 1;\n```\nAfter';
    expect(normaliseBody(input)).toBe('before after');
  });

  it('removes inline code', () => {
    expect(normaliseBody('Use `useState` here')).toBe('use here');
  });

  it('removes bold and italic markers', () => {
    expect(normaliseBody('**bold** and __also bold__ and *italic* and _also italic_'))
      .toBe('bold and also bold and italic and also italic');
  });

  it('removes heading markers', () => {
    expect(normaliseBody('## Section Title')).toBe('section title');
    expect(normaliseBody('### Sub heading')).toBe('sub heading');
  });

  it('collapses whitespace', () => {
    expect(normaliseBody('too   many    spaces')).toBe('too many spaces');
  });

  it('lowercases everything', () => {
    expect(normaliseBody('UPPERCASE Text')).toBe('uppercase text');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normaliseBody('  padded  ')).toBe('padded');
  });

  it('handles combined markdown formatting', () => {
    const input = '## **Important:** Use `handleClick()` instead\n\n```js\nfoo()\n```\n\nDone.';
    expect(normaliseBody(input)).toBe('important: use instead done.');
  });

  it('handles empty string', () => {
    expect(normaliseBody('')).toBe('');
  });

  it('handles string with only code block', () => {
    expect(normaliseBody('```\ncode only\n```')).toBe('');
  });

  it('removes multiple code blocks', () => {
    const input = '```ts\na\n```\ntext\n```js\nb\n```';
    expect(normaliseBody(input)).toBe('text');
  });
});

// ── areSimilar ───────────────────────────────────────────────

describe('areSimilar', () => {
  it('returns true for exact matches', () => {
    expect(areSimilar('same text here', 'same text here')).toBe(true);
  });

  it('returns true for matches after normalisation', () => {
    expect(areSimilar('**Bold** text', 'bold text')).toBe(true);
  });

  it('returns true for case-insensitive matches', () => {
    expect(areSimilar('HELLO WORLD', 'hello world')).toBe(true);
  });

  it('returns true for high token overlap', () => {
    expect(areSimilar(
      'Missing error handling in the authentication flow',
      'Missing error handling in authentication flow',
    )).toBe(true);
  });

  it('returns false for low token overlap', () => {
    expect(areSimilar(
      'Fix the database query to use indexes',
      'Add error handling for the authentication service',
    )).toBe(false);
  });

  it('returns false when one body has only short tokens', () => {
    // Tokens with length <= 2 are filtered out
    expect(areSimilar('a b c', 'x y z')).toBe(false);
  });

  it('returns false for completely different content', () => {
    expect(areSimilar(
      'Please add TypeScript type annotations',
      'The CSS styles need responsive breakpoints',
    )).toBe(false);
  });

  it('respects custom threshold', () => {
    const a = 'Missing validation for user input data';
    const b = 'Missing validation for request input';
    // These share some tokens but may not reach 0.9
    expect(areSimilar(a, b, 0.3)).toBe(true);
    expect(areSimilar(a, b, 0.99)).toBe(false);
  });

  it('handles empty strings', () => {
    expect(areSimilar('', '')).toBe(true); // both normalise to '' which are equal
  });

  it('returns false when one side is empty and other is not', () => {
    expect(areSimilar('', 'some meaningful content here')).toBe(false);
  });
});

// ── deduplicateComments ──────────────────────────────────────

describe('deduplicateComments', () => {
  const makeComment = (body: string, path = 'file.ts', line: number | null = 1) =>
    ({ path, body, line });

  const makeHistory = (commentBodies: string[], cycle = 1): ReviewHistoryEntry => ({
    cycle,
    verdict: 'CHANGES_REQUESTED',
    summary: 'Issues found',
    timestamp: new Date().toISOString(),
    commentBodies,
  });

  it('returns all comments when review history is empty', () => {
    const comments = [makeComment('Fix this'), makeComment('Fix that')];
    expect(deduplicateComments(comments, [])).toEqual(comments);
  });

  it('returns all comments when history has no comment bodies', () => {
    const comments = [makeComment('Fix this')];
    const history: ReviewHistoryEntry[] = [{
      cycle: 1,
      verdict: 'CHANGES_REQUESTED',
      summary: 'Issues found',
      timestamp: new Date().toISOString(),
    }];
    expect(deduplicateComments(comments, history)).toEqual(comments);
  });

  it('filters out exact duplicate comments', () => {
    const comments = [
      makeComment('Missing error handling in the authentication flow'),
      makeComment('Genuinely new feedback about the design'),
    ];
    const history = [makeHistory(['Missing error handling in the authentication flow'])];

    const result = deduplicateComments(comments, history);
    expect(result).toHaveLength(1);
    expect(result[0].body).toBe('Genuinely new feedback about the design');
  });

  it('filters out similar (fuzzy) duplicate comments', () => {
    const comments = [
      makeComment('**Missing** error handling in the `auth` flow'),
    ];
    // After normalisation, should match
    const history = [makeHistory(['Missing error handling in the auth flow'])];

    const result = deduplicateComments(comments, history);
    expect(result).toHaveLength(0);
  });

  it('checks across multiple history entries', () => {
    const comments = [
      makeComment('Fix the database indexes for performance'),
      makeComment('Add input validation to the endpoint'),
    ];
    const history = [
      makeHistory(['Fix the database indexes for performance'], 1),
      makeHistory(['Add input validation to the endpoint'], 2),
    ];

    const result = deduplicateComments(comments, history);
    expect(result).toHaveLength(0);
  });

  it('preserves object references — dedup output is a subset of input array', () => {
    const c1 = { id: 100, path: 'a.ts', body: 'Brand new feedback', line: 1 as number | null };
    const c2 = { id: 200, path: 'b.ts', body: 'Fix the database indexes for performance', line: 2 as number | null };
    const allComments = [c1, c2];
    const history = [makeHistory(['Fix the database indexes for performance'], 1)];

    const newComments = deduplicateComments(allComments, history);

    // c1 survives, c2 is a dup
    expect(newComments).toHaveLength(1);
    expect(newComments[0]).toBe(c1); // same reference

    // dupComments filter — same logic used in handleAwaitingCopilot
    const dupComments = allComments.filter((c) => 'id' in c && c.id && !newComments.includes(c));
    expect(dupComments).toHaveLength(1);
    expect(dupComments[0]).toBe(c2); // same reference
    expect(dupComments[0].id).toBe(200);
  });

  it('dupComments filter finds all duplicates when all comments are dupes', () => {
    const c1 = { id: 100, path: 'a.ts', body: 'Fix the database indexes for performance', line: 1 as number | null };
    const allComments = [c1];
    const history = [makeHistory(['Fix the database indexes for performance'], 1)];

    const newComments = deduplicateComments(allComments, history);
    expect(newComments).toHaveLength(0);

    const dupComments = allComments.filter((c) => 'id' in c && c.id && !newComments.includes(c));
    expect(dupComments).toHaveLength(1);
    expect(dupComments[0]).toBe(c1);
  });

  it('keeps comments that do not match any history', () => {
    const comments = [
      makeComment('Brand new issue about memory leaks'),
      makeComment('Another new comment about testing'),
    ];
    const history = [makeHistory(['Completely unrelated old comment about formatting'])];

    const result = deduplicateComments(comments, history);
    expect(result).toHaveLength(2);
  });
});
