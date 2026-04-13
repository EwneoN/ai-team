import { describe, it, expect } from 'vitest';
import { parseArchitectVerdict } from '../claude.js';

describe('parseArchitectVerdict', () => {
  // ── JSON code block format ──────────────────────────────────

  it('parses APPROVE verdict from json code block', () => {
    const output = `Here is my review:

\`\`\`json
{
  "verdict": "APPROVE",
  "summary": "Code looks good overall.",
  "issues": []
}
\`\`\`
`;
    const result = parseArchitectVerdict(output);
    expect(result).toEqual({
      verdict: 'APPROVE',
      summary: 'Code looks good overall.',
      issues: [],
    });
  });

  it('parses CHANGES_REQUESTED verdict with issues', () => {
    const output = `After reviewing the diff:

\`\`\`json
{
  "verdict": "CHANGES_REQUESTED",
  "summary": "Several issues found.",
  "issues": [
    { "severity": "critical", "file": "src/handler.ts", "description": "Missing auth check" },
    { "severity": "minor", "file": "src/utils.ts", "description": "Unused import" }
  ]
}
\`\`\`
`;
    const result = parseArchitectVerdict(output);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('CHANGES_REQUESTED');
    expect(result!.issues).toHaveLength(2);
    expect(result!.issues[0].severity).toBe('critical');
  });

  it('uses the last json block when multiple are present', () => {
    const output = `Let me show an example:

\`\`\`json
{ "example": true }
\`\`\`

Here is the actual verdict:

\`\`\`json
{
  "verdict": "APPROVE",
  "summary": "All good.",
  "issues": []
}
\`\`\`
`;
    const result = parseArchitectVerdict(output);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('APPROVE');
  });

  // ── Bare JSON format ────────────────────────────────────────

  it('parses bare JSON object at end of output', () => {
    const output = `Based on my review, the code is acceptable.

{"verdict": "APPROVE", "summary": "Looks fine.", "issues": []}`;
    const result = parseArchitectVerdict(output);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('APPROVE');
  });

  // ── Edge cases / malformed output ───────────────────────────

  it('returns null for empty string', () => {
    expect(parseArchitectVerdict('')).toBeNull();
  });

  it('returns null for output with no JSON', () => {
    const output = 'I approve this change. It looks great!';
    expect(parseArchitectVerdict(output)).toBeNull();
  });

  it('returns null for JSON without verdict field', () => {
    const output = `
\`\`\`json
{ "status": "ok", "message": "reviewed" }
\`\`\`
`;
    expect(parseArchitectVerdict(output)).toBeNull();
  });

  it('returns null for malformed JSON in code block', () => {
    const output = `
\`\`\`json
{ "verdict": "APPROVE", "summary": missing quotes }
\`\`\`
`;
    expect(parseArchitectVerdict(output)).toBeNull();
  });

  it('returns null for JSON block with truncated content', () => {
    const output = `
\`\`\`json
{ "verdict": "APPROVE", "summary": "ok", "issues": [
\`\`\`
`;
    expect(parseArchitectVerdict(output)).toBeNull();
  });

  it('handles verdict with extra fields gracefully', () => {
    const output = `
\`\`\`json
{
  "verdict": "APPROVE",
  "summary": "Fine.",
  "issues": [],
  "confidence": 0.95,
  "notes": "extra data"
}
\`\`\`
`;
    const result = parseArchitectVerdict(output);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('APPROVE');
  });

  it('handles Windows-style line endings in json block', () => {
    const output = '```json\r\n{"verdict": "APPROVE", "summary": "ok", "issues": []}\r\n```';
    const result = parseArchitectVerdict(output);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('APPROVE');
  });
});
