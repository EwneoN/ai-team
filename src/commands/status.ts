/**
 * status command — pretty-print the current state of a batch.
 *
 * Reads the orchestrator state file and cost ledger to display
 * batch phase, per-agent status, PR numbers, review cycles, and cost.
 */

import { existsSync } from 'node:fs';
import { getOrchStateFile, readOrchState, readBatchState } from '../signals.js';
import { getCostSummary } from '../cost-ledger.js';
import { isProcessRunning } from '../helpers.js';

export interface StatusOptions {
  json?: boolean;
}

const STATUS_EMOJI: Record<string, string> = {
  pending: '⏳',
  launched: '🚀',
  completed: '📋',
  reviewing: '🔍',
  'awaiting-copilot': '🤖',
  'changes-requested': '🔧',
  approved: '✅',
  'soft-approved': '✅',
  merged: '🔀',
  failed: '❌',
  'max-cycles': '🚫',
};

export function status(batchName: string, opts: StatusOptions): void {
  const orchFile = getOrchStateFile(batchName);

  if (!existsSync(orchFile)) {
    console.log(`No orchestrator state found for batch "${batchName}".`);
    console.log('Use "list-batches" to see available batches.');
    return;
  }

  const orchState = readOrchState(batchName, []);
  const batchState = readBatchState(batchName);
  const costSummary = getCostSummary(batchName, orchState);

  if (opts.json) {
    console.log(JSON.stringify({
      batchName: orchState.batchName,
      batchPhase: orchState.batchPhase ?? null,
      batchPR: orchState.batchPRNumber ? `#${orchState.batchPRNumber}` : null,
      startedAt: orchState.startedAt,
      totalCost: costSummary.totalCostUsd,
      agents: Object.fromEntries(
        Object.entries(orchState.agents).map(([key, state]) => [key, {
          status: state.status,
          prNumber: state.prNumber,
          reviewCycles: state.reviewHistory.length,
          lastCycle: state.lastReviewedCycle,
        }])
      ),
    }, null, 2));
    return;
  }

  // Header
  console.log();
  console.log(`  Batch: ${orchState.batchName}`);
  console.log(`  Phase: ${orchState.batchPhase ?? 'polling (Phase 2)'}`);
  if (orchState.batchPRNumber) {
    console.log(`  Batch PR: #${orchState.batchPRNumber}${orchState.batchPRUrl ? ` (${orchState.batchPRUrl})` : ''}`);
  }
  console.log(`  Started: ${orchState.startedAt ?? 'unknown'}`);
  console.log(`  Total Cost: $${costSummary.totalCostUsd.toFixed(4)}`);
  console.log();

  // Agent table
  const entries = Object.entries(orchState.agents);
  if (entries.length === 0) {
    console.log('  No agents tracked.');
    return;
  }

  // Build PID map from batch state for live status
  const pidMap = new Map<string, number | null>();
  if (batchState) {
    for (const entry of batchState.agents) {
      pidMap.set(`${entry.agent}/${entry.spec}`, entry.pid);
    }
  }

  console.log('  Agents:');
  console.log(`  ${'Agent/Spec'.padEnd(50)} ${'Status'.padEnd(20)} ${'PR'.padEnd(8)} ${'Cycles'.padEnd(8)} Live`);
  console.log(`  ${'─'.repeat(50)} ${'─'.repeat(20)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(5)}`);

  for (const [key, agentState] of entries) {
    const emoji = STATUS_EMOJI[agentState.status] ?? '❓';
    const statusStr = `${emoji} ${agentState.status}`;
    const prStr = agentState.prNumber ? `#${agentState.prNumber}` : '—';
    const cycles = agentState.reviewHistory.length;

    // Check if process is alive
    const pid = pidMap.get(key);
    let liveStr = '—';
    if (pid && pid > 0) {
      liveStr = isProcessRunning(pid) ? '✓' : '✗';
    }

    console.log(`  ${key.padEnd(50)} ${statusStr.padEnd(21)} ${prStr.padEnd(8)} ${String(cycles).padEnd(8)} ${liveStr}`);
  }

  // Summary counts
  const counts: Record<string, number> = {};
  for (const [, state] of entries) {
    counts[state.status] = (counts[state.status] ?? 0) + 1;
  }
  console.log();
  const summary = Object.entries(counts)
    .map(([s, c]) => `${STATUS_EMOJI[s] ?? '❓'} ${s}: ${c}`)
    .join('  |  ');
  console.log(`  Summary: ${summary}`);
  console.log();
}
