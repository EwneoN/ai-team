import { describe, it, expect } from 'vitest';
import { extractPRNumber } from '../commands/orchestrate.js';

describe('extractPRNumber', () => {
  it('extracts PR number from standard GitHub URL', () => {
    expect(extractPRNumber('https://github.com/owner/repo/pull/123')).toBe(123);
  });

  it('extracts PR number from URL with trailing path', () => {
    expect(extractPRNumber('https://github.com/owner/repo/pull/456/files')).toBe(456);
  });

  it('extracts PR number from URL with query params', () => {
    expect(extractPRNumber('https://github.com/owner/repo/pull/789?diff=unified')).toBe(789);
  });

  it('extracts PR number from URL with hash fragment', () => {
    expect(extractPRNumber('https://github.com/owner/repo/pull/42#discussion_r12345')).toBe(42);
  });

  it('handles large PR numbers', () => {
    expect(extractPRNumber('https://github.com/owner/repo/pull/99999')).toBe(99999);
  });

  it('returns null for null input', () => {
    expect(extractPRNumber(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(extractPRNumber(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractPRNumber('')).toBeNull();
  });

  it('returns null for URL without pull path', () => {
    expect(extractPRNumber('https://github.com/owner/repo/issues/123')).toBeNull();
  });

  it('returns null for malformed URL', () => {
    expect(extractPRNumber('not-a-url')).toBeNull();
  });

  it('extracts from bare path', () => {
    expect(extractPRNumber('/pull/25')).toBe(25);
  });
});
