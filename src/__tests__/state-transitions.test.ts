import { describe, it, expect } from 'vitest';
import type { OrchAgentState } from '../types.js';

/**
 * Valid state transitions for OrchAgentState.status based on the orchestrate loop.
 *
 * This serves as both documentation and a regression test — if the status
 * union changes, these tests should be updated to match.
 */

type AgentStatus = OrchAgentState['status'];

const VALID_TRANSITIONS: Record<AgentStatus, AgentStatus[]> = {
  'pending':            ['launched', 'failed'],
  'launched':           ['completed', 'failed'],
  'completed':          ['awaiting-copilot', 'reviewing', 'failed'],
  'awaiting-copilot':   ['reviewing', 'failed', 'max-cycles'],
  'reviewing':          ['approved', 'soft-approved', 'changes-requested', 'max-cycles', 'failed'],
  'changes-requested':  ['launched', 'failed', 'max-cycles'],
  'approved':           ['merged'],   // terminal (can transition to merged when PR is merged)
  'soft-approved':      ['merged'],   // terminal (can transition to merged when PR is merged)
  'merged':             [],   // terminal
  'failed':             [],   // terminal
  'max-cycles':         [],   // terminal
};

const ALL_STATUSES: AgentStatus[] = [
  'pending', 'launched', 'completed', 'reviewing',
  'awaiting-copilot', 'approved', 'soft-approved', 'merged',
  'changes-requested', 'failed', 'max-cycles',
];

const TERMINAL_STATUSES: AgentStatus[] = ['approved', 'soft-approved', 'merged', 'failed', 'max-cycles'];
const FINAL_STATUSES: AgentStatus[] = ['merged', 'failed', 'max-cycles'];

describe('OrchAgentState status transitions', () => {
  it('covers every status in the union type', () => {
    const mapped = Object.keys(VALID_TRANSITIONS) as AgentStatus[];
    expect(mapped.sort()).toEqual([...ALL_STATUSES].sort());
  });

  it('final statuses have no outgoing transitions', () => {
    for (const status of FINAL_STATUSES) {
      expect(VALID_TRANSITIONS[status]).toEqual([]);
    }
  });

  it('approved/soft-approved can only transition to merged', () => {
    expect(VALID_TRANSITIONS['approved']).toEqual(['merged']);
    expect(VALID_TRANSITIONS['soft-approved']).toEqual(['merged']);
  });

  it('non-terminal statuses have at least one outgoing transition', () => {
    for (const status of ALL_STATUSES) {
      if (!TERMINAL_STATUSES.includes(status)) {
        expect(VALID_TRANSITIONS[status].length).toBeGreaterThan(0);
      }
    }
  });

  it('pending can only reach launched or failed', () => {
    expect(VALID_TRANSITIONS['pending']).toEqual(['launched', 'failed']);
  });

  it('launched can reach completed or failed', () => {
    expect(VALID_TRANSITIONS['launched']).toContain('completed');
    expect(VALID_TRANSITIONS['launched']).toContain('failed');
  });

  it('reviewing can reach approved, soft-approved, changes-requested, max-cycles, or failed', () => {
    const expected: AgentStatus[] = ['approved', 'soft-approved', 'changes-requested', 'max-cycles', 'failed'];
    for (const s of expected) {
      expect(VALID_TRANSITIONS['reviewing']).toContain(s);
    }
  });

  it('changes-requested loops back to launched for review-fix cycles', () => {
    expect(VALID_TRANSITIONS['changes-requested']).toContain('launched');
  });

  it('all transition targets are valid statuses', () => {
    for (const [, targets] of Object.entries(VALID_TRANSITIONS)) {
      for (const target of targets) {
        expect(ALL_STATUSES).toContain(target);
      }
    }
  });
});
