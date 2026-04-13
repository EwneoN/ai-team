import { describe, it, expect } from 'vitest';
import { estimateCost } from '../claude.js';

describe('estimateCost', () => {
  it('calculates cost for claude-sonnet-4-6', () => {
    // 1M input tokens * $3.0/M + 500k output tokens * $15.0/M = $3.0 + $7.5 = $10.5
    const cost = estimateCost(1_000_000, 500_000, 'claude-sonnet-4-6');
    expect(cost).toBeCloseTo(10.5);
  });

  it('calculates cost for claude-sonnet-4-5', () => {
    // Same pricing as sonnet-4-6
    const cost = estimateCost(1_000_000, 500_000, 'claude-sonnet-4-5');
    expect(cost).toBeCloseTo(10.5);
  });

  it('calculates cost for claude-opus-4-6', () => {
    // 1M input * $15/M + 500k output * $75/M = $15 + $37.5 = $52.5
    const cost = estimateCost(1_000_000, 500_000, 'claude-opus-4-6');
    expect(cost).toBeCloseTo(52.5);
  });

  it('calculates cost for claude-haiku-3-5', () => {
    // 1M input * $0.8/M + 500k output * $4/M = $0.8 + $2 = $2.8
    const cost = estimateCost(1_000_000, 500_000, 'claude-haiku-3-5');
    expect(cost).toBeCloseTo(2.8);
  });

  it('falls back to sonnet-4-6 pricing for unknown model', () => {
    const unknown = estimateCost(1_000_000, 500_000, 'claude-unknown-99');
    const sonnet = estimateCost(1_000_000, 500_000, 'claude-sonnet-4-6');
    expect(unknown).toBe(sonnet);
  });

  it('returns 0 for zero tokens', () => {
    expect(estimateCost(0, 0, 'claude-sonnet-4-6')).toBe(0);
  });

  it('handles small token counts correctly', () => {
    // 100 input * $3/M + 50 output * $15/M = 0.0003 + 0.00075 = 0.00105
    const cost = estimateCost(100, 50, 'claude-sonnet-4-6');
    expect(cost).toBeCloseTo(0.00105, 6);
  });

  it('handles input-only usage', () => {
    // 1M input * $3/M + 0 output = $3
    const cost = estimateCost(1_000_000, 0, 'claude-sonnet-4-6');
    expect(cost).toBeCloseTo(3.0);
  });

  it('handles output-only usage', () => {
    // 0 input + 1M output * $15/M = $15
    const cost = estimateCost(0, 1_000_000, 'claude-sonnet-4-6');
    expect(cost).toBeCloseTo(15.0);
  });
});
