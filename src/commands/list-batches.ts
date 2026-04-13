/**
 * list-batches command — discover and display all known batches.
 *
 * Scans signals/ for orchestrator state files and batches/ for batch definitions.
 * Shows batch name, phase, agent status breakdown, cost, and start date.
 */

import { readdirSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { getSignalsDir, getBatchesDir } from '../config.js';
import { readOrchState } from '../signals.js';
import { getCostSummary } from '../cost-ledger.js';

export interface ListBatchesOptions {
  json?: boolean;
}

/**
 * Detect batch names from orchestrator state files in signals/.
 * Returns sorted list of batch names.
 */
export function detectBatchNamesFromSignals(): string[] {
  const signalsDir = getSignalsDir();
  if (!existsSync(signalsDir)) return [];

  return readdirSync(signalsDir)
    .filter(f => f.endsWith('-orchestrator.json'))
    .map(f => f.replace(/-orchestrator\.json$/, ''))
    .sort();
}

interface BatchInfo {
  name: string;
  phase: string;
  agentCount: number;
  statusCounts: Record<string, number>;
  costUsd: number;
  startedAt: string;
  hasDefinition: boolean;
}

function gatherBatchInfo(): BatchInfo[] {
  const signalBatches = detectBatchNamesFromSignals();

  // Also check batches/ for definitions that haven't been started yet
  const batchesDir = getBatchesDir();
  const definedBatches = new Set<string>();
  if (existsSync(batchesDir)) {
    for (const f of readdirSync(batchesDir)) {
      if (f.endsWith('.json') && f !== 'example.json') {
        definedBatches.add(basename(f, '.json'));
      }
    }
  }

  const allNames = new Set([...signalBatches, ...definedBatches]);
  const results: BatchInfo[] = [];

  for (const name of allNames) {
    const isStarted = signalBatches.includes(name);
    const hasDef = definedBatches.has(name);

    if (!isStarted) {
      // Defined but not started
      results.push({
        name,
        phase: 'not-started',
        agentCount: 0,
        statusCounts: {},
        costUsd: 0,
        startedAt: '',
        hasDefinition: hasDef,
      });
      continue;
    }

    const orchState = readOrchState(name, []);
    const statusCounts: Record<string, number> = {};
    let agentCount = 0;

    for (const [, agentState] of Object.entries(orchState.agents)) {
      agentCount++;
      statusCounts[agentState.status] = (statusCounts[agentState.status] ?? 0) + 1;
    }

    const costSummary = getCostSummary(name, orchState);

    results.push({
      name,
      phase: orchState.batchPhase ?? (agentCount > 0 ? 'polling' : 'unknown'),
      agentCount,
      statusCounts,
      costUsd: costSummary.totalCostUsd,
      startedAt: orchState.startedAt ?? '',
      hasDefinition: hasDef,
    });
  }

  // Sort: active batches first (by start date desc), then not-started
  results.sort((a, b) => {
    if (a.phase === 'not-started' && b.phase !== 'not-started') return 1;
    if (b.phase === 'not-started' && a.phase !== 'not-started') return -1;
    return (b.startedAt || '').localeCompare(a.startedAt || '');
  });

  return results;
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

export function listBatches(opts: ListBatchesOptions): void {
  const batches = gatherBatchInfo();

  if (batches.length === 0) {
    console.log('No batches found.');
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify(batches, null, 2));
    return;
  }

  console.log(`Found ${batches.length} batch(es):\n`);

  for (const batch of batches) {
    const costStr = batch.costUsd > 0 ? `$${batch.costUsd.toFixed(2)}` : '—';
    const dateStr = batch.startedAt ? batch.startedAt.substring(0, 10) : '—';

    console.log(`  ${batch.name}`);
    console.log(`    Phase: ${batch.phase}  |  Agents: ${batch.agentCount}  |  Cost: ${costStr}  |  Started: ${dateStr}`);

    if (batch.agentCount > 0) {
      const parts = Object.entries(batch.statusCounts)
        .map(([status, count]) => `${STATUS_EMOJI[status] ?? '❓'} ${status}: ${count}`)
        .join('  ');
      console.log(`    ${parts}`);
    }
    console.log();
  }
}
