/**
 * reset command — manipulate agent state for common recovery scenarios.
 *
 * Presets:
 *   --to retry     Reset failed/max-cycles agent to re-enter review flow
 *   --to fresh     Full restart from scratch (needs manual relaunch)
 *   --to approved  Force-approve agent (e.g. to unblock next round)
 *
 * Always deletes the agent's signal file to prevent dedup logic from
 * silently skipping the agent after reset.
 */

import { existsSync, unlinkSync } from 'node:fs';
import { getOrchStateFile, readOrchState, saveOrchState, getSignalFile, getReviewStateFile } from '../signals.js';
import { readBatchState, writeBatchState } from '../signals.js';
import { isProcessRunning } from '../helpers.js';
import { agentLog } from '../logger.js';
import { loadConfig, getAgentConfig, loadBatch } from '../config.js';
import { fetchOrigin, checkoutBranch } from '../git.js';
import { execFileSafe } from '../helpers.js';

export interface ResetOptions {
  batchFile: string;
  agent: string;
  spec: string;
  to: 'retry' | 'fresh' | 'approved';
  dryRun?: boolean;
  force?: boolean;
}

type ResetPreset = ResetOptions['to'];

function applyRetry(agentState: Record<string, unknown>): Record<string, string> {
  const changes: Record<string, string> = {};

  const oldStatus = agentState.status as string;
  agentState.status = 'completed';
  changes['status'] = `${oldStatus} → completed`;

  agentState.processedSignalIds = [];
  changes['processedSignalIds'] = 'cleared';

  agentState.copilotReviewRequestedAt = undefined;
  changes['copilotReviewRequestedAt'] = 'cleared';

  agentState.reviewAgentPid = null;
  changes['reviewAgentPid'] = 'cleared';

  agentState.deathRetries = 0;
  changes['deathRetries'] = '→ 0';

  agentState.boundaryRetries = 0;
  changes['boundaryRetries'] = '→ 0';

  // Keep: prNumber, prUrl, reviewHistory, lastReviewedCycle
  return changes;
}

function applyFresh(agentState: Record<string, unknown>): Record<string, string> {
  const changes: Record<string, string> = {};

  const oldStatus = agentState.status as string;
  agentState.status = 'pending';
  changes['status'] = `${oldStatus} → pending`;

  agentState.lastReviewedCycle = -1;
  changes['lastReviewedCycle'] = '→ -1';

  agentState.reviewHistory = [];
  changes['reviewHistory'] = 'cleared';

  agentState.processedSignalIds = [];
  changes['processedSignalIds'] = 'cleared';

  agentState.prNumber = null;
  changes['prNumber'] = '→ null';

  agentState.prUrl = null;
  changes['prUrl'] = '→ null';

  agentState.deathRetries = 0;
  changes['deathRetries'] = '→ 0';

  agentState.boundaryRetries = 0;
  changes['boundaryRetries'] = '→ 0';

  agentState.inconclusiveRetries = 0;
  changes['inconclusiveRetries'] = '→ 0';

  agentState.copilotReviewRequestedAt = undefined;
  changes['copilotReviewRequestedAt'] = 'cleared';

  agentState.reviewAgentPid = null;
  changes['reviewAgentPid'] = 'cleared';

  agentState.launchCostUsd = undefined;
  changes['launchCostUsd'] = 'cleared';

  agentState.launchDurationMs = undefined;
  changes['launchDurationMs'] = 'cleared';

  agentState.totalCostUsd = undefined;
  changes['totalCostUsd'] = 'cleared';

  agentState.commentReactions = [];
  changes['commentReactions'] = 'cleared';

  return changes;
}

function applyApproved(agentState: Record<string, unknown>): Record<string, string> {
  const changes: Record<string, string> = {};

  const oldStatus = agentState.status as string;
  agentState.status = 'approved';
  changes['status'] = `${oldStatus} → approved`;

  // Add a synthetic review history entry
  const history = (agentState.reviewHistory as Array<Record<string, unknown>>) ?? [];
  history.push({
    cycle: 0,
    verdict: 'APPROVE',
    summary: 'Force-approved via reset command',
    timestamp: new Date().toISOString(),
  });
  agentState.reviewHistory = history;
  changes['reviewHistory'] = 'added force-approve entry';

  agentState.processedSignalIds = [];
  changes['processedSignalIds'] = 'cleared';

  agentState.reviewAgentPid = null;
  changes['reviewAgentPid'] = 'cleared';

  return changes;
}

const PRESET_APPLICATORS: Record<ResetPreset, (state: Record<string, unknown>) => Record<string, string>> = {
  retry: applyRetry,
  fresh: applyFresh,
  approved: applyApproved,
};

const PRESET_DESCRIPTIONS: Record<ResetPreset, string> = {
  retry: 'Re-enter review flow (keeps PR and history)',
  fresh: 'Full restart from scratch (needs manual relaunch)',
  approved: 'Force-approve (unblocks next round)',
};

export function reset(opts: ResetOptions): void {
  const batchName = opts.batchFile;
  const key = `${opts.agent}/${opts.spec}`;

  const orchFile = getOrchStateFile(batchName);
  if (!existsSync(orchFile)) {
    console.error(`No orchestrator state found for batch "${batchName}".`);
    process.exit(1);
  }

  const orchState = readOrchState(batchName, []);
  const agentState = orchState.agents[key];

  if (!agentState) {
    console.error(`Agent "${key}" not found in batch "${batchName}".`);
    console.error(`Available agents: ${Object.keys(orchState.agents).join(', ')}`);
    process.exit(1);
  }

  // Safety: check for live process
  if (!opts.force) {
    const batchState = readBatchState(batchName);
    if (batchState) {
      const entry = batchState.agents.find(e => e.agent === opts.agent && e.spec === opts.spec);
      if (entry?.pid && isProcessRunning(entry.pid)) {
        console.error(`Agent "${key}" has a live process (PID ${entry.pid}).`);
        console.error('Use --force to reset anyway, or wait for the agent to finish.');
        process.exit(1);
      }
    }

    // Also check review agent PID
    if (agentState.reviewAgentPid && agentState.reviewAgentPid > 0 && isProcessRunning(agentState.reviewAgentPid)) {
      console.error(`Agent "${key}" has a live review process (PID ${agentState.reviewAgentPid}).`);
      console.error('Use --force to reset anyway.');
      process.exit(1);
    }
  }

  const preset = opts.to;
  const applicator = PRESET_APPLICATORS[preset];

  console.log();
  console.log(`  Batch:  ${batchName}`);
  console.log(`  Agent:  ${key}`);
  console.log(`  Preset: ${preset} — ${PRESET_DESCRIPTIONS[preset]}`);
  console.log(`  Current status: ${agentState.status}`);
  console.log();

  // Preview changes
  // Clone for dry-run (apply to a copy)
  const stateClone = JSON.parse(JSON.stringify(agentState));
  const changes = applicator(stateClone);

  console.log('  Changes:');
  for (const [field, desc] of Object.entries(changes)) {
    console.log(`    ${field}: ${desc}`);
  }

  // Signal file
  const signalFile = getSignalFile(batchName, opts.agent, opts.spec);
  const signalExists = existsSync(signalFile);
  if (signalExists) {
    console.log(`    signal file: will be deleted`);
  }

  // Review state file (only for fresh — stale cycle counter causes false max-cycles)
  const reviewStateFile = getReviewStateFile(batchName, opts.agent, opts.spec);
  const reviewStateExists = preset === 'fresh' && existsSync(reviewStateFile);
  if (reviewStateExists) {
    console.log(`    review state file: will be deleted`);
  }

  // Preview git branch reset for fresh preset
  if (preset === 'fresh') {
    try {
      const previewConfig = loadConfig();
      const previewAgentCfg = getAgentConfig(previewConfig, opts.agent);
      let previewBatch;
      try {
        previewBatch = loadBatch(opts.batchFile);
      } catch {
        previewBatch = loadBatch(`${opts.batchFile}.json`);
      }
      const previewAssignment = previewBatch.assignments.find(
        a => a.agent === opts.agent && a.spec === opts.spec,
      );
      if (previewAssignment) {
        const subBranch = `batch/${previewBatch.name}--${previewAgentCfg.branchPrefix}--${previewAssignment.spec}`;
        const batchBranch = `batch/${previewBatch.name}`;
        console.log(`    git branch: ${subBranch} → hard-reset to origin/${batchBranch} + force-push`);
      }
    } catch {
      // Non-fatal — preview only
    }
  }

  if (opts.dryRun) {
    console.log('\n  [dry-run] No changes applied.');
    return;
  }

  // Apply changes to real state
  applicator(agentState as unknown as Record<string, unknown>);
  saveOrchState(batchName, orchState);

  // Delete signal file
  if (signalExists) {
    unlinkSync(signalFile);
    agentLog(opts.agent, `Signal file deleted: ${signalFile}`, 'INFO');
  }

  // Delete review state file (fresh only)
  if (reviewStateExists) {
    unlinkSync(reviewStateFile);
    agentLog(opts.agent, `Review state file deleted: ${reviewStateFile}`, 'INFO');
  }

  // Clean batchState to prevent death detection from seeing stale PIDs
  const batchState = readBatchState(batchName);
  if (batchState) {
    if (preset === 'fresh') {
      // Remove entry entirely — agent will get a new entry on next launch
      const before = batchState.agents.length;
      batchState.agents = batchState.agents.filter(
        e => !(e.agent === opts.agent && e.spec === opts.spec)
      );
      if (batchState.agents.length < before) {
        writeBatchState(batchName, batchState);
        console.log('    batchState entry: removed');
      }
    } else {
      // retry / approved — null out PID to prevent stale death detection
      const entry = batchState.agents.find(
        e => e.agent === opts.agent && e.spec === opts.spec
      );
      if (entry?.pid) {
        entry.pid = null;
        writeBatchState(batchName, batchState);
        console.log('    batchState PID: cleared');
      }
    }
  }

  // For 'fresh' preset: hard-reset the agent's git branch to the batch base
  // so the agent starts with a clean slate instead of reusing old commits.
  if (preset === 'fresh') {
    try {
      const config = loadConfig();
      const agentCfg = getAgentConfig(config, opts.agent);
      // opts.batchFile may be a name (e.g. "my-batch") or a path. Try both.
      let batch;
      try {
        batch = loadBatch(opts.batchFile);
      } catch {
        batch = loadBatch(`${opts.batchFile}.json`);
      }
      const batchBranch = `batch/${batch.name}`;
      const assignment = batch.assignments.find(
        a => a.agent === opts.agent && a.spec === opts.spec,
      );
      if (!assignment) {
        console.log('    git branch reset: skipped (assignment not found in batch file)');
      } else {
        const subBranch = `batch/${batch.name}--${agentCfg.branchPrefix}--${assignment.spec}`;
        const agentCwd = agentCfg.workingDir;

        if (existsSync(agentCwd)) {
          fetchOrigin(agentCwd);
          checkoutBranch(subBranch, agentCwd);

          // Hard-reset local branch to the batch base branch
          const { code: resetCode } = execFileSafe(
            'git', ['reset', '--hard', `origin/${batchBranch}`], { cwd: agentCwd },
          );
          if (resetCode === 0) {
            // Force-push the clean branch to origin
            const { code: pushCode } = execFileSafe(
              'git', ['push', 'origin', subBranch, '--force', '--quiet'], { cwd: agentCwd },
            );
            if (pushCode === 0) {
              agentLog(opts.agent, `Branch ${subBranch} hard-reset to origin/${batchBranch} and force-pushed`, 'OK');
            } else {
              agentLog(opts.agent, `Branch reset locally but force-push failed for ${subBranch}`, 'WARN');
            }
          } else {
            agentLog(opts.agent, `Failed to hard-reset branch ${subBranch}`, 'WARN');
          }
        } else {
          console.log(`    git branch reset: skipped (workspace not found at ${agentCwd})`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`    git branch reset: skipped (${msg})`);
    }
  }

  console.log();
  console.log(`  ✅ Agent "${key}" reset to "${preset}".`);

  if (preset === 'fresh') {
    console.log('  ⚠  Agent needs manual relaunch (status is "pending").');
    console.log(`  Run: npx ai-team launch -b <batchFile> -a ${opts.agent}`);
  } else if (preset === 'retry') {
    console.log('  Agent will re-enter review flow on next orchestrator poll cycle.');
  } else if (preset === 'approved') {
    console.log('  Agent marked as approved. Next round can now proceed if all previous-round agents are done.');
  }
  console.log();
}
