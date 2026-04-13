/**
 * clean command — remove runtime artifacts for completed batches.
 *
 * Archives log files and deletes the PID state file ({batch}-state.json).
 * Signal files and orchestrator state are preserved for diagnostics.
 *
 * Safety: only cleans batches in 'merged' or 'closed' phase unless --force.
 */

import { existsSync, unlinkSync } from 'node:fs';
import { readOrchState, getBatchStateFile, getOrchStateFile } from '../signals.js';
import { archiveLogs } from './archive-logs.js';
import { commitBatchHousekeeping } from '../git.js';
import { getProjectRoot } from '../config.js';
import { agentLog } from '../logger.js';
import { detectBatchNamesFromSignals } from './list-batches.js';

export interface CleanOptions {
  batch?: string;
  all?: boolean;
  dryRun?: boolean;
  force?: boolean;
  commit?: boolean;
}

const CLEANABLE_PHASES = new Set(['merged', 'closed']);

function cleanBatch(batchName: string, opts: CleanOptions): boolean {
  const orchFile = getOrchStateFile(batchName);

  if (!existsSync(orchFile)) {
    console.log(`  ${batchName}: no orchestrator state found — skipping`);
    return false;
  }

  // Read state to check phase (pass empty assignments — we only need phase)
  const orchState = readOrchState(batchName, []);
  const phase = orchState.batchPhase ?? 'unknown';

  if (!opts.force && !CLEANABLE_PHASES.has(phase ?? '')) {
    console.log(`  ${batchName}: phase is '${phase}' (not merged/closed) — skipping (use --force to override)`);
    return false;
  }

  if (opts.dryRun) {
    console.log(`  [dry-run] ${batchName} (phase: ${phase}):`);
    console.log(`    Would archive log files`);
    const stateFile = getBatchStateFile(batchName);
    if (existsSync(stateFile)) {
      console.log(`    Would delete ${batchName}-state.json`);
    }
    return true;
  }

  console.log(`  ${batchName} (phase: ${phase}):`);

  // Archive logs
  try {
    archiveLogs({ batch: batchName });
  } catch (err) {
    agentLog('clean', `Log archival failed (non-fatal): ${err}`, 'WARN');
  }

  // Delete PID state file
  const stateFile = getBatchStateFile(batchName);
  if (existsSync(stateFile)) {
    unlinkSync(stateFile);
    console.log(`    Deleted ${batchName}-state.json`);
  }

  return true;
}

export function clean(opts: CleanOptions): void {
  if (!opts.batch && !opts.all) {
    console.log('Usage:');
    console.log('  clean -b <batchName>        Clean a specific batch');
    console.log('  clean --all                 Clean all completed batches');
    console.log('  clean --all --dry-run       Preview what would be cleaned');
    console.log('  clean --all --force         Clean all batches regardless of phase');
    console.log('  clean -b <name> --commit    Clean and commit+push .ai-team/ changes');
    return;
  }

  let batchNames: string[];
  if (opts.batch) {
    batchNames = [opts.batch];
  } else {
    batchNames = detectBatchNamesFromSignals();
    if (batchNames.length === 0) {
      console.log('No batches found in signals directory.');
      return;
    }
  }

  let cleaned = 0;
  for (const name of batchNames) {
    if (cleanBatch(name, opts)) cleaned++;
  }

  if (opts.dryRun) {
    console.log(`\n[dry-run] ${cleaned} batch(es) would be cleaned.`);
  } else if (cleaned > 0) {
    console.log(`\n${cleaned} batch(es) cleaned.`);

    if (opts.commit) {
      const batchLabel = batchNames.length === 1 ? batchNames[0] : 'all';
      console.log('\nCommitting .ai-team/ housekeeping...');
      const projectRoot = getProjectRoot();
      if (commitBatchHousekeeping(batchLabel, projectRoot)) {
        console.log('  Committed and pushed.');
      } else {
        console.log('  Nothing to commit, or push failed.');
      }
    }
  } else {
    console.log('\nNo batches eligible for cleaning.');
  }
}
