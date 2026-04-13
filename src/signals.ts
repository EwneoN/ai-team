/**
 * Signal and state file management.
 * Equivalent to Get-SignalFile, Read-Signal, Read-BatchState,
 * Write-BatchState, orchestrator state functions from helpers.ps1 / orchestrate.ps1
 */

import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getSignalsDir } from './config.js';
import { readUtf8, writeUtf8, ensureDir } from './helpers.js';
import type {
  AgentSignal,
  BatchState,
  OrchState,
  OrchAgentState,
  BatchAssignment,
} from './types.js';

// ── Signal files ─────────────────────────────────────────────

export function getSignalFile(batchName: string, agentKey: string, specName: string): string {
  return join(getSignalsDir(), `${batchName}-${agentKey}-${specName}.json`);
}

export function readSignal(filePath: string): AgentSignal | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readUtf8(filePath)) as AgentSignal;
  } catch {
    return null;
  }
}

/**
 * Check if an agent wrote its signal to its own workspace instead of the
 * project signals directory. This happens when an LLM agent ignores the
 * absolute path in its prompt and writes relative to its CWD.
 *
 * If found, copies the signal to the correct location and returns it.
 * Returns null if no misplaced signal was found.
 */
export function recoverMisplacedSignal(
  batchName: string,
  agentKey: string,
  specName: string,
  agentWorkingDir: string,
): AgentSignal | null {
  const expectedPath = getSignalFile(batchName, agentKey, specName);
  const signalsDir = getSignalsDir();
  const filename = `${batchName}-${agentKey}-${specName}.json`;
  const candidatePath = join(agentWorkingDir, '.ai-team', 'signals', filename);

  if (!existsSync(candidatePath)) return null;

  try {
    const candidate = JSON.parse(readUtf8(candidatePath)) as AgentSignal;

    // If expected path exists, only overwrite if the candidate is genuinely newer
    if (existsSync(expectedPath)) {
      const existing = JSON.parse(readUtf8(expectedPath)) as AgentSignal;
      // Same signal — no recovery needed
      if (existing.signalId === candidate.signalId) return null;
      // Existing has reviewCycle but candidate doesn't — candidate is stale/broken, skip
      if (existing.reviewCycle !== undefined && candidate.reviewCycle === undefined) return null;
      // Both have reviewCycle — only overwrite if candidate is strictly newer
      if (existing.reviewCycle !== undefined && candidate.reviewCycle !== undefined && candidate.reviewCycle <= existing.reviewCycle) return null;
    }

    ensureDir(signalsDir);
    writeUtf8(expectedPath, readUtf8(candidatePath));
    // Remove the workspace copy so it doesn't re-overwrite on future polls
    try { unlinkSync(candidatePath); } catch { /* ignore */ }
    return candidate;
  } catch {
    return null;
  }
}

// ── Batch state (launch state) ───────────────────────────────

export function getBatchStateFile(batchName: string): string {
  return join(getSignalsDir(), `${batchName}-state.json`);
}

export function readBatchState(batchName: string): BatchState | null {
  const stateFile = getBatchStateFile(batchName);
  if (!existsSync(stateFile)) return null;
  try {
    return JSON.parse(readUtf8(stateFile)) as BatchState;
  } catch {
    return null;
  }
}

export function writeBatchState(batchName: string, state: BatchState): void {
  const stateFile = getBatchStateFile(batchName);
  ensureDir(getSignalsDir());
  writeUtf8(stateFile, JSON.stringify(state, null, 2));
}

// ── Orchestrator state ───────────────────────────────────────

export function getOrchStateFile(batchName: string): string {
  return join(getSignalsDir(), `${batchName}-orchestrator.json`);
}

export function readOrchState(batchName: string, assignments: BatchAssignment[]): OrchState {
  const stateFile = getOrchStateFile(batchName);

  if (existsSync(stateFile)) {
    try {
      const state = JSON.parse(readUtf8(stateFile)) as OrchState;
      // Backfill any assignments added to the batch after state was created
      for (const a of assignments) {
        const key = `${a.agent}/${a.spec}`;
        if (!state.agents[key]) {
          state.agents[key] = {
            status: 'pending',
            lastReviewedCycle: -1,
            prNumber: null,
            prUrl: null,
            reviewHistory: [],
            processedSignalIds: [],
          };
        }
      }
      return state;
    } catch {
      // Corrupted — reinitialise
    }
  }

  // Initialise fresh state
  const agents: Record<string, OrchAgentState> = {};
  for (const a of assignments) {
    const key = `${a.agent}/${a.spec}`;
    agents[key] = {
      status: 'pending',
      lastReviewedCycle: -1,
      prNumber: null,
      prUrl: null,
      reviewHistory: [],
      processedSignalIds: [],
    };
  }

  return {
    batchName,
    startedAt: new Date().toISOString(),
    agents,
  };
}

export function saveOrchState(batchName: string, state: OrchState): void {
  const stateFile = getOrchStateFile(batchName);
  ensureDir(getSignalsDir());
  writeUtf8(stateFile, JSON.stringify(state, null, 2));
}

export function getOrchAgentState(state: OrchState, key: string): OrchAgentState | undefined {
  return state.agents[key];
}

export function setOrchAgentState(state: OrchState, key: string, agentState: OrchAgentState): void {
  state.agents[key] = agentState;
}

// ── Review state ─────────────────────────────────────────────

import type { ReviewState } from './types.js';

export function getReviewStateFile(batchName: string, agentKey: string, specName: string): string {
  return join(getSignalsDir(), `${batchName}-${agentKey}-${specName}.reviews.json`);
}

export function readReviewState(batchName: string, agentKey: string, specName: string): ReviewState {
  const file = getReviewStateFile(batchName, agentKey, specName);
  if (!existsSync(file)) {
    return { count: 0, history: [] };
  }
  try {
    return JSON.parse(readUtf8(file)) as ReviewState;
  } catch {
    return { count: 0, history: [] };
  }
}

export function writeReviewState(batchName: string, agentKey: string, specName: string, state: ReviewState): void {
  const file = getReviewStateFile(batchName, agentKey, specName);
  ensureDir(getSignalsDir());
  writeUtf8(file, JSON.stringify(state, null, 2));
}
