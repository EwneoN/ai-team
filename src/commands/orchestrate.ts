/**
 * orchestrate command — the main orchestration loop.
 *
 * Five phases:
 *   1. Setup: create branches + launch agents (skippable)
 *   2. Poll-Review-Dispatch loop: signal detection → review → approve/relaunch
 *   3. Batch Finalize: wait for sub-PR merges → validate → create batch PR → Copilot review → CI
 *   4. Final report
 *   5. Post-Merge Cleanup: await human merge → delete branches → finalise state
 *
 * Review modes:
 *   - 'copilot'   — (default) adds GitHub Copilot as reviewer, polls for result, auto-fixes
 *   - 'architect' — uses Claude API to review diffs (costs tokens)
 *   - 'none'      — auto-approves immediately (no review)
 */

import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { loadConfig, loadBatch, getAgentConfig, getLogsDir, getSignalsDir, getProjectRoot, getMaxReviewCycles } from '../config.js';
import { getChangedFilesFromDiff, checkBoundaryViolations, formatBoundaryViolationComment } from '../boundary-check.js';
import { readUtf8, writeUtf8, sleep, runValidation, isProcessRunning, execFileSafe } from '../helpers.js';
import { agentLog, header, dim } from '../logger.js';
import { filterOldCodeComments } from '../comment-filter.js';
import {
  getSignalFile,
  readSignal,
  recoverMisplacedSignal,
  readBatchState,
  writeBatchState,
  readOrchState,
  saveOrchState,
  getBatchStateFile,
} from '../signals.js';
import {
  getPRDiff,
  getLatestPRCommitFiles,
  getPRMetadata,
  postPRComment,
  requestCopilotReview,
  getCopilotReview,
  formatCopilotFeedback,
  resolveAllPRReviewThreads,
  getPRState,
  createPR,
  getPRChecks,
  checkoutBranch,
  pullBranch,
  fetchOrigin,
  deleteRemoteBranch,
  deleteLocalBranch,
  revertBoundaryFiles,
  getCurrentBranch,
  commitAndPushSignals,
  commitBatchHousekeeping,
} from '../git.js';
import type { CopilotReviewResult } from '../git.js';
import { generateArchitectReviewPrompt, generateBatchReviewPrompt, generateValidationFixPrompt, generateConsolidatorPrompt, generateRoundSummary, buildCumulativeContext } from '../templates.js';
import { runArchitectReview, launchAgent, spawnBackgroundAgent, spawnVisibleAgent } from '../claude.js';
import { recordCostToOrchState, getCostSummary, formatCostReport, ingestSidecarCosts, deleteSidecarCostFiles } from '../cost-ledger.js';
import { ApiBackoff } from '../api-backoff.js';
import { createBatch } from './create-batch.js';
import { launchAgents } from './launch-agents.js';
import { reviewAgent } from './review-agent.js';
import { validate } from './validate.js';
import { markCommentsSeen, markCommentsReviewed, markCommentOutcome } from '../comment-status.js';
import type { CommentOutcome } from '../types.js';
import { archiveLogs } from './archive-logs.js';
import type {
  OrchestratorConfig,
  BatchConfig,
  BatchAssignment,
  OrchState,
  OrchAgentState,
  ReviewMode,
  ReviewHistoryEntry,
} from '../types.js';

// ── Types ────────────────────────────────────────────────────

export interface OrchestrateOptions {
  batchFile: string;
  skipBranches?: boolean;
  skipLaunch?: boolean;
  reviewOnly?: boolean;
  pollInterval?: number;
  reviewMode?: ReviewMode;
  /** If true, open agents in visible Windows Terminal tabs */
  visible?: boolean;
  /** Override the batch PR title (default: "feat: {batchName}") */
  prTitle?: string;
  /** Idle timeout in minutes. Overrides config.settings.maxOrchestratorMinutes. 0 = disable. */
  timeout?: number;
}

const TERMINAL_STATES = new Set(['approved', 'soft-approved', 'merged', 'failed', 'max-cycles']);
const INCONCLUSIVE_MAX_RETRIES = 5;

// ── Main ─────────────────────────────────────────────────────

export async function orchestrate(opts: OrchestrateOptions): Promise<void> {
  const config = loadConfig();
  const batch = loadBatch(opts.batchFile);
  const batchName = batch.name;

  const skipBranches = opts.skipBranches || opts.reviewOnly || false;
  const skipLaunch = opts.skipLaunch || opts.reviewOnly || false;
  const pollSeconds = opts.pollInterval || config.settings.monitorPollIntervalSeconds;
  const defaultMaxCycles = config.settings.maxReviewCycles;
  const reviewMode: ReviewMode = opts.reviewMode || config.settings.reviewMode || 'copilot';

  header(`Orchestrator — Batch: ${batchName}`);

  // ─── Phase 0: Pre-flight validation ──────────────────────
  if (!skipBranches && !skipLaunch) {
    console.log('  Phase 0: Pre-flight validation...');
    const passed = validate({ batchFile: opts.batchFile });
    if (!passed) {
      throw new Error('Pre-flight validation failed. Fix specs/batch before orchestrating.');
    }
  }

  // ─── Phase 1: Setup ──────────────────────────────────────
  if (!skipBranches) {
    console.log('  Phase 1a: Creating branches...');
    try {
      await createBatch({ batchFile: opts.batchFile, skipValidation: true });
    } catch (err) {
      console.error(`  Branch creation failed: ${err}`);
      console.log('  Continuing — branches may already exist.');
    }
  } else {
    dim('  Skipping branch creation (--skip-branches or --review-only)');
  }

  if (!skipLaunch) {
    // Peek at orchestrator state — skip launch if all agents are already terminal
    const preState = readOrchState(batchName, batch.assignments);
    const allTerminal = Object.values(preState.agents).every(a => TERMINAL_STATES.has(a.status));

    if (allTerminal && Object.keys(preState.agents).length > 0) {
      dim('  Skipping agent launch — all agents already in terminal states');
    } else {
      console.log();
      console.log('  Phase 1b: Launching round 1 agents...');
      try {
        // Only launch Round 1 here. Subsequent rounds are launched by the
        // Phase 2 loop after the previous round's PRs are reviewed + merged.
        // Without roundFilter the old code blocked here on waitForPRsMerged,
        // creating a deadlock (Phase 2 review loop never started).
        const launchedKeys = await launchAgents({ batchFile: opts.batchFile, visible: opts.visible, roundFilter: 1 });

        // Transition launched agents from 'pending' to 'launched'
        const launchState = readOrchState(batchName, batch.assignments);
        let anyTransitioned = false;
        for (const a of batch.assignments.filter(a => (a.round ?? 1) === 1)) {
          const key = `${a.agent}/${a.spec}`;
          if (launchState.agents[key]?.status === 'pending' && launchedKeys.has(key)) {
            launchState.agents[key].status = 'launched';
            anyTransitioned = true;
          }
        }
        if (anyTransitioned) saveOrchState(batchName, launchState);
      } catch (err) {
        console.error(`  Agent launch failed: ${err}`);
        console.log('  Continuing — agents may already be running.');
      }
    }
  } else {
    dim('  Skipping agent launch (--skip-launch or --review-only)');
  }

  const maxBatchBudget = config.settings.maxBatchBudgetUsd ?? 50;
  const apiBackoff = new ApiBackoff();

  const maxMinutes = opts.timeout ?? config.settings.maxOrchestratorMinutes ?? 90;
  const maxMs = maxMinutes > 0 ? maxMinutes * 60_000 : 0; // 0 = disabled
  let lastActivityAt = Date.now();

  console.log();
  console.log('  Phase 2: Poll-Review-Dispatch loop');
  console.log(`  Review mode: ${reviewMode} | Poll interval: ${pollSeconds}s | Max review cycles: ${defaultMaxCycles} (default) | Batch budget: $${maxBatchBudget}`);
  console.log();

  // ─── Phase 2: Poll-Review-Dispatch ───────────────────────

  // Initialise or load orchestrator state
  let orchState = readOrchState(batchName, batch.assignments);

  // Ensure inconclusiveRetries exists on all entries (may be loaded from disk without it)
  for (const [, agentState] of Object.entries(orchState.agents)) {
    if (agentState.inconclusiveRetries === undefined) {
      agentState.inconclusiveRetries = 0;
    }
    if (!agentState.processedSignalIds) {
      agentState.processedSignalIds = [];
    }
  }

  // ─── Startup reconciliation ────────────────────────────
  // On restart, agents may already be running but orchState still shows 'pending'.
  // Cross-reference batchState PIDs to promote pending → launched.
  const startupBatchState = readBatchState(batchName);
  if (startupBatchState) {
    for (const entry of startupBatchState.agents) {
      const key = `${entry.agent}/${entry.spec}`;
      const agentState = orchState.agents[key];
      if (agentState?.status === 'pending' && entry.pid && entry.status !== 'dry-run' && isProcessRunning(entry.pid)) {
        agentLog(entry.agent, `PID ${entry.pid} is alive — reconciling pending → launched`, 'INFO');
        agentState.status = 'launched';
      }
    }
  }

  saveOrchState(batchName, orchState);

  let iteration = 0;

  const abortController = new AbortController();
  const { signal: abortSignal } = abortController;
  const onSigInt = () => { abortController.abort(); };
  process.on('SIGINT', onSigInt);

  try {
    while (true) {
      iteration++;
      let anyActivityThisCycle = false;

      // ─── Idle timeout (resets on activity) ─────────────────
      if (maxMs > 0 && Date.now() - lastActivityAt > maxMs) {
        console.log();
        console.log(`  ⏱ No activity for ${maxMinutes}m — timing out. Saving state and exiting.`);
        console.log(`  Re-run with --review-only to resume.`);
        saveOrchState(batchName, orchState);
        return;
      }

      // ─── Agent death detection + auto-relaunch ─────────────
      const MAX_DEATH_RETRIES = 2;
      const batchState = readBatchState(batchName);
      if (batchState) {
        let batchStateChanged = false;
        for (const entry of batchState.agents) {
          const stateKey = `${entry.agent}/${entry.spec}`;
          const agentState = orchState.agents[stateKey];
          if (!agentState || TERMINAL_STATES.has(agentState.status)) continue;

          if (entry.pid && entry.status !== 'dry-run'
              && (agentState.status === 'pending' || agentState.status === 'launched')) {
            // ── Round guard: don't relaunch agents whose round hasn't been reached ──
            const assignment = batch.assignments.find(a => a.agent === entry.agent && a.spec === entry.spec);
            const agentRound = assignment?.round ?? 1;
            if (agentRound > 1) {
              const prevRoundAssignments = batch.assignments.filter(a => (a.round ?? 1) < agentRound);
              const allPrevTerminal = prevRoundAssignments.every(
                a => TERMINAL_STATES.has(orchState.agents[`${a.agent}/${a.spec}`]?.status)
              );
              if (!allPrevTerminal) {
                // Agent's round hasn't been reached — skip death detection entirely
                continue;
              }
            }

            const signalPath = getSignalFile(batchName, entry.agent, entry.spec);
            let signal = readSignal(signalPath);

            // Always attempt recovery: agent may have written a newer signal to its
            // own workspace. recoverMisplacedSignal compares signalId/reviewCycle and
            // only overwrites when the candidate is genuinely newer.
            if (!isProcessRunning(entry.pid)) {
              const agentCfg = config.agents[entry.agent];
              if (agentCfg?.workingDir) {
                const recovered = recoverMisplacedSignal(batchName, entry.agent, entry.spec, agentCfg.workingDir);
                if (recovered) {
                  signal = recovered;
                  agentLog(entry.agent, `Recovered signal from agent workspace (was written to wrong location)`, 'WARN');
                }
              }
            }

            if (!signal && !isProcessRunning(entry.pid)) {
              const retries = agentState.deathRetries ?? 0;

              if (retries < MAX_DEATH_RETRIES && entry.runnerPath) {
                // Attempt to relaunch the agent
                agentLog(entry.agent, `PID ${entry.pid} is dead (attempt ${retries + 1}/${MAX_DEATH_RETRIES}) — relaunching`, 'WARN');

                let newPid: number | null = null;
                if (opts.visible) {
                  const title = `${entry.agent} — ${entry.spec} (relaunch)`;
                  const launched = spawnVisibleAgent(entry.runnerPath, title);
                  if (launched) newPid = -1; // visible sentinel
                } else {
                  newPid = spawnBackgroundAgent(entry.runnerPath);
                }

                if (newPid !== null) {
                  entry.pid = newPid === -1 ? null : newPid;
                  batchStateChanged = true;
                  agentState.deathRetries = retries + 1;
                  agentLog(entry.agent, `Relaunched successfully (new PID: ${newPid === -1 ? 'visible' : newPid})`, 'INFO');
                  saveOrchState(batchName, orchState);
                  notify(config, `Agent ${entry.agent} auto-relaunched (attempt ${retries + 1}): ${entry.spec}`);
                } else {
                  // Relaunch failed — mark as failed
                  agentLog(entry.agent, `Relaunch failed — marking as failed`, 'ERROR');
                  agentState.status = 'failed';
                  agentState.reviewHistory.push({
                    cycle: 0,
                    verdict: 'FAILED',
                    summary: `Agent process (PID ${entry.pid}) died and relaunch failed`,
                    timestamp: new Date().toISOString(),
                  });
                  saveOrchState(batchName, orchState);
                  notify(config, `Agent ${entry.agent} DIED and relaunch failed: ${entry.spec}`);
                }
              } else {
                // Retries exhausted — mark as failed
                agentLog(entry.agent, `PID ${entry.pid} is dead (retries exhausted: ${retries}/${MAX_DEATH_RETRIES}) — marking as failed`, 'ERROR');
                agentState.status = 'failed';
                agentState.reviewHistory.push({
                  cycle: 0,
                  verdict: 'FAILED',
                  summary: `Agent process (PID ${entry.pid}) died without writing a signal file (after ${retries} relaunch attempts)`,
                  timestamp: new Date().toISOString(),
                });
                saveOrchState(batchName, orchState);
                notify(config, `Agent ${entry.agent} DIED (PID ${entry.pid}, retries exhausted): ${entry.spec}`);
              }
            }
          }
        }
        if (batchStateChanged) {
          writeBatchState(batchName, batchState);
        }
      }

      // ─── Review agent death detection ──────────────────────
      for (const assignment of batch.assignments) {
        const stateKey = `${assignment.agent}/${assignment.spec}`;
        const agentState = orchState.agents[stateKey];
        if (!agentState || TERMINAL_STATES.has(agentState.status)) continue;

        // -1 = visible-running sentinel; skip liveness check (no trackable PID)
        if (agentState.reviewAgentPid && agentState.reviewAgentPid !== -1 && !isProcessRunning(agentState.reviewAgentPid)) {
          agentLog(assignment.agent, `Review agent PID ${agentState.reviewAgentPid} is dead — clearing tracked PID`, 'WARN');
          agentState.reviewAgentPid = null;
          saveOrchState(batchName, orchState);
        }
      }

      // ─── Ingest sidecar cost files from background runners ──
      const ingestedSidecars = ingestSidecarCosts(orchState);
      if (ingestedSidecars.length > 0) {
        saveOrchState(batchName, orchState);
        deleteSidecarCostFiles(ingestedSidecars);
      }

      // ─── Budget circuit breaker ────────────────────────────
      if (checkBudgetExceeded(orchState, batchName, maxBatchBudget, config)) break;

      // ─── Process each agent ────────────────────────────────
      for (const assignment of batch.assignments) {
        const stateKey = `${assignment.agent}/${assignment.spec}`;
        const agentState = orchState.agents[stateKey];
        const maxCycles = getMaxReviewCycles(config, assignment.agent);

        const result = await handleAgent({
          config, batch, batchName, orchState, assignment, agentState,
          maxCycles, iteration, opts, reviewMode, apiBackoff,
        });
        if (result.activity) anyActivityThisCycle = true;
      }

      // ─── Check completion ──────────────────────────────────
      if (showStatusLine(orchState, iteration)) {
        console.log();
        console.log('  All agents have reached terminal states.');
        break;
      }

      // ─── Round transition ──────────────────────────────────
      const roundActivity = await handleRoundTransition(orchState, batch, batchName, opts, iteration, apiBackoff);
      if (roundActivity) anyActivityThisCycle = true;

      // ─── Periodic signal commit (every 10th iteration) ────
      if (iteration % 10 === 0) {
        commitSignalsToBatch(`batch/${batchName}`, getProjectRoot());
      }

      // ─── Poll interval (with API backoff) ─────────────────
      const backoffMs = apiBackoff.getBackoffMs();
      if (backoffMs > 0) {
        const backoffSec = Math.round(backoffMs / 1000);
        agentLog('orchestrator', `GitHub API degraded (${apiBackoff.getDegradedSummary()}) — adding ${backoffSec}s backoff`, 'WARN');
        await sleep(backoffMs, abortSignal);
      }

      // Reset idle timeout on activity
      if (anyActivityThisCycle) lastActivityAt = Date.now();

      const hasAwaitingCopilot = Object.values(orchState.agents).some(a => a.status === 'awaiting-copilot');
      if (anyActivityThisCycle) {
        dim(`  Quick re-poll in 10s (activity this cycle)...`);
        await sleep(10_000, abortSignal);
      } else if (hasAwaitingCopilot) {
        const copilotPollSec = config.settings.copilotReviewPollIntervalSeconds ?? 30;
        dim(`  Polling in ${copilotPollSec}s (awaiting Copilot review)...`);
        await sleep(copilotPollSec * 1000, abortSignal);
      } else {
        dim(`  Polling in ${pollSeconds}s...`);
        await sleep(pollSeconds * 1000, abortSignal);
      }
    }
  } catch (err) {
    if ((err as Error)?.message?.includes('SIGINT') || (err as Error)?.name === 'AbortError') {
      console.log();
      console.log('  Interrupted. State saved.');
      console.log(`  Re-run with --review-only to resume.`);
    } else {
      console.error(`  Error: ${err}`);
      console.log(`  State saved. Re-run with --review-only to resume.`);
    }
    saveOrchState(batchName, orchState);
    // Best-effort: commit signals on exit
    try { commitSignalsToBatch(`batch/${batchName}`, getProjectRoot()); } catch { /* ignore */ }
    return;
  } finally {
    process.removeListener('SIGINT', onSigInt);
  }

  // ─── Phase 3: Batch Finalize ──────────────────────────────
  const allTerminalNow = Object.values(orchState.agents).every(a => TERMINAL_STATES.has(a.status));

  const batchBranch = `batch/${batchName}`;
  const projectRoot = getProjectRoot();

  if (!allTerminalNow) {
    console.log();
    dim('  Skipping Phase 3 — not all agents are in terminal states.');
    dim('  Re-run with --review-only to resume once agents complete.');
    saveOrchState(batchName, orchState);
  } else {
    console.log();
    header('Phase 3: Batch Finalize');

    try {
      await batchFinalize({
        orchState,
        batchName,
        batchBranch,
        batch,
        config,
        pollSeconds,
        projectRoot,
        prTitle: opts.prTitle,
        apiBackoff,
      });
    } catch (err) {
      console.error(`  Batch finalize error: ${err}`);
      console.log('  State saved. Re-run with --review-only to resume.');
    }
    saveOrchState(batchName, orchState);
  }

  // ─── Phase 4: Final Report ───────────────────────────────
  console.log();
  header('Orchestration Complete');
  printFinalReport(orchState, batch);

  // Cost report for this batch
  const costSummary = getCostSummary(batchName, orchState);
  if (costSummary.totalRuns > 0) {
    console.log();
    header('Cost Report');
    console.log(formatCostReport(costSummary));
  }

  // ─── Phase 5: Post-Merge Cleanup ────────────────────────
  const readyForPhase5 = orchState.batchPhase === 'complete'
    || orchState.batchPhase === 'awaiting-merge'
    || orchState.batchPhase === 'merged'
    || orchState.batchPhase === 'closed';

  if (readyForPhase5) {
    console.log();
    header('Phase 5: Post-Merge Cleanup');

    try {
      await postMergeCleanup({
        orchState,
        batchName,
        batchBranch,
        batch,
        config,
        pollSeconds,
        projectRoot,
        apiBackoff,
      });
    } catch (err) {
      console.error(`  Post-merge cleanup error: ${err}`);
      console.log('  State saved. Re-run with --review-only to resume.');
    }
    saveOrchState(batchName, orchState);
  } else {
    dim(`\n  Skipping Phase 5 — batch finalize not complete (batchPhase=${orchState.batchPhase}).`);
  }
}

// ── Phase 3: Batch Finalize ──────────────────────────────────

interface BatchFinalizeOpts {
  orchState: OrchState;
  batchName: string;
  batchBranch: string;
  batch: BatchConfig;
  config: OrchestratorConfig;
  pollSeconds: number;
  projectRoot: string;
  prTitle?: string;
  apiBackoff: ApiBackoff;
}

async function batchFinalize(opts: BatchFinalizeOpts): Promise<void> {
  const { orchState, batchName, batchBranch, batch, config, pollSeconds, projectRoot, apiBackoff } = opts;
  const phase = orchState.batchPhase;

  // If already complete or past, skip
  if (phase === 'complete' || phase === 'awaiting-merge' || phase === 'merged' || phase === 'closed') {
    dim('  Batch finalize already complete — skipping.');
    return;
  }

  // ── Step 3a: Wait for all sub-PRs to merge ────────────────
  if (!phase || phase === 'polling-merges') {
    orchState.batchPhase = 'polling-merges';
    saveOrchState(batchName, orchState);

    console.log('  Step 3a: Waiting for sub-PRs to be merged...');
    let iteration = 0;

    while (true) {
      iteration++;
      let allDone = true;
      const unmerged: string[] = [];

      for (const [key, agentState] of Object.entries(orchState.agents)) {
        // Skip agents with no PR or in non-mergeable states
        if (!agentState.prNumber) continue;
        if (agentState.status === 'failed' || agentState.status === 'max-cycles') continue;

        const state = getPRState(agentState.prNumber);
        if (state === null) {
          apiBackoff.recordFailure('getPRState');
        } else {
          apiBackoff.recordSuccess('getPRState');
        }
        if (state === 'MERGED') {
          // Transition agent to 'merged' if not already
          if (agentState.status !== 'merged') {
            agentLog('orchestrator', `PR #${agentState.prNumber} (${key}) merged — updating status`, 'OK');
            agentState.status = 'merged';
            saveOrchState(batchName, orchState);
          }
          continue;
        }

        if (state === 'CLOSED') {
          agentLog('orchestrator', `PR #${agentState.prNumber} (${key}) was closed without merging — skipping`, 'WARN');
          continue;
        }

        allDone = false;
        unmerged.push(`PR #${agentState.prNumber} (${key})`);
      }

      if (allDone) {
        console.log('  ✅ All sub-PRs merged (or skipped).');
        break;
      }

      if (iteration % 5 === 0 || iteration === 1) {
        dim(`  Waiting for ${unmerged.length} sub-PR(s) to be merged: ${unmerged.join(', ')}`);
      }

      const mergeBackoffMs = apiBackoff.getBackoffMs();
      if (mergeBackoffMs > 0) {
        const backoffSec = Math.round(mergeBackoffMs / 1000);
        agentLog('orchestrator', `GitHub API degraded (${apiBackoff.getDegradedSummary()}) — adding ${backoffSec}s backoff`, 'WARN');
        await sleep(mergeBackoffMs);
      }
      await sleep(pollSeconds * 1000);
    }
  }

  // ── Step 3b: Pull the batch branch ─────────────────────────
  if (!phase || phase === 'polling-merges' || phase === 'consolidating' || phase === 'validating' || phase === 'validation-failed') {
    console.log(`  Step 3b: Pulling batch branch (${batchBranch})...`);

    const checkedOut = checkoutBranch(batchBranch, projectRoot);
    if (!checkedOut) {
      agentLog('orchestrator', `Could not checkout ${batchBranch} — trying pull anyway`, 'WARN');
    }

    const pulled = pullBranch(batchBranch, projectRoot);
    if (pulled) {
      console.log('  ✅ Batch branch up to date.');
    } else {
      agentLog('orchestrator', 'git pull failed — branch may still be usable', 'WARN');
    }

    // Commit any pending signal files directly (already on batch branch)
    commitAndPushSignals(projectRoot);
  }

  // ── Step 3b2: Run consolidator (extract shared utilities) ──
  if (!phase || phase === 'polling-merges') {
    await runConsolidator({ orchState, batchName, batchBranch, batch, config, projectRoot });
  }

  // ── Step 3c: Run local validation ──────────────────────────
  if (!phase || phase === 'polling-merges' || phase === 'consolidating' || phase === 'validating' || phase === 'validation-failed' || phase === 'validation-fixing') {
    orchState.batchPhase = 'validating';
    saveOrchState(batchName, orchState);

    const maxValidationFixCycles = 3;

    // Outer loop: validate → fix → re-validate (up to maxValidationFixCycles)
    let validationPassed = false;
    while (!validationPassed) {
      console.log('  Step 3c: Running local validation (lint, typecheck, test)...');
      const results = runValidation(projectRoot);

      let failedStep: string | null = null;
      let failedOutput = '';
      for (const r of results) {
        const duration = (r.durationMs / 1000).toFixed(1);
        if (r.passed) {
          console.log(`    ✅ ${r.step} passed (${duration}s)`);
        } else {
          console.log(`    ❌ ${r.step} FAILED (${duration}s)`);
          const logFile = join(getLogsDir(), `${batchName}-validation-${r.step}.log`);
          writeUtf8(logFile, r.output);
          console.log(`    Output saved to: ${logFile}`);
          failedStep = r.step;
          failedOutput = r.output;
          break;
        }
      }

      if (!failedStep) {
        validationPassed = true;
        break;
      }

      // Validation failed — attempt auto-fix
      const currentCycle = (orchState.validationFixCycle ?? 0) + 1;
      if (currentCycle > maxValidationFixCycles) {
        orchState.batchPhase = 'validation-failed';
        saveOrchState(batchName, orchState);
        console.log();
        console.log(`  ⚠ Validation still failing after ${maxValidationFixCycles} auto-fix attempts.`);
        console.log('    Fix the issues on the batch branch, then re-run with --review-only to resume.');
        return;
      }

      orchState.validationFixCycle = currentCycle;
      orchState.batchPhase = 'validation-fixing';
      saveOrchState(batchName, orchState);

      agentLog('orchestrator', `Validation failed (${failedStep}) — dispatching auto-fix agent (attempt ${currentCycle}/${maxValidationFixCycles})`, 'WARN');

      const prompt = generateValidationFixPrompt({
        batchName,
        batchBranch,
        step: failedStep,
        cycle: currentCycle,
        maxCycles: maxValidationFixCycles,
        failureOutput: failedOutput.length > 30_000
          ? failedOutput.substring(0, 30_000) + '\n\n[... output truncated at 30K chars ...]'
          : failedOutput,
        projectName: config.project.name,
      });

      const logsDir = getLogsDir();
      const promptFile = join(logsDir, `${batchName}-validation-fix-${currentCycle}.prompt.md`);
      writeUtf8(promptFile, prompt);

      const logFile = join(logsDir, `${batchName}-validation-fix-${currentCycle}.log`);
      const reviewBudget = config.settings.reviewMaxBudgetUsd ?? 2.0;
      const reviewMaxTurns = config.settings.reviewMaxTurns ?? 30;
      const model = config.models.coAgent;

      try {
        const result = await launchAgent({
          config,
          prompt,
          agentKey: 'orchestrator',
          cwd: projectRoot,
          logFile,
          model,
          maxBudgetUsd: reviewBudget,
          maxTurns: reviewMaxTurns,
          onProgress: (msg) => agentLog('orchestrator', msg, 'INFO'),
        });

        if (result.success) {
          agentLog('orchestrator', `Validation-fix agent completed (${result.numTurns} turns, $${result.costUsd.toFixed(4)})`, 'OK');
        } else {
          agentLog('orchestrator', `Validation-fix agent failed: ${result.error ?? 'unknown error'}`, 'ERROR');
        }

        recordCostToOrchState(orchState, {
          timestamp: new Date().toISOString(),
          batchName,
          agent: 'orchestrator',
          spec: 'validation-fix',
          runType: 'validation-fix',
          cycle: currentCycle,
          costUsd: result.costUsd,
          durationMs: result.durationMs,
          numTurns: result.numTurns,
          model,
        });
      } catch (err) {
        agentLog('orchestrator', `Validation-fix agent error: ${err}`, 'ERROR');
      }

      // Pull agent's fixes and re-validate
      pullBranch(batchBranch, projectRoot);
      orchState.batchPhase = 'validating';
      saveOrchState(batchName, orchState);
    }

    console.log('  ✅ All validation checks passed.');
  }

  // ── Step 3d: Create batch PR ───────────────────────────────
  if (phase !== 'awaiting-batch-review' && phase !== 'batch-review-fixing' && phase !== 'awaiting-ci') {
    orchState.batchPhase = 'creating-pr';
    saveOrchState(batchName, orchState);

    // Skip if we already have a batch PR
    if (orchState.batchPRNumber) {
      console.log(`  Step 3d: Batch PR already exists (#${orchState.batchPRNumber}) — skipping creation.`);
    } else {
      console.log('  Step 3d: Creating batch PR...');

      const prTitle = opts.prTitle || `feat: ${batchName}`;
      const prBody = generateBatchPRBody(orchState, batch);
      const baseBranch = batch.baseBranch || config.project.mainBranch || 'main';

      const pr = createPR({
        base: baseBranch,
        head: batchBranch,
        title: prTitle,
        body: prBody,
      });

      if (!pr) {
        agentLog('orchestrator', 'Failed to create batch PR — create manually', 'ERROR');
        return;
      }

      orchState.batchPRNumber = pr.number;
      orchState.batchPRUrl = pr.url;
      saveOrchState(batchName, orchState);

      console.log(`  ✅ Batch PR created: #${pr.number} (${pr.url})`);
    }

    // Request Copilot review on the batch PR
    console.log('  Step 3e: Requesting Copilot review on batch PR...');
    const requested = requestCopilotReview(orchState.batchPRNumber!);
    if (requested) {
      apiBackoff.recordSuccess('requestCopilotReview');
      orchState.batchCopilotReviewRequestedAt = new Date().toISOString();
      saveOrchState(batchName, orchState);
      console.log('  ✅ Copilot review requested.');
    } else {
      apiBackoff.recordFailure('requestCopilotReview');
      agentLog('orchestrator', 'Failed to request Copilot review on batch PR', 'WARN');
    }
  }

  // ── Step 3g: Copilot review-fix loop on batch PR ─────────
  await batchCopilotReviewLoop(orchState, batchName, batchBranch, batch, config, projectRoot, apiBackoff);

  // ── Step 3f: Wait for CI checks ────────────────────────────
  orchState.batchPhase = 'awaiting-ci';
  saveOrchState(batchName, orchState);

  const batchPR = orchState.batchPRNumber!;
  console.log(`  Step 3f: Polling CI checks on PR #${batchPR}...`);

  let ciIteration = 0;
  const ciTimeoutMs = 10 * 60 * 1000; // 10 minutes max wait
  const ciStartTime = Date.now();

  while (true) {
    ciIteration++;

    if (Date.now() - ciStartTime > ciTimeoutMs) {
      agentLog('orchestrator', 'CI check timeout (10m) — check manually', 'WARN');
      break;
    }

    const checks = getPRChecks(batchPR);

    if (!checks || checks.length === 0) {
      if (ciIteration <= 3) {
        dim('    Waiting for CI checks to start...');
        await sleep(15_000);
        continue;
      }
      // After 3 attempts, assume no checks configured
      console.log('  ⚠ No CI checks found — skipping CI wait.');
      break;
    }

    const pending = checks.filter(c => c.bucket === 'pending');
    const failed = checks.filter(c => c.bucket === 'fail');
    const passed = checks.filter(c => c.bucket === 'pass');

    if (pending.length === 0) {
      // All checks have completed
      if (failed.length > 0) {
        console.log(`  ❌ CI checks failed (${failed.length} failure(s)):`);
        for (const f of failed) {
          console.log(`     - ${f.name}: ${f.state}`);
        }
        console.log('  Fix and push to the batch branch, then re-run with --review-only.');
        orchState.batchPhase = 'validation-failed';
        saveOrchState(batchName, orchState);
        return;
      } else {
        console.log(`  ✅ All CI checks passed (${passed.length} check(s)).`);
        break;
      }
    }

    if (ciIteration % 4 === 0 || ciIteration === 1) {
      dim(`    ${pending.length} check(s) still running, ${passed.length} passed, ${failed.length} failed...`);
    }

    await sleep(15_000);
  }

  orchState.batchPhase = 'complete';
  saveOrchState(batchName, orchState);

  console.log();
  console.log(`  🎉 Batch finalize complete! PR #${batchPR} is ready for human merge.`);
  notify(config, `Batch ${batchName} finalized — PR #${batchPR} ready for merge`);
}

// ── Consolidator (Step 3b2) ──────────────────────────────────

/**
 * Pre-check: find duplicated code blocks across the batch's changed files.
 * Returns a human-readable report of duplicated patterns, or null if nothing found.
 *
 * Uses a simple heuristic: extract non-trivial code blocks (5+ consecutive non-blank
 * lines) from each file and check if the same block appears in N+ files.
 */
function findDuplicatedBlocks(projectRoot: string, baseBranch: string, batchBranch: string, threshold: number): string | null {
  try {
    // Get the diff between base and batch branch
    const diff = execSync(
      `git diff ${baseBranch}...${batchBranch} --unified=0 --no-color`,
      { cwd: projectRoot, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
    );

    // Parse added lines per file
    const fileBlocks = new Map<string, string[]>();
    let currentFile = '';

    for (const line of diff.split('\n')) {
      const fileMatch = line.match(/^diff --git a\/.+ b\/(.+)$/);
      if (fileMatch) {
        currentFile = fileMatch[1];
        if (!fileBlocks.has(currentFile)) {
          fileBlocks.set(currentFile, []);
        }
        continue;
      }
      // Only collect added lines (skip signals, test files, docs, config)
      if (
        line.startsWith('+') && !line.startsWith('+++') &&
        currentFile &&
        !currentFile.includes('signals/') &&
        !currentFile.endsWith('.test.ts') &&
        !currentFile.endsWith('.test.tsx') &&
        !currentFile.endsWith('.md') &&
        !currentFile.endsWith('.json')
      ) {
        fileBlocks.get(currentFile)!.push(line.substring(1)); // strip leading +
      }
    }

    // Extract 5+ consecutive non-blank lines as candidate blocks
    const blockToFiles = new Map<string, Set<string>>();

    for (const [file, lines] of fileBlocks) {
      const consecutive: string[] = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith('//') || trimmed.startsWith('import ') || trimmed.startsWith('*')) {
          // End of a block
          if (consecutive.length >= 5) {
            const blockKey = consecutive.join('\n');
            if (!blockToFiles.has(blockKey)) {
              blockToFiles.set(blockKey, new Set());
            }
            blockToFiles.get(blockKey)!.add(file);
          }
          consecutive.length = 0;
        } else {
          consecutive.push(trimmed);
        }
      }

      // Check trailing block
      if (consecutive.length >= 5) {
        const blockKey = consecutive.join('\n');
        if (!blockToFiles.has(blockKey)) {
          blockToFiles.set(blockKey, new Set());
        }
        blockToFiles.get(blockKey)!.add(file);
      }
    }

    // Filter to blocks appearing in threshold+ files
    const duplicates: Array<{ block: string; files: string[] }> = [];
    for (const [block, files] of blockToFiles) {
      if (files.size >= threshold) {
        duplicates.push({ block, files: [...files].sort() });
      }
    }

    if (duplicates.length === 0) return null;

    // Sort by file count descending
    duplicates.sort((a, b) => b.files.length - a.files.length);

    // Build report (cap at 10 patterns to keep prompt manageable)
    const lines: string[] = [];
    for (const dup of duplicates.slice(0, 10)) {
      lines.push(`### Pattern found in ${dup.files.length} files`);
      lines.push('');
      lines.push('Files:');
      for (const f of dup.files) {
        lines.push(`- \`${f}\``);
      }
      lines.push('');
      lines.push('```typescript');
      // Show first 15 lines of the block to keep report concise
      const blockLines = dup.block.split('\n');
      lines.push(...blockLines.slice(0, 15));
      if (blockLines.length > 15) {
        lines.push(`// ... ${blockLines.length - 15} more lines`);
      }
      lines.push('```');
      lines.push('');
    }

    return lines.join('\n');
  } catch (err) {
    agentLog('orchestrator', `Consolidator pre-check failed: ${err}`, 'WARN');
    return null;
  }
}

/**
 * Step 3b2: Run the consolidator agent if duplicated code blocks are detected.
 */
async function runConsolidator(opts: {
  orchState: OrchState;
  batchName: string;
  batchBranch: string;
  batch: BatchConfig;
  config: OrchestratorConfig;
  projectRoot: string;
}): Promise<void> {
  const { orchState, batchName, batchBranch, batch, config, projectRoot } = opts;

  if (config.settings.consolidatorEnabled === false) {
    dim('  Step 3b2: Consolidator disabled — skipping.');
    return;
  }

  console.log('  Step 3b2: Running consolidator pre-check...');

  const baseBranch = batch.baseBranch || config.project.mainBranch || 'main';
  const threshold = config.settings.consolidatorDuplicateThreshold ?? 3;

  const duplicateReport = findDuplicatedBlocks(projectRoot, baseBranch, batchBranch, threshold);

  if (!duplicateReport) {
    console.log(`  ✅ No duplicated code blocks found (threshold: ${threshold}+ files) — skipping consolidator.`);
    return;
  }

  const patternCount = (duplicateReport.match(/### Pattern found/g) || []).length;
  console.log(`  ⚠ Found ${patternCount} duplicated pattern(s) — launching consolidator agent...`);

  orchState.batchPhase = 'consolidating';
  saveOrchState(batchName, orchState);

  // Get changed files list for the prompt
  const changedFilesRaw = execSync(
    `git diff --name-only ${baseBranch}...${batchBranch}`,
    { cwd: projectRoot, encoding: 'utf8' },
  );
  const changedFiles = changedFilesRaw.trim().split('\n').filter(f =>
    !f.includes('signals/') && !f.endsWith('.md') && !f.endsWith('.json'),
  );

  // Load project rules if configured
  let projectRules: string | undefined;
  if (config.settings.projectRulesFile) {
    const rulesPath = join(projectRoot, config.settings.projectRulesFile);
    if (existsSync(rulesPath)) {
      projectRules = readUtf8(rulesPath);
    }
  }

  const prompt = generateConsolidatorPrompt({
    batchName,
    batchBranch,
    projectName: config.project.name,
    changedFiles,
    duplicateReport,
    projectRules,
  });

  const logsDir = getLogsDir();
  const promptFile = join(logsDir, `${batchName}-consolidator.prompt.md`);
  writeUtf8(promptFile, prompt);

  const logFile = join(logsDir, `${batchName}-consolidator.log`);
  const budget = config.settings.consolidatorMaxBudgetUsd ?? 3.0;
  const maxTurns = config.settings.consolidatorMaxTurns ?? 40;
  const model = config.models.coAgent;

  try {
    const result = await launchAgent({
      config,
      prompt,
      agentKey: 'orchestrator',
      cwd: projectRoot,
      logFile,
      model,
      maxBudgetUsd: budget,
      maxTurns: maxTurns,
      onProgress: (msg) => agentLog('orchestrator', msg, 'INFO'),
    });

    if (result.success) {
      agentLog('orchestrator', `Consolidator completed (${result.numTurns} turns, $${result.costUsd.toFixed(4)})`, 'OK');
    } else {
      agentLog('orchestrator', `Consolidator failed: ${result.error ?? 'unknown error'}`, 'WARN');
    }

    recordCostToOrchState(orchState, {
      timestamp: new Date().toISOString(),
      batchName,
      agent: 'orchestrator',
      spec: 'consolidator',
      runType: 'consolidator',
      cycle: 0,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      numTurns: result.numTurns,
      model,
    });
  } catch (err) {
    agentLog('orchestrator', `Consolidator error: ${err}`, 'WARN');
  }

  // Pull consolidator's changes and log the diff
  pullBranch(batchBranch, projectRoot);

  // Log what the consolidator changed so it's visible in the orchestrator output
  try {
    const consolidatorDiff = execSync(
      `git log --oneline -1 --format="%h %s" HEAD`,
      { cwd: projectRoot, encoding: 'utf8' },
    ).trim();
    if (consolidatorDiff) {
      console.log(`  📋 Consolidator commit: ${consolidatorDiff}`);

      const filesChanged = execSync(
        `git diff --name-only HEAD~1 HEAD`,
        { cwd: projectRoot, encoding: 'utf8' },
      ).trim();
      if (filesChanged) {
        console.log('  Files changed by consolidator:');
        for (const f of filesChanged.split('\n')) {
          console.log(`    - ${f}`);
        }
      }
    }
  } catch {
    // Non-critical — if no commit was made, that's fine
  }

  console.log('  ✅ Consolidator step complete.');
}

// ── Phase 5: Post-Merge Cleanup ──────────────────────────────

/**
 * Phase 5: Post-Merge Cleanup.
 *
 * Polls the batch PR until it is merged by a human, then cleans up
 * remote/local branches and transitions the state to 'merged'.
 */
async function postMergeCleanup(opts: {
  orchState: OrchState;
  batchName: string;
  batchBranch: string;
  batch: BatchConfig;
  config: OrchestratorConfig;
  pollSeconds: number;
  projectRoot: string;
  apiBackoff: ApiBackoff;
}): Promise<void> {
  const { orchState, batchName, batchBranch, batch, config, pollSeconds, projectRoot, apiBackoff } = opts;

  const phase = orchState.batchPhase;

  // Already done — skip
  if (phase === 'merged' || phase === 'closed') {
    dim(`  Post-merge cleanup already done (${phase}) — skipping.`);
    return;
  }

  // Phase 3 hasn't finished — don't clean up yet
  if (phase !== 'complete' && phase !== 'awaiting-merge') {
    agentLog('orchestrator', `Batch finalize not complete (batchPhase=${phase}) — skipping Phase 5.`, 'WARN');
    return;
  }

  // Must have a batch PR to wait for
  if (!orchState.batchPRNumber) {
    agentLog('orchestrator', 'No batch PR number — cannot wait for merge. Skipping Phase 5.', 'WARN');
    return;
  }

  // ── Step 5a: Await batch PR merge ──────────────────────────
  if (phase === 'complete' || phase === 'awaiting-merge') {
    orchState.batchPhase = 'awaiting-merge';
    saveOrchState(batchName, orchState);

    console.log(`  Step 5a: Waiting for batch PR #${orchState.batchPRNumber} to be merged...`);

    let iteration = 0;
    while (true) {
      iteration++;

      const prState = getPRState(orchState.batchPRNumber);

      if (prState === null) {
        apiBackoff.recordFailure('getPRState');
      } else {
        apiBackoff.recordSuccess('getPRState');
      }

      if (prState === 'MERGED') {
        console.log(`  ✅ Batch PR #${orchState.batchPRNumber} has been merged.`);
        break;
      }

      if (prState === 'CLOSED') {
        agentLog('orchestrator', `Batch PR #${orchState.batchPRNumber} was closed without merging.`, 'WARN');
        orchState.batchPhase = 'closed';
        saveOrchState(batchName, orchState);
        return;
      }

      if (iteration % 5 === 0 || iteration === 1) {
        dim(`  Still waiting for PR #${orchState.batchPRNumber} to be merged...`);
      }

      const backoffMs = apiBackoff.getBackoffMs();
      if (backoffMs > 0) {
        await sleep(backoffMs);
      }
      await sleep(pollSeconds * 1000);
    }
  }

  // ── Step 5b: Branch cleanup ────────────────────────────────
  console.log('  Step 5b: Cleaning up branches...');

  // Collect all agent branch names (use branchPrefix from config, not raw agent key)
  const agentBranches: string[] = [];
  for (const [key] of Object.entries(orchState.agents)) {
    const [agentKey, spec] = key.split('/');
    const prefix = config.agents[agentKey]?.branchPrefix ?? agentKey;
    agentBranches.push(`${batchBranch}--${prefix}--${spec}`);
  }

  // Delete remote branches (agent branches + batch branch)
  let deletedRemote = 0;
  for (const branch of [...agentBranches, batchBranch]) {
    if (deleteRemoteBranch(branch)) {
      deletedRemote++;
    }
  }
  console.log(`    Deleted ${deletedRemote} remote branch(es).`);

  // Prune stale remote-tracking refs
  fetchOrigin(projectRoot);

  // Switch to main before deleting local branches (can't delete checked-out branch)
  const mainBranch = batch.baseBranch || config.project.mainBranch || 'main';
  checkoutBranch(mainBranch, projectRoot);
  pullBranch(mainBranch, projectRoot);

  // Delete local branches
  let deletedLocal = 0;
  for (const branch of [...agentBranches, batchBranch]) {
    if (deleteLocalBranch(branch)) {
      deletedLocal++;
    }
  }
  console.log(`    Deleted ${deletedLocal} local branch(es).`);

  // ── Step 5c: Archive logs & delete PID state ───────────────
  console.log('  Step 5c: Archiving logs and cleaning up state files...');
  try {
    archiveLogs({ batch: batchName });
  } catch (err) {
    agentLog('orchestrator', `Log archival failed (non-fatal): ${err}`, 'WARN');
  }
  const batchStateFile = getBatchStateFile(batchName);
  if (existsSync(batchStateFile)) {
    const { unlinkSync } = await import('node:fs');
    unlinkSync(batchStateFile);
    console.log(`    Deleted ${batchName}-state.json (PID tracking).`);
  }

  // ── Step 5d: Finalise state ────────────────────────────────
  orchState.batchPhase = 'merged';
  saveOrchState(batchName, orchState);

  // ── Step 5e: Commit housekeeping to main ───────────────────
  console.log('  Step 5e: Committing batch housekeeping...');
  if (commitBatchHousekeeping(batchName, projectRoot)) {
    console.log('    Committed and pushed .ai-team/ state changes.');
  } else {
    agentLog('orchestrator', 'Failed to commit batch housekeeping (non-fatal).', 'WARN');
  }

  console.log();
  console.log(`  🎉 Batch ${batchName} merged and cleaned up.`);
  notify(config, `Batch ${batchName} merged! Cleanup complete.`);
}

// ── Step 3g: Batch Copilot Review Loop ───────────────────────

/**
 * Poll for Copilot review on the batch PR, evaluate the verdict using
 * cycle-aware dedup/soft-approve logic, and dispatch an inline review agent
 * to fix issues if changes are requested. Loops until approved, soft-approved,
 * or max cycles reached.
 */
async function batchCopilotReviewLoop(
  orchState: OrchState,
  batchName: string,
  batchBranch: string,
  _batch: BatchConfig,
  config: OrchestratorConfig,
  projectRoot: string,
  apiBackoff: ApiBackoff,
): Promise<void> {
  const phase = orchState.batchPhase;

  // Skip if already past the review loop
  if (phase === 'awaiting-ci' || phase === 'complete' || phase === 'awaiting-merge' || phase === 'merged' || phase === 'closed') return;

  const maxCycles = config.settings.maxReviewCycles ?? 5;
  const softAfter = config.settings.softApproveAfterCycle ?? 3;
  const softMaxComments = config.settings.softApproveMaxComments ?? 3;
  const pollIntervalMs = (config.settings.copilotReviewPollIntervalSeconds ?? 30) * 1000;
  const timeoutMs = (config.settings.copilotReviewTimeoutMinutes ?? 15) * 60_000;

  if (!orchState.batchReviewHistory) {
    orchState.batchReviewHistory = [];
  }

  const prNumber = orchState.batchPRNumber!;
  const prUrl = orchState.batchPRUrl || `PR #${prNumber}`;

  console.log(`  Step 3g: Copilot review-fix loop on batch PR #${prNumber}...`);

  // Resume handling: if killed during batch-review-fixing, the agent may have
  // already pushed fixes. Re-request Copilot review and continue the loop.
  if (phase === 'batch-review-fixing') {
    agentLog('orchestrator', 'Resuming from batch-review-fixing — re-requesting Copilot review', 'INFO');
    pullBranch(batchBranch, projectRoot);
    const resolved = resolveAllPRReviewThreads(prNumber);
    if (resolved > 0) {
      agentLog('orchestrator', `Resolved ${resolved} review thread(s) on batch PR #${prNumber}`, 'INFO');
    }
    const requested = requestCopilotReview(prNumber);
    if (requested) {
      orchState.batchCopilotReviewRequestedAt = new Date().toISOString();
      saveOrchState(batchName, orchState);
    }
  }

  while ((orchState.batchReviewCycle ?? 0) < maxCycles) {
    // ── Poll for Copilot review ────────────────────────────
    orchState.batchPhase = 'awaiting-batch-review';
    saveOrchState(batchName, orchState);

    let copilotResult: CopilotReviewResult | null | 'api-error' = null;
    const pollStart = Date.now();

    while (true) {
      copilotResult = getCopilotReview(prNumber, orchState.batchCopilotReviewRequestedAt);

      if (copilotResult === 'api-error') {
        apiBackoff.recordFailure('getCopilotReview');
        await sleep(pollIntervalMs);
        continue;
      }
      apiBackoff.recordSuccess('getCopilotReview');

      if (copilotResult) break;

      // Timeout check
      if (Date.now() - pollStart > timeoutMs) {
        agentLog('orchestrator', `Copilot review timed out after ${config.settings.copilotReviewTimeoutMinutes ?? 15}m on batch PR — auto-approving`, 'WARN');
        orchState.batchReviewHistory!.push({
          cycle: (orchState.batchReviewCycle ?? 0) + 1,
          verdict: 'APPROVE',
          summary: 'Copilot review timed out — approved by default',
          timestamp: new Date().toISOString(),
        });
        saveOrchState(batchName, orchState);
        return; // Proceed to CI
      }

      dim(`    Waiting for Copilot review on batch PR #${prNumber}...`);
      await sleep(pollIntervalMs);
    }

    // ── Evaluate verdict ───────────────────────────────────
    const currentCycle = (orchState.batchReviewCycle ?? 0) + 1;
    const allComments = copilotResult.comments;
    const newComments = deduplicateComments(allComments, orchState.batchReviewHistory!);

    let effectiveState: string;
    let softApproveReason: string | null = null;

    if (newComments.length === 0 && allComments.length > 0) {
      effectiveState = copilotResult.state;
      softApproveReason = `all ${allComments.length} comment(s) are duplicates from previous cycles`;
    } else if (softAfter > 0 && currentCycle >= softAfter && newComments.length <= softMaxComments) {
      effectiveState = copilotResult.state;
      softApproveReason = `cycle ${currentCycle} ≥ ${softAfter} with only ${newComments.length} new comment(s) (threshold: ${softMaxComments})`;
    } else if (newComments.length > 0) {
      effectiveState = 'CHANGES_REQUESTED';
    } else {
      effectiveState = copilotResult.state;
    }

    // ── Handle approval / soft-approval ────────────────────
    if (effectiveState === 'APPROVED' || effectiveState === 'COMMENTED') {
      const isSoftApprove = softApproveReason !== null;
      orchState.batchReviewHistory!.push({
        cycle: currentCycle,
        verdict: isSoftApprove ? 'SOFT_APPROVE' : 'APPROVE',
        summary: isSoftApprove
          ? `Soft-approved: ${softApproveReason}. Remaining nits logged for human review.`
          : (copilotResult.body || 'Copilot approved batch PR'),
        timestamp: new Date().toISOString(),
        commentBodies: allComments.map(c => c.body),
      });
      saveOrchState(batchName, orchState);

      if (isSoftApprove) {
        agentLog('orchestrator', `Batch PR SOFT-APPROVED — ${softApproveReason}`, 'OK');
        if (allComments.length > 0) {
          const nitsFile = join(getLogsDir(), `${batchName}-batch-pr-remaining-nits.md`);
          const nitsContent = formatRemainingNits(copilotResult);
          writeUtf8(nitsFile, nitsContent);
          agentLog('orchestrator', `${allComments.length} remaining nit(s) saved to ${nitsFile}`, 'INFO');
        }
      } else {
        agentLog('orchestrator', `Copilot APPROVED batch PR #${prNumber}`, 'OK');
      }
      return; // Proceed to CI
    }

    // ── Handle changes requested ───────────────────────────
    agentLog('orchestrator', `Copilot CHANGES_REQUESTED on batch PR #${prNumber} (cycle ${currentCycle}) — dispatching fix`, 'WARN');

    orchState.batchReviewCycle = currentCycle;
    orchState.batchReviewHistory!.push({
      cycle: currentCycle,
      verdict: 'CHANGES_REQUESTED',
      summary: copilotResult.body || 'Copilot requested changes on batch PR',
      timestamp: new Date().toISOString(),
      commentBodies: allComments.map(c => c.body),
    });
    orchState.batchPhase = 'batch-review-fixing';
    saveOrchState(batchName, orchState);

    // Format feedback and dispatch inline review agent
    const feedbackText = formatCopilotFeedback(copilotResult);
    const feedbackFile = join(getLogsDir(), `${batchName}-batch-pr-review-${currentCycle}-feedback.md`);
    writeUtf8(feedbackFile, feedbackText);

    try {
      await reviewBatchPR({
        batchName,
        batchBranch,
        prNumber,
        prUrl,
        feedbackText,
        cycle: currentCycle,
        maxCycles,
        projectRoot,
        config,
        orchState,
      });
    } catch (err) {
      agentLog('orchestrator', `Batch review agent failed: ${err}`, 'ERROR');
      agentLog('orchestrator', 'Fix manually on the batch branch and re-run with --review-only', 'ERROR');
      orchState.batchPhase = 'validation-failed';
      saveOrchState(batchName, orchState);
      return;
    }

    // Run local validation after agent fixes
    console.log('  Validating after batch review fixes...');
    const results = runValidation(projectRoot);
    let allPassed = true;
    for (const r of results) {
      const duration = (r.durationMs / 1000).toFixed(1);
      if (r.passed) {
        console.log(`    ✅ ${r.step} passed (${duration}s)`);
      } else {
        console.log(`    ❌ ${r.step} FAILED (${duration}s)`);
        const logFile = join(getLogsDir(), `${batchName}-batch-review-validation-${r.step}.log`);
        writeUtf8(logFile, r.output);
        console.log(`    Output saved to: ${logFile}`);
        allPassed = false;
        break;
      }
    }

    if (!allPassed) {
      orchState.batchPhase = 'validation-failed';
      saveOrchState(batchName, orchState);
      console.log();
      console.log('  ⚠ Validation failed after batch review fixes.');
      console.log('    Fix the issues on the batch branch, then re-run with --review-only.');
      return;
    }

    // Resolve old threads so Copilot doesn't re-raise addressed comments
    const resolvedCount = resolveAllPRReviewThreads(prNumber);
    if (resolvedCount > 0) {
      agentLog('orchestrator', `Resolved ${resolvedCount} review thread(s) on batch PR #${prNumber}`, 'INFO');
    }

    // Re-request Copilot review for the next cycle
    console.log('  Re-requesting Copilot review on batch PR...');
    const requested = requestCopilotReview(prNumber);
    if (requested) {
      apiBackoff.recordSuccess('requestCopilotReview');
      orchState.batchCopilotReviewRequestedAt = new Date().toISOString();
      saveOrchState(batchName, orchState);
      console.log('  ✅ Copilot review re-requested.');
    } else {
      apiBackoff.recordFailure('requestCopilotReview');
      agentLog('orchestrator', 'Failed to re-request Copilot review on batch PR', 'WARN');
    }
  }

  // Max cycles reached — proceed to CI anyway
  agentLog('orchestrator', `Batch PR review reached max cycles (${maxCycles}) — proceeding to CI`, 'WARN');
  notify(config, `Batch ${batchName} review hit max cycles (${maxCycles}) — proceeding to CI`);
}

/**
 * Launch an inline review agent to fix Copilot feedback on the batch PR.
 * Runs in the main project workspace on the batch branch.
 */
async function reviewBatchPR(opts: {
  batchName: string;
  batchBranch: string;
  prNumber: number;
  prUrl: string;
  feedbackText: string;
  cycle: number;
  maxCycles: number;
  projectRoot: string;
  config: OrchestratorConfig;
  orchState: OrchState;
}): Promise<void> {
  const { batchName, batchBranch, prNumber, prUrl, feedbackText, cycle, maxCycles, projectRoot, config, orchState } = opts;
  const logsDir = getLogsDir();

  console.log(`  Launching batch review agent (cycle ${cycle} of ${maxCycles})...`);

  const prompt = generateBatchReviewPrompt({
    batchName,
    batchBranch,
    prNumber,
    prUrl,
    cycle,
    maxCycles,
    feedbackText,
    projectName: config.project.name,
  });

  const promptFile = join(logsDir, `${batchName}-batch-pr-review-${cycle}.prompt.md`);
  writeUtf8(promptFile, prompt);

  const logFile = join(logsDir, `${batchName}-batch-pr-review-${cycle}.log`);
  const reviewBudget = config.settings.reviewMaxBudgetUsd ?? 2.0;
  const reviewMaxTurns = config.settings.reviewMaxTurns ?? 30;
  const model = config.models.coAgent;

  const result = await launchAgent({
    config,
    prompt,
    agentKey: 'orchestrator',
    cwd: projectRoot,
    logFile,
    model,
    maxBudgetUsd: reviewBudget,
    maxTurns: reviewMaxTurns,
    onProgress: (msg) => agentLog('orchestrator', msg, 'INFO'),
  });

  if (result.success) {
    agentLog('orchestrator', `Batch review agent completed (${result.numTurns} turns, $${result.costUsd.toFixed(4)})`, 'OK');
  } else {
    agentLog('orchestrator', `Batch review agent failed: ${result.error ?? 'unknown error'}`, 'ERROR');
    throw new Error(`Batch review agent failed: ${result.error ?? 'unknown error'}`);
  }

  // Record cost
  recordCostToOrchState(orchState, {
    timestamp: new Date().toISOString(),
    batchName,
    agent: 'orchestrator',
    spec: 'batch-pr-review',
    runType: 'review-fix',
    cycle,
    costUsd: result.costUsd,
    durationMs: result.durationMs,
    numTurns: result.numTurns,
    model,
  });
  saveOrchState(batchName, orchState);

  // Pull to ensure we have the latest after the agent pushed
  pullBranch(batchBranch, projectRoot);
}

// ── Phase 2 State Machine Handlers ───────────────────────────

interface AgentHandlerContext {
  config: OrchestratorConfig;
  batch: BatchConfig;
  batchName: string;
  orchState: OrchState;
  assignment: BatchAssignment;
  agentState: OrchAgentState;
  maxCycles: number;
  iteration: number;
  opts: OrchestrateOptions;
  reviewMode: ReviewMode;
  apiBackoff: ApiBackoff;
}

interface AgentHandlerResult {
  activity: boolean;
}

/**
 * Commit signal files to the batch branch. Stashes signals, checks out the
 * batch branch, pops the stash, commits+pushes, then restores the original
 * branch. Safe to call from any branch.
 */
function commitSignalsToBatch(batchBranch: string, projectRoot: string): void {
  const originalBranch = getCurrentBranch(projectRoot);

  // Stash only the signal files
  const { code: stashCode } = execFileSafe(
    'git', ['stash', 'push', '-m', 'orchestrator-signals', '--', 'ai-team/signals/'],
    { cwd: projectRoot },
  );
  if (stashCode !== 0) {
    dim('  Signal commit: nothing to stash (no signal changes)');
    return;
  }

  // Checkout batch branch
  if (!checkoutBranch(batchBranch, projectRoot)) {
    agentLog('orchestrator', 'Signal commit: could not checkout batch branch — restoring', 'WARN');
    execFileSafe('git', ['stash', 'pop', '--quiet'], { cwd: projectRoot });
    return;
  }

  // Pull latest to avoid push conflicts
  pullBranch(batchBranch, projectRoot);

  // Pop stashed signals
  const { code: popCode } = execFileSafe('git', ['stash', 'pop'], { cwd: projectRoot });
  if (popCode !== 0) {
    agentLog('orchestrator', 'Signal commit: stash pop failed — restoring original branch', 'WARN');
    checkoutBranch(originalBranch, projectRoot);
    return;
  }

  // Commit and push
  if (commitAndPushSignals(projectRoot)) {
    dim('  ✅ Signals committed to batch branch');
  } else {
    agentLog('orchestrator', 'Signal commit: commit/push failed', 'WARN');
  }

  // Restore original branch
  checkoutBranch(originalBranch, projectRoot);
}

/**
 * Budget circuit breaker — marks all non-terminal agents as failed if the
 * batch cost has exceeded the cap. Returns true if budget was exceeded.
 */
function checkBudgetExceeded(
  orchState: OrchState,
  batchName: string,
  maxBatchBudget: number,
  config: OrchestratorConfig,
): boolean {
  const totalCost = orchState.totalCostUsd ?? 0;
  if (totalCost < maxBatchBudget) return false;

  console.log();
  console.log(`  ⚠  Batch budget exceeded: $${totalCost.toFixed(2)} >= $${maxBatchBudget} cap`);
  console.log('  Marking all non-terminal agents as failed (budget).');
  for (const [key, state] of Object.entries(orchState.agents)) {
    if (!TERMINAL_STATES.has(state.status)) {
      state.status = 'failed';
      agentLog(key, `Budget circuit breaker tripped ($${totalCost.toFixed(2)}/$${maxBatchBudget})`, 'ERROR');
    }
  }
  saveOrchState(batchName, orchState);
  notify(config, `Batch ${batchName} budget exceeded: $${totalCost.toFixed(2)}/$${maxBatchBudget}`);
  return true;
}

/**
 * Top-level agent dispatcher — routes to the appropriate status handler.
 */
async function handleAgent(ctx: AgentHandlerContext): Promise<AgentHandlerResult> {
  // Detect externally-merged PRs — upgrade to 'merged' status.
  // Check terminal-but-unmergeable states (approved, soft-approved, max-cycles)
  // so human merges are detected. Skip in-progress or already-merged agents.
  if (ctx.agentState.prNumber
      && (ctx.agentState.status === 'approved' || ctx.agentState.status === 'soft-approved' || ctx.agentState.status === 'max-cycles')) {
    const prState = getPRState(ctx.agentState.prNumber);
    if (prState === 'MERGED') {
      agentLog(ctx.assignment.agent, `PR #${ctx.agentState.prNumber} was merged — upgrading from ${ctx.agentState.status} to merged`, 'OK');
      ctx.agentState.status = 'merged';
      saveOrchState(ctx.batchName, ctx.orchState);
      return { activity: true };
    }
  }

  if (TERMINAL_STATES.has(ctx.agentState.status)) {
    return { activity: false };
  }

  switch (ctx.agentState.status) {
    case 'awaiting-copilot':
      return handleAwaitingCopilot(ctx);

    case 'changes-requested': {
      // Guard: don't process signals while a review/fix agent is still running.
      if (ctx.agentState.reviewAgentPid && (ctx.agentState.reviewAgentPid === -1 || isProcessRunning(ctx.agentState.reviewAgentPid))) {
        return { activity: false };
      }
      // On first iteration, attempt recovery (re-dispatch with existing feedback).
      // If the signal is newer than the last review, fall through to signal processing.
      if (ctx.iteration === 1) {
        const recovery = await tryChangesRequestedRecovery(ctx);
        if (recovery !== null) return recovery;
      }
      return processNewSignal(ctx);
    }

    default:
      // pending, launched, completed, reviewing — check for new signal
      return processNewSignal(ctx);
  }
}

/**
 * Handle an agent in 'awaiting-copilot' state: poll for Copilot review result,
 * apply cycle-aware dedup/soft-approve logic, dispatch fix or approve.
 */
async function handleAwaitingCopilot(ctx: AgentHandlerContext): Promise<AgentHandlerResult> {
  const { config, batchName, orchState, assignment, agentState, apiBackoff } = ctx;
  const prNumber = agentState.prNumber!;

  // If no review request was tracked (e.g. manual state fix or lost timestamp),
  // check if there's already an unprocessed Copilot review before requesting a new one.
  if (!agentState.copilotReviewRequestedAt) {
    // Use the last review history timestamp as a lower bound — any Copilot review
    // submitted after that is unprocessed and can be used directly.
    const lastReviewTs = agentState.reviewHistory.length > 0
      ? agentState.reviewHistory[agentState.reviewHistory.length - 1]!.timestamp
      : undefined;
    const existingReview = lastReviewTs ? getCopilotReview(prNumber, lastReviewTs) : null;

    if (existingReview && existingReview !== 'api-error') {
      agentLog(assignment.agent, `Found unprocessed Copilot review on PR #${prNumber} — using it directly`, 'INFO');
      agentState.copilotReviewRequestedAt = lastReviewTs;
      saveOrchState(batchName, orchState);
      // Fall through to normal review processing below
    } else {
      agentLog(assignment.agent, `No Copilot review request tracked — requesting on PR #${prNumber}...`, 'INFO');
      const requested = requestCopilotReview(prNumber);
      if (requested) {
        agentState.copilotReviewRequestedAt = new Date().toISOString();
        saveOrchState(batchName, orchState);
        agentLog(assignment.agent, `Copilot review requested — polling for result`, 'INFO');
      } else {
        apiBackoff.recordFailure('requestCopilotReview');
        agentLog(assignment.agent, `Failed to request Copilot review — will retry`, 'WARN');
      }
      return { activity: true };
    }
  }

  // Only consider reviews submitted AFTER we requested the review
  const copilotResult = getCopilotReview(prNumber, agentState.copilotReviewRequestedAt);

  if (copilotResult === 'api-error') {
    apiBackoff.recordFailure('getCopilotReview');
    return { activity: false };
  }
  apiBackoff.recordSuccess('getCopilotReview');

  if (!copilotResult) {
    // Still waiting — check timeout
    const requestedAt = agentState.copilotReviewRequestedAt
      ? new Date(agentState.copilotReviewRequestedAt).getTime()
      : Date.now();
    const timeoutMs = (config.settings.copilotReviewTimeoutMinutes ?? 15) * 60_000;

    if (Date.now() - requestedAt > timeoutMs) {
      agentLog(assignment.agent, `Copilot review timed out after ${config.settings.copilotReviewTimeoutMinutes ?? 15}m — will keep waiting`, 'WARN');
      notify(config, `Agent ${assignment.agent} Copilot review timed out (still waiting): ${assignment.spec}`);
    }
    return { activity: false };
  }

  // ── Cycle-aware review escalation ─────────────────────────
  //
  // Copilot always submits reviews as COMMENTED (never APPROVED or
  // CHANGES_REQUESTED). We need to decide whether inline comments
  // warrant another fix cycle or can be soft-approved.
  //
  // Strategy:
  //  1. Deduplicate: filter out comments whose body closely matches
  //     a comment from a previous review cycle.
  //  2. Early cycles (< softApproveAfterCycle): any inline comments
  //     → CHANGES_REQUESTED (strict, current behaviour).
  //  3. Late cycles (≥ softApproveAfterCycle): if the *new* (non-dup)
  //     comment count is ≤ softApproveMaxComments, soft-approve with
  //     logged nits. Otherwise still escalate.
  //
  // This prevents infinite loops on style nits while keeping the
  // first N cycles strict for genuine quality issues.

  const currentCycle = agentState.lastReviewedCycle + 1;
  const softAfter = config.settings.softApproveAfterCycle ?? 3;
  const softMaxComments = config.settings.softApproveMaxComments ?? 3;

  const allComments = copilotResult.comments;
  const newComments = deduplicateComments(allComments, agentState.reviewHistory);

  // ── Post-dedup severity filtering (old-code nits on late cycles) ────
  const filterCycleCutoff = config.settings.filterOldCodeAfterCycle ?? 3;
  let filteredComments = newComments;
  let skippedNits: Array<{ id?: number; path: string; body: string; line: number | null; reason: string }> = [];

  if (filterCycleCutoff > 0 && currentCycle >= filterCycleCutoff && newComments.length > 0) {
    // Use latest commit's files, not full PR diff — full PR diff marks ALL files as
    // "changed" which defeats the old-code vs changed-code distinction.
    const changedFiles = getLatestPRCommitFiles(prNumber);

    if (changedFiles.length > 0) {
      const filterResult = await filterOldCodeComments(
        newComments, changedFiles, currentCycle, filterCycleCutoff,
      );
      filteredComments = filterResult.forwarded;
      skippedNits = filterResult.skipped;
    }
    // If diff unavailable or no changed files detected, fall through with all comments
  }

  const hasNewComments = filteredComments.length > 0;

  let effectiveState: string;
  let softApproveReason: string | null = null;

  if (filteredComments.length === 0 && allComments.length > 0) {
    const reason = skippedNits.length > 0
      ? `all ${newComments.length} new comment(s) filtered: ${skippedNits.length} old-code nit(s) auto-skipped`
      : `all ${allComments.length} comment(s) are duplicates from previous cycles`;
    effectiveState = copilotResult.state;
    softApproveReason = reason;
  } else if (softAfter > 0 && currentCycle >= softAfter && filteredComments.length <= softMaxComments) {
    effectiveState = copilotResult.state;
    softApproveReason = `cycle ${currentCycle} ≥ ${softAfter} with only ${filteredComments.length} new comment(s) (threshold: ${softMaxComments})`;
  } else if (hasNewComments) {
    effectiveState = 'CHANGES_REQUESTED';
  } else {
    effectiveState = copilotResult.state;
  }

  // ── Comment status tracking: mark comments as seen (👀) ─────────────
  if (allComments.length > 0) {
    const commentIds = allComments.filter((c) => c.id).map((c) => c.id!);
    if (commentIds.length > 0) {
      await markCommentsSeen(prNumber, commentIds, assignment.agent, currentCycle, agentState);
      saveOrchState(batchName, orchState);
    }
  }

  // ── Mark skipped nits with ☑️ ──────────────────────────────────────
  if (skippedNits.length > 0) {
    for (const nit of skippedNits) {
      if (nit.id) {
        markCommentOutcome(prNumber, nit.id, 'skipped', assignment.agent, currentCycle, agentState, nit.reason);
      }
    }
    saveOrchState(batchName, orchState);
    agentLog(assignment.agent, `Auto-skipped ${skippedNits.length} old-code nit(s)`, 'INFO');
  }

  // ── Mark duplicate comments with ☑️ ────────────────────────────────
  const dupComments = allComments.filter((c) => c.id && !newComments.includes(c));
  agentLog(assignment.agent, `Comment triage: ${allComments.length} total, ${newComments.length} new, ${dupComments.length} duplicate, ${skippedNits.length} severity-filtered`, 'INFO');
  if (dupComments.length > 0) {
    for (const dup of dupComments) {
      agentLog(assignment.agent, `Marking comment ${dup.id} as skipped (duplicate)`, 'INFO');
      markCommentOutcome(prNumber, dup.id!, 'skipped', assignment.agent, currentCycle, agentState, 'Duplicate from previous cycle — already addressed');
    }
    saveOrchState(batchName, orchState);
  }

  if (effectiveState === 'APPROVED' || effectiveState === 'COMMENTED') {
    handleCopilotApproval(ctx, copilotResult, allComments, currentCycle, softApproveReason);
  } else if (effectiveState === 'CHANGES_REQUESTED') {
    await handleCopilotChangesRequested(ctx, copilotResult, filteredComments, currentCycle);
  } else {
    agentLog(assignment.agent, `Copilot review state: ${copilotResult.state} — will re-check`, 'WARN');
  }

  return { activity: true };
}

/**
 * Handle Copilot review result: APPROVED or COMMENTED (soft-approve path).
 */
function handleCopilotApproval(
  ctx: AgentHandlerContext,
  copilotResult: CopilotReviewResult,
  allComments: Array<{ id?: number; path: string; body: string; line: number | null }>,
  currentCycle: number,
  softApproveReason: string | null,
): void {
  const { config, batchName, orchState, assignment, agentState } = ctx;
  const prNumber = agentState.prNumber!;
  const isSoftApprove = softApproveReason !== null;

  agentState.status = isSoftApprove ? 'soft-approved' : 'approved';
  agentState.copilotReviewRequestedAt = undefined;
  agentState.reviewHistory.push({
    cycle: currentCycle,
    verdict: isSoftApprove ? 'SOFT_APPROVE' : 'APPROVE',
    summary: isSoftApprove
      ? `Soft-approved: ${softApproveReason}. Remaining nits logged for human review.`
      : (copilotResult.body || 'Copilot approved'),
    timestamp: new Date().toISOString(),
    commentBodies: allComments.map(c => c.body),
  });
  agentLog(assignment.agent, `handleCopilotApproval: saving state with ${(agentState.commentReactions || []).length} reactions`, 'INFO');
  saveOrchState(batchName, orchState);

  if (isSoftApprove) {
    agentLog(assignment.agent, `SOFT-APPROVED PR #${prNumber} — ${softApproveReason}`, 'OK');
    if (allComments.length > 0) {
      const nitsFile = join(getLogsDir(), `${batchName}-${assignment.agent}-${assignment.spec}-remaining-nits.md`);
      const nitsContent = formatRemainingNits(copilotResult);
      writeUtf8(nitsFile, nitsContent);
      agentLog(assignment.agent, `${allComments.length} remaining nit(s) saved to ${nitsFile}`, 'INFO');
    }
    notify(config, `Agent ${assignment.agent} SOFT-APPROVED by Copilot (${softApproveReason}): ${assignment.spec}`);
  } else {
    agentLog(assignment.agent, `Copilot APPROVED PR #${prNumber}`, 'OK');
    notify(config, `Agent ${assignment.agent} APPROVED by Copilot: ${assignment.spec}`);
  }
}

/**
 * Handle Copilot review result: CHANGES_REQUESTED — dispatch a fix cycle.
 */
async function handleCopilotChangesRequested(
  ctx: AgentHandlerContext,
  copilotResult: CopilotReviewResult,
  allComments: Array<{ id?: number; path: string; body: string; line: number | null }>,
  _currentCycle: number,
): Promise<void> {
  const { config, batchName, orchState, assignment, agentState, maxCycles, opts } = ctx;
  const prNumber = agentState.prNumber!;

  agentLog(assignment.agent, `Copilot CHANGES_REQUESTED on PR #${prNumber} — dispatching fix`, 'WARN');

  // Guard: skip dispatch if a review agent is already running.
  // -1 = visible-running sentinel (no trackable PID — treat as running).
  if (agentState.reviewAgentPid && (agentState.reviewAgentPid === -1 || isProcessRunning(agentState.reviewAgentPid))) {
    agentLog(assignment.agent, `Review agent already running (PID: ${agentState.reviewAgentPid}) — skipping duplicate dispatch`, 'WARN');
    return;
  }

  const signalCycle = agentState.lastReviewedCycle + 1;
  const nextCycle = signalCycle + 1;

  if (nextCycle >= maxCycles) {
    agentState.status = 'max-cycles';
    saveOrchState(batchName, orchState);
    agentLog(assignment.agent, `Max review cycles reached (${maxCycles})`, 'ERROR');
    notify(config, `Agent ${assignment.agent} hit max review cycles: ${assignment.spec}`);
    return;
  }

  agentState.lastReviewedCycle = signalCycle;
  agentState.reviewHistory.push({
    cycle: signalCycle,
    verdict: 'CHANGES_REQUESTED',
    summary: copilotResult.body || 'Copilot requested changes',
    timestamp: new Date().toISOString(),
    commentBodies: allComments.map(c => c.body),
  });
  agentState.status = 'changes-requested';
  saveOrchState(batchName, orchState);

  // Review threads are resolved in routeByReviewMode() just before
  // re-requesting Copilot review. This prevents Copilot from re-raising
  // comments that the agent already addressed.

  // ── Comment status tracking: mark comments as reviewed (🧠) ────────
  if (allComments.length > 0) {
    const commentIds = allComments.filter((c) => c.id).map((c) => c.id!);
    if (commentIds.length > 0) {
      await markCommentsReviewed(prNumber, commentIds, assignment.agent, signalCycle, agentState);
      saveOrchState(batchName, orchState);
    }
  }

  // Build feedback with only the filtered comments (allComments is the filtered set
  // when called from the severity-filter path).
  const filteredResult = { ...copilotResult, comments: allComments };
  const feedbackText = formatCopilotFeedback(filteredResult);
  const feedbackFile = join(getLogsDir(), `${batchName}-${assignment.agent}-${assignment.spec}-copilot-review-${nextCycle}-feedback.md`);
  writeUtf8(feedbackFile, feedbackText);

  try {
    const pid = await reviewAgent({
      batchFile: opts.batchFile,
      agent: assignment.agent,
      spec: assignment.spec,
      feedbackFile,
      visible: opts.visible,
      orchestratorCycle: nextCycle,
    });
    agentState.reviewAgentPid = pid;
    saveOrchState(batchName, orchState);
    agentLog(assignment.agent, `Review agent dispatched for cycle ${nextCycle}${pid ? ` (PID: ${pid})` : ''}`, 'INFO');
  } catch (err) {
    if (String(err).includes('REVIEW LIMIT REACHED')) {
      agentState.status = 'max-cycles';
      saveOrchState(batchName, orchState);
      agentLog(assignment.agent, `Review limit reached — marked max-cycles`, 'ERROR');
      notify(config, `Agent ${assignment.agent} hit review limit: ${assignment.spec}`);
    } else {
      agentLog(assignment.agent, `review-agent dispatch failed: ${err}`, 'ERROR');
    }
  }
}

/**
 * On first iteration, try to recover an agent stuck in 'changes-requested'
 * by re-dispatching it with the existing feedback file. Returns null if the
 * signal is newer than the last review (caller should fall through to normal
 * signal processing).
 */
async function tryChangesRequestedRecovery(ctx: AgentHandlerContext): Promise<AgentHandlerResult | null> {
  const { config, batchName, orchState, assignment, agentState, maxCycles, opts } = ctx;

  const signalPath = getSignalFile(batchName, assignment.agent, assignment.spec);
  let signal = readSignal(signalPath);

  // Always attempt recovery: agent may have written a newer signal to its
  // own workspace. recoverMisplacedSignal compares signalId/reviewCycle and
  // only overwrites when the candidate is genuinely newer.
  {
    const agentCfg = getAgentConfig(config, assignment.agent);
    if (agentCfg?.workingDir) {
      const recovered = recoverMisplacedSignal(batchName, assignment.agent, assignment.spec, agentCfg.workingDir);
      if (recovered) {
        signal = recovered;
        agentLog(assignment.agent, `Recovered signal from agent workspace (was written to wrong location)`, 'WARN');
      }
    }
  }

  // Determine whether the signal is new by checking its signalId
  // against the set of already-processed IDs.  Falls back to timestamp
  // comparison for signals written before signalId was introduced.
  const processed = agentState.processedSignalIds ?? [];
  const lastHistoryTs = agentState.reviewHistory.length > 0
    ? agentState.reviewHistory[agentState.reviewHistory.length - 1].timestamp
    : undefined;
  const signalIsNew = signal?.signalId
    ? !processed.includes(signal.signalId)
    : signal?.timestamp && lastHistoryTs
      ? new Date(signal.timestamp).getTime() > new Date(lastHistoryTs).getTime()
      : false;

  if (signalIsNew) {
    return null; // Fall through to normal signal processing
  }

  // No new signal — agent hasn't completed since the last review.
  // Attempt to re-dispatch with existing feedback.
  const nextCycle = agentState.lastReviewedCycle + 1;
  const copilotFeedback = join(getLogsDir(), `${batchName}-${assignment.agent}-${assignment.spec}-copilot-review-${nextCycle}-feedback.md`);
  const archFeedback = join(getLogsDir(), `${batchName}-${assignment.agent}-${assignment.spec}-review-${nextCycle}-feedback.md`);
  const feedbackFile = existsSync(copilotFeedback) ? copilotFeedback : existsSync(archFeedback) ? archFeedback : null;

  if (!feedbackFile) {
    agentLog(assignment.agent, `In changes-requested but no feedback file found for cycle ${nextCycle} — waiting for agent signal or manual intervention`, 'WARN');
    return { activity: false };
  }

  if (nextCycle >= maxCycles) {
    agentState.status = 'max-cycles';
    saveOrchState(batchName, orchState);
    agentLog(assignment.agent, `Max review cycles reached (${maxCycles}) — cannot re-dispatch`, 'ERROR');
    return { activity: false };
  }

  // Guard: skip dispatch if a review agent is already running.
  // -1 = visible-running sentinel (no trackable PID — treat as running).
  if (agentState.reviewAgentPid && (agentState.reviewAgentPid === -1 || isProcessRunning(agentState.reviewAgentPid))) {
    agentLog(assignment.agent, `Review agent already running (PID: ${agentState.reviewAgentPid}) — skipping duplicate dispatch`, 'WARN');
    return { activity: false };
  }

  agentLog(assignment.agent, `Recovering changes-requested state — re-dispatching review cycle ${nextCycle}`, 'WARN');
  try {
    const pid = await reviewAgent({
      batchFile: opts.batchFile,
      agent: assignment.agent,
      spec: assignment.spec,
      feedbackFile,
      visible: opts.visible,
      orchestratorCycle: nextCycle,
    });
    agentState.reviewAgentPid = pid;
    saveOrchState(batchName, orchState);
    agentLog(assignment.agent, `Review agent re-dispatched for cycle ${nextCycle}${pid ? ` (PID: ${pid})` : ''}`, 'INFO');
    return { activity: true };
  } catch (err) {
    if (String(err).includes('REVIEW LIMIT REACHED')) {
      agentState.status = 'max-cycles';
      saveOrchState(batchName, orchState);
      agentLog(assignment.agent, `Review limit reached — marked max-cycles`, 'ERROR');
      notify(config, `Agent ${assignment.agent} hit review limit: ${assignment.spec}`);
    } else {
      agentLog(assignment.agent, `Re-dispatch failed: ${err}`, 'ERROR');
    }
    return { activity: false };
  }
}

/**
 * Read a signal file and process a newly completed agent: validate boundaries,
 * then route to the appropriate review flow (none / copilot / architect).
 */
async function processNewSignal(ctx: AgentHandlerContext): Promise<AgentHandlerResult> {
  const { config, batchName, orchState, assignment, agentState, opts } = ctx;

  const signalPath = getSignalFile(batchName, assignment.agent, assignment.spec);
  let signal = readSignal(signalPath);

  // Always attempt recovery: agent may have written a newer signal to its
  // own workspace. recoverMisplacedSignal compares signalId/reviewCycle and
  // only overwrites when the candidate is genuinely newer.
  {
    const agentCfg = getAgentConfig(config, assignment.agent);
    if (agentCfg?.workingDir) {
      const recovered = recoverMisplacedSignal(batchName, assignment.agent, assignment.spec, agentCfg.workingDir);
      if (recovered) {
        signal = recovered;
        agentLog(assignment.agent, `Recovered signal from agent workspace (was written to wrong location)`, 'WARN');
      }
    }
  }

  if (!signal) return { activity: false };

  if (signal.status === 'failed') {
    if (signal.signalId) {
      agentState.processedSignalIds = agentState.processedSignalIds ?? [];
      agentState.processedSignalIds.push(signal.signalId);
    }
    agentState.status = 'failed';
    saveOrchState(batchName, orchState);
    agentLog(assignment.agent, `FAILED — ${signal.notes || 'no notes'}`, 'ERROR');
    notify(config, `Agent ${assignment.agent} FAILED: ${assignment.spec}`);
    return { activity: false };
  }

  if (signal.status !== 'completed') return { activity: false };

  // Check if we've already processed this signal.
  // Use signalId dedup (drift-proof) with timestamp/cycle as fallback for old signals.
  const processed = agentState.processedSignalIds ?? [];
  const signalCycle = signal.reviewCycle ?? 0;
  const signalIdSeen = signal.signalId ? processed.includes(signal.signalId) : false;
  const alreadyProcessed = signal.signalId
    ? signalIdSeen
    : (() => {
        const lastHistoryEntry = agentState.reviewHistory.length > 0
          ? agentState.reviewHistory[agentState.reviewHistory.length - 1]
          : undefined;
        const signalTs = signal.timestamp ? new Date(signal.timestamp).getTime() : 0;
        const lastReviewTs = lastHistoryEntry?.timestamp ? new Date(lastHistoryEntry.timestamp).getTime() : 0;
        return signalTs > 0 && lastReviewTs > 0
          ? signalTs <= lastReviewTs
          : signalCycle <= agentState.lastReviewedCycle;
      })();

  // Defensive: if the signalId was reused (agent copied from old signal) but there's
  // evidence of new work, process it anyway. This prevents the agent getting stuck
  // in changes-requested when the review-fix agent reuses the old signalId or omits reviewCycle.
  if (alreadyProcessed) {
    const hasNewerCycle = signalCycle > agentState.lastReviewedCycle;
    const agentStuckInChangesRequested = agentState.status === 'changes-requested' && signalIdSeen;
    if (hasNewerCycle || agentStuckInChangesRequested) {
      agentLog(assignment.agent, `Signal ID reused (cycle ${signalCycle}, last ${agentState.lastReviewedCycle}, status ${agentState.status}) — processing anyway`, 'WARN');
    } else {
      return { activity: false };
    }
  }

  // Record this signalId as processed immediately so that early-return
  // code paths (e.g. boundary violations) don't allow the same signal
  // to be re-processed on the next poll iteration.
  if (signal.signalId) {
    agentState.processedSignalIds = agentState.processedSignalIds ?? [];
    agentState.processedSignalIds.push(signal.signalId);
    saveOrchState(batchName, orchState);
  }

  const prNumber = extractPRNumber(signal.prUrl);
  if (!prNumber) {
    agentLog(assignment.agent, `Could not extract PR number from: ${signal.prUrl}`, 'ERROR');
    agentState.status = 'failed';
    saveOrchState(batchName, orchState);
    return { activity: false };
  }

  agentState.prNumber = prNumber;
  agentState.prUrl = signal.prUrl;

  // Post-execution boundary check
  const agentConfig = getAgentConfig(config, assignment.agent);
  if (agentConfig.ownedPaths.length > 0) {
    const diff = getPRDiff(prNumber);
    if (diff) {
      const changedFiles = getChangedFilesFromDiff(diff);
      const violations = checkBoundaryViolations(changedFiles, agentConfig.ownedPaths);
      if (violations.length > 0) {
        const retries = agentState.boundaryRetries ?? 0;

        if (retries < 1) {
          // ── Auto-revert + retry ──────────────────────────────────
          agentLog(assignment.agent, `BOUNDARY VIOLATION — auto-reverting ${violations.length} file(s): ${violations.join(', ')}`, 'WARN');

          const batchBranch = `batch/${batchName}`;
          const agentBranch = `batch/${batchName}--${agentConfig.branchPrefix}--${assignment.spec}`;
          const reverted = revertBoundaryFiles(violations, batchBranch, agentBranch, agentConfig.workingDir);

          if (!reverted) {
            agentLog(assignment.agent, 'Auto-revert failed — marking as failed', 'ERROR');
            agentState.status = 'failed';
            agentState.reviewHistory.push({
              cycle: signalCycle,
              verdict: 'BOUNDARY_VIOLATION',
              summary: `Modified ${violations.length} file(s) outside owned paths (auto-revert failed): ${violations.join(', ')}`,
              timestamp: new Date().toISOString(),
            });
            saveOrchState(batchName, orchState);
            notify(config, `Agent ${assignment.agent} BOUNDARY VIOLATION (revert failed): ${assignment.spec}`);
            return { activity: true };
          }

          agentState.boundaryRetries = retries + 1;
          agentState.lastReviewedCycle = signalCycle;
          agentState.reviewHistory.push({
            cycle: signalCycle,
            verdict: 'BOUNDARY_VIOLATION',
            summary: `Auto-reverted ${violations.length} file(s) outside owned paths: ${violations.join(', ')}`,
            timestamp: new Date().toISOString(),
          });

          // Launch a review cycle with explicit boundary feedback
          const boundaryFeedback = [
            `## Boundary Violation — Auto-Reverted`,
            ``,
            `You modified ${violations.length} file(s) outside your owned paths. These files have been **automatically reverted** from your PR:`,
            ...violations.map(f => `- \`${f}\``),
            ``,
            `Your allowed paths are:`,
            ...agentConfig.ownedPaths.map(p => `- \`${p}\``),
            ``,
            `**Do NOT modify those files again.** If a reviewer asked you to change them, SKIP that comment — note in your commit message why you skipped it.`,
            ``,
            `Please review your remaining changes and ensure they still compile without the reverted files. Run \`npx tsc --noEmit\` and fix any resulting errors within your owned paths only.`,
          ].join('\n');

          const nextCycle = signalCycle + 1;
          const feedbackFile = join(getLogsDir(), `${batchName}-${assignment.agent}-${assignment.spec}-boundary-revert-${nextCycle}-feedback.md`);
          writeUtf8(feedbackFile, boundaryFeedback);

          agentState.status = 'changes-requested';
          saveOrchState(batchName, orchState);

          try {
            const comment = formatBoundaryViolationComment(assignment.agent, violations, agentConfig.ownedPaths);
            postPRComment(prNumber, `${comment}\n\n> **Auto-reverted** — the violating files have been removed and the agent will retry.`);
          } catch { /* non-fatal */ }

          try {
            const pid = await reviewAgent({
              batchFile: opts.batchFile,
              agent: assignment.agent,
              spec: assignment.spec,
              feedbackFile,
              visible: opts.visible,
              orchestratorCycle: nextCycle,
            });
            agentState.reviewAgentPid = pid;
            saveOrchState(batchName, orchState);
            agentLog(assignment.agent, `Boundary-fix review agent dispatched for cycle ${nextCycle}${pid ? ` (PID: ${pid})` : ''}`, 'INFO');
          } catch (err) {
            agentLog(assignment.agent, `Boundary-fix review dispatch failed: ${err}`, 'ERROR');
            agentState.status = 'failed';
            saveOrchState(batchName, orchState);
          }

          return { activity: true };
        }

        // ── Second boundary violation → hard fail ─────────────────
        agentLog(assignment.agent, `BOUNDARY VIOLATION (2nd attempt) — ${violations.length} file(s) outside owned paths: ${violations.join(', ')}`, 'ERROR');
        agentState.status = 'failed';
        agentState.reviewHistory.push({
          cycle: signalCycle,
          verdict: 'BOUNDARY_VIOLATION',
          summary: `Modified ${violations.length} file(s) outside owned paths (2nd violation, hard fail): ${violations.join(', ')}`,
          timestamp: new Date().toISOString(),
        });
        saveOrchState(batchName, orchState);

        try {
          const comment = formatBoundaryViolationComment(assignment.agent, violations, agentConfig.ownedPaths);
          postPRComment(prNumber, comment);
        } catch { /* non-fatal */ }

        notify(config, `Agent ${assignment.agent} BOUNDARY VIOLATION (2nd attempt): ${assignment.spec}`);
        return { activity: true };
      }
    }
  }

  // Agent completed and passed boundary check — clear tracked review PID
  agentState.reviewAgentPid = null;

  // ── Comment status tracking: read agent outcomes ──────────
  if (signalCycle > 0 && prNumber) {
    await processCommentOutcomes(config, batchName, orchState, assignment, agentState, prNumber, signalCycle);
  }

  return routeByReviewMode(ctx, prNumber, signalCycle);
}

/**
 * Read comment-outcomes.json written by the co-agent and update status replies.
 * If no outcome is recorded for a comment, its status is left unchanged
 * (remains in 'reviewed' state) rather than defaulting to 'fixed'.
 */
async function processCommentOutcomes(
  _config: OrchestratorConfig,
  batchName: string,
  orchState: OrchState,
  assignment: BatchAssignment,
  agentState: OrchAgentState,
  prNumber: number,
  cycle: number,
): Promise<void> {
  const reactions = agentState.commentReactions ?? [];
  // Only process comments that were dispatched (status is 'reviewed' or 'will-fix')
  const dispatched = reactions.filter(
    (r) => r.currentStatus === 'reviewed' || r.currentStatus === 'will-fix',
  );
  if (dispatched.length === 0) return;

  // Try to read comment-outcomes.json from signals dir
  const outcomesFile = join(
    getSignalsDir(),
    `${batchName}-${assignment.agent}-${assignment.spec}.comment-outcomes.json`,
  );

  let outcomes: CommentOutcome[] | null = null;
  if (existsSync(outcomesFile)) {
    try {
      const raw = JSON.parse(readUtf8(outcomesFile)) as { outcomes: CommentOutcome[] };
      outcomes = raw.outcomes;
      agentLog(assignment.agent, `Read ${outcomes.length} comment outcome(s) from agent`, 'INFO');
      // Delete after successful read to prevent stale reuse in later cycles
      try { unlinkSync(outcomesFile); } catch { /* ignore */ }
    } catch (err) {
      agentLog(assignment.agent, `Failed to parse comment-outcomes.json: ${err}`, 'WARN');
    }
  }

  for (const reaction of dispatched) {
    const outcome = outcomes?.find((o) => o.commentId === reaction.originalCommentId);
    if (outcome) {
      markCommentOutcome(prNumber, reaction.originalCommentId, outcome.status, assignment.agent, cycle, agentState, outcome.reason);
    } else {
      // No explicit outcome — leave status unchanged (stays in 'reviewed' state).
      // This is safer than defaulting to 'fixed': if the agent crashed or the
      // outcomes file was never written, we don't want to falsely mark comments as resolved.
      agentLog(assignment.agent, `No outcome for comment ${reaction.originalCommentId} — status unchanged`, 'INFO');
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  saveOrchState(batchName, orchState);
}

/**
 * Route a completed agent to the appropriate review flow based on reviewMode.
 */
async function routeByReviewMode(
  ctx: AgentHandlerContext,
  prNumber: number,
  signalCycle: number,
): Promise<AgentHandlerResult> {
  const { config, batch, batchName, orchState, assignment, agentState, maxCycles, reviewMode } = ctx;

  if (reviewMode === 'none') {
    agentState.status = 'approved';
    agentState.lastReviewedCycle = signalCycle;
    agentState.reviewHistory.push({
      cycle: signalCycle,
      verdict: 'APPROVE',
      summary: 'Review skipped (mode: none)',
      timestamp: new Date().toISOString(),
    });
    saveOrchState(batchName, orchState);
    agentLog(assignment.agent, `PR #${prNumber} auto-approved (review mode: none)`, 'OK');
    notify(config, `Agent ${assignment.agent} auto-approved: ${assignment.spec}`);
    return { activity: true };
  }

  if (reviewMode === 'copilot') {
    // Resolve old review threads before re-requesting so Copilot
    // doesn't re-raise already-addressed comments.
    if (signalCycle > 0) {
      const resolved = resolveAllPRReviewThreads(prNumber);
      if (resolved > 0) {
        agentLog(assignment.agent, `Resolved ${resolved} review thread(s) on PR #${prNumber}`, 'INFO');
      }
    }

    agentLog(assignment.agent, `Requesting Copilot review on PR #${prNumber}...`, 'INFO');

    const requested = requestCopilotReview(prNumber);
    if (!requested) {
      ctx.apiBackoff.recordFailure('requestCopilotReview');
      agentLog(assignment.agent, `Failed to request Copilot review — will retry`, 'WARN');
      return { activity: true };
    }
    ctx.apiBackoff.recordSuccess('requestCopilotReview');

    agentState.status = 'awaiting-copilot' as OrchAgentState['status'];
    agentState.copilotReviewRequestedAt = new Date().toISOString();
    saveOrchState(batchName, orchState);
    agentLog(assignment.agent, `Copilot review requested — polling for result`, 'INFO');
    return { activity: true };
  }

  // Architect review (original Claude API mode)
  agentState.status = 'reviewing';
  saveOrchState(batchName, orchState);

  agentLog(assignment.agent, `Architect reviewing PR #${prNumber} (cycle ${signalCycle})...`, 'INFO');

  const reviewResult = await runArchitectReviewForAgent({
    config, batch, assignment, agentState, signalCycle, prNumber, batchName, maxCycles, orchState,
  });

  if (reviewResult === null) {
    agentState.inconclusiveRetries = (agentState.inconclusiveRetries ?? 0) + 1;

    if (agentState.inconclusiveRetries >= INCONCLUSIVE_MAX_RETRIES) {
      agentState.status = 'max-cycles';
      agentLog(assignment.agent, `Max inconclusive retries reached (${INCONCLUSIVE_MAX_RETRIES})`, 'ERROR');
      notify(config, `Agent ${assignment.agent} hit max inconclusive retries: ${assignment.spec}`);
    } else {
      agentState.status = 'completed';
      agentLog(assignment.agent, `Review inconclusive (attempt ${agentState.inconclusiveRetries}/${INCONCLUSIVE_MAX_RETRIES}) — will retry`, 'WARN');
    }
    saveOrchState(batchName, orchState);
    return { activity: true };
  }

  agentState.inconclusiveRetries = 0;
  agentState.lastReviewedCycle = signalCycle;
  agentState.reviewHistory.push({
    cycle: signalCycle,
    verdict: reviewResult.verdict,
    summary: reviewResult.summary,
    timestamp: new Date().toISOString(),
  });

  if (reviewResult.verdict === 'APPROVE') {
    agentState.status = 'approved';
    saveOrchState(batchName, orchState);

    agentLog(assignment.agent, `APPROVED — ${reviewResult.summary}`, 'OK');
    try {
      postPRComment(prNumber, `## Architect Review: APPROVED\n\n${reviewResult.summary}`);
    } catch (err) {
      agentLog(assignment.agent, `Failed to post PR comment: ${err}`, 'WARN');
    }
    notify(config, `Agent ${assignment.agent} APPROVED: ${assignment.spec}`);
  } else {
    await handleArchitectChangesRequested(ctx, prNumber, signalCycle, reviewResult);
  }

  return { activity: true };
}

/**
 * Handle architect review CHANGES_REQUESTED verdict: post comment, dispatch fix.
 */
async function handleArchitectChangesRequested(
  ctx: AgentHandlerContext,
  prNumber: number,
  signalCycle: number,
  reviewResult: ArchitectReviewForAgentResult,
): Promise<void> {
  const { config, batchName, orchState, assignment, agentState, maxCycles, opts } = ctx;
  const nextCycle = signalCycle + 1;

  if (nextCycle >= maxCycles) {
    agentState.status = 'max-cycles';
    saveOrchState(batchName, orchState);

    agentLog(assignment.agent, `Max review cycles reached (${maxCycles})`, 'ERROR');
    try {
      postPRComment(prNumber, `## Architect Review: CHANGES REQUESTED (cycle limit reached)\n\nMax review cycles (${maxCycles}) exceeded. Human intervention required.\n\n${reviewResult.summary}`);
    } catch { /* non-fatal */ }

    notify(config, `Agent ${assignment.agent} hit max review cycles: ${assignment.spec}`);
    return;
  }

  agentState.status = 'changes-requested';
  saveOrchState(batchName, orchState);

  agentLog(assignment.agent, `CHANGES REQUESTED — dispatching review cycle ${nextCycle}`, 'WARN');

  try {
    const issuesMarkdown = formatReviewIssues(reviewResult.issues);
    postPRComment(prNumber, `## Architect Review: CHANGES REQUESTED (cycle ${signalCycle})\n\n${reviewResult.summary}\n\n${issuesMarkdown}`);
  } catch (err) {
    agentLog(assignment.agent, `Failed to post PR comment: ${err}`, 'WARN');
  }

  const feedbackText = formatFeedbackForAgent(reviewResult);
  const feedbackFile = join(getLogsDir(), `${batchName}-${assignment.agent}-${assignment.spec}-review-${nextCycle}-feedback.md`);
  writeUtf8(feedbackFile, feedbackText);

  try {
    await reviewAgent({
      batchFile: opts.batchFile,
      agent: assignment.agent,
      spec: assignment.spec,
      feedbackFile,
      visible: opts.visible,
    });
  } catch (err) {
    if (String(err).includes('REVIEW LIMIT REACHED')) {
      agentState.status = 'max-cycles';
      saveOrchState(batchName, orchState);
      agentLog(assignment.agent, `Review limit reached — marked max-cycles`, 'ERROR');
      notify(config, `Agent ${assignment.agent} hit review limit: ${assignment.spec}`);
    } else {
      agentLog(assignment.agent, `review-agent dispatch failed: ${err}`, 'ERROR');
    }
  }
}

/**
 * Handle round transition: launch the next round when all previous-round
 * agents are terminal and their PRs are merged. Returns true if a new
 * round was launched (activity occurred).
 */
async function handleRoundTransition(
  orchState: OrchState,
  batch: BatchConfig,
  batchName: string,
  opts: OrchestrateOptions,
  iteration: number,
  apiBackoff: ApiBackoff,
): Promise<boolean> {
  const pendingAssignments = batch.assignments.filter(
    a => orchState.agents[`${a.agent}/${a.spec}`].status === 'pending'
  );

  if (pendingAssignments.length === 0) return false;

  const nextRound = Math.min(...pendingAssignments.map(a => a.round ?? 1));

  const prevRoundAssignments = batch.assignments.filter(
    a => (a.round ?? 1) < nextRound
  );
  const allPrevTerminal = prevRoundAssignments.every(
    a => TERMINAL_STATES.has(orchState.agents[`${a.agent}/${a.spec}`].status)
  );

  if (!allPrevTerminal || prevRoundAssignments.length === 0) return false;

  // Block round advancement if ANY previous-round agent failed or hit max-cycles.
  // Failed agents need human attention (reset or fix) before the next round builds on their work.
  const anyPrevFailed = prevRoundAssignments.some(
    a => orchState.agents[`${a.agent}/${a.spec}`].status === 'failed'
        || orchState.agents[`${a.agent}/${a.spec}`].status === 'max-cycles'
  );
  if (anyPrevFailed) {
    if (iteration % 10 === 0) {
      const failedKeys = prevRoundAssignments
        .filter(a => {
          const s = orchState.agents[`${a.agent}/${a.spec}`].status;
          return s === 'failed' || s === 'max-cycles';
        })
        .map(a => `${a.agent}/${a.spec}`);
      dim(`  Round ${nextRound - 1} has failed agent(s) — blocking round ${nextRound}: ${failedKeys.join(', ')}`);
      dim(`  Use "reset --to retry" or "reset --to approved" to unblock.`);
    }
    return false;
  }

  // Check if all previous-round PRs are merged (or have no PR to merge)
  let allMerged = true;
  const unmergedPRs: string[] = [];

  for (const a of prevRoundAssignments) {
    const state = orchState.agents[`${a.agent}/${a.spec}`];
    // Failed agents without a PR — nothing to merge, skip
    if (state.status === 'failed' && !state.prNumber) continue;
    // Failed/max-cycles agents need human intervention — but if the
    // human already merged/closed the PR, allow progress.
    if (state.status === 'max-cycles' || state.status === 'failed') {
      if (state.prNumber) {
        const prState = getPRState(state.prNumber);
        if (prState === null) {
          apiBackoff.recordFailure('getPRState');
        } else {
          apiBackoff.recordSuccess('getPRState');
        }
        if (prState === 'MERGED') continue;
        if (prState === 'CLOSED') continue;
      }
      allMerged = false;
      unmergedPRs.push(`PR #${state.prNumber ?? '?'} (${a.agent}, needs human review)`);
      continue;
    }
    if (!state.prNumber) continue;

    const prState = getPRState(state.prNumber);
    if (prState === null) {
      apiBackoff.recordFailure('getPRState');
      allMerged = false;
      unmergedPRs.push(`PR #${state.prNumber} (${a.agent}, check failed)`);
    } else {
      apiBackoff.recordSuccess('getPRState');
      if (prState !== 'MERGED') {
        allMerged = false;
        unmergedPRs.push(`PR #${state.prNumber} (${a.agent})`);
      }
    }
  }

  if (!allMerged) {
    if (iteration % 10 === 0) {
      dim(`  Waiting for ${unmergedPRs.length} Round ${nextRound - 1} PR(s) to be merged: ${unmergedPRs.join(', ')}`);
    }
    return false;
  }

  console.log();
  agentLog('orchestrator', `Round ${nextRound - 1} PRs all merged — launching round ${nextRound}`, 'OK');

  // Commit signals before launching next round
  commitSignalsToBatch(`batch/${batchName}`, getProjectRoot());

  // Generate context summary for the completed round (context forwarding)
  const completedRound = nextRound - 1;
  const config = loadConfig();
  const contextForwardingEnabled = config.settings.contextForwardingEnabled ?? true;
  let previousRoundContext = '';

  if (contextForwardingEnabled) {
    if (!orchState.roundSummaries) orchState.roundSummaries = {};
    if (!orchState.roundSummaries[completedRound]) {
      orchState.roundSummaries[completedRound] = generateRoundSummary({
        orchState,
        batch,
        round: completedRound,
        readSignalNotes: (agentKey, spec) => {
          const signal = readSignal(getSignalFile(batchName, agentKey, spec));
          return signal?.notes ?? '';
        },
      });
      saveOrchState(batchName, orchState);
      agentLog('orchestrator', `Generated context summary for round ${completedRound}`, 'OK');
    }
    previousRoundContext = buildCumulativeContext(orchState);
  }

  try {
    const launchedKeys = await launchAgents({
      batchFile: opts.batchFile,
      visible: opts.visible,
      roundFilter: nextRound,
      previousRoundContext,
    });
    // Only mark agents that were actually launched (checkout/spawn succeeded)
    for (const pa of pendingAssignments.filter(a => (a.round ?? 1) === nextRound)) {
      const key = `${pa.agent}/${pa.spec}`;
      if (orchState.agents[key]?.status === 'pending' && launchedKeys.has(key)) {
        orchState.agents[key].status = 'launched';
      }
    }
    saveOrchState(batchName, orchState);
    return launchedKeys.size > 0;
  } catch (err) {
    agentLog('orchestrator', `Round ${nextRound} launch failed: ${err}`, 'ERROR');
    return false;
  }
}

// ── Batch PR / Reporting Helpers ─────────────────────────────

/**
 * Generate a structured PR body for the batch PR.
 */
function generateBatchPRBody(orchState: OrchState, batch: BatchConfig): string {
  const lines: string[] = [
    `## Batch: ${orchState.batchName}`,
    '',
    `### Sub-PRs`,
  ];

  for (const [key, agentState] of Object.entries(orchState.agents)) {
    const status = agentState.status;
    const prRef = agentState.prNumber ? `PR #${agentState.prNumber}` : 'no PR';
    if (status === 'approved' || status === 'soft-approved' || status === 'merged') {
      const suffix = status === 'soft-approved' ? ' (soft-approved)' : status === 'merged' ? ' (merged)' : '';
      lines.push(`- [x] ${prRef} — ${key}${suffix}`);
    } else {
      lines.push(`- [ ] ${prRef} — ${key} (status: ${status})`);
    }
  }

  lines.push('', '### Validation', '- [x] Lint passed', '- [x] Typecheck passed', '- [x] Tests passed');

  lines.push('', '### Agent Summary', '| Agent | Spec | PR | Review Cycles | Status |', '|-------|------|----|---------------|--------|');

  for (const assignment of batch.assignments) {
    const key = `${assignment.agent}/${assignment.spec}`;
    const state = orchState.agents[key];
    if (!state) continue;
    const pr = state.prNumber ? `#${state.prNumber}` : '—';
    const cycles = state.reviewHistory.length;
    lines.push(`| ${assignment.agent} | ${assignment.spec} | ${pr} | ${cycles} | ${state.status} |`);
  }

  // If any agents failed, add a known issues section
  const failedAgents = Object.entries(orchState.agents).filter(
    ([, s]) => s.status === 'failed' || s.status === 'max-cycles',
  );
  if (failedAgents.length > 0) {
    lines.push('', '### Known Issues');
    for (const [key, state] of failedAgents) {
      lines.push(`- **${key}**: ${state.status} — needs human intervention`);
    }
  }

  return lines.join('\n');
}

// ── Helper: Run Architect Review for One Agent ───────────────

interface ArchitectReviewForAgentResult {
  verdict: 'APPROVE' | 'CHANGES_REQUESTED';
  summary: string;
  issues: Array<{ severity: string; file: string; description: string }>;
}

async function runArchitectReviewForAgent(opts: {
  config: OrchestratorConfig;
  batch: BatchConfig;
  assignment: { agent: string; spec: string; specPath: string; description: string };
  agentState: OrchAgentState;
  signalCycle: number;
  prNumber: number;
  batchName: string;
  maxCycles: number;
  orchState: OrchState;
}): Promise<ArchitectReviewForAgentResult | null> {
  const { config, assignment, signalCycle, prNumber, batchName, maxCycles, orchState } = opts;

  // Fetch PR diff
  let diff: string;
  try {
    const rawDiff = getPRDiff(prNumber);
    if (!rawDiff) {
      agentLog(assignment.agent, 'PR diff was empty', 'WARN');
      diff = '(empty diff)';
    } else if (rawDiff.length > 80_000) {
      diff = rawDiff.substring(0, 80_000) + '\n\n[... diff truncated at 80K chars ...]';
    } else {
      diff = rawDiff;
    }
  } catch (err) {
    agentLog(assignment.agent, `Failed to fetch PR diff: ${err}`, 'ERROR');
    return null;
  }

  // Read spec content — try relative to project root first, then agent dir
  let specContent: string;
  try {
    const projectRelPath = join(getProjectRoot(), assignment.specPath);
    specContent = readUtf8(projectRelPath);
  } catch {
    try {
      specContent = readUtf8(assignment.specPath);
    } catch {
      const agentCfg = getAgentConfig(config, assignment.agent);
      const altPath = join(agentCfg.workingDir, assignment.specPath);
      try {
        specContent = readUtf8(altPath);
      } catch {
        agentLog(assignment.agent, `Could not read spec: ${assignment.specPath}`, 'WARN');
        specContent = `(Spec file not found: ${assignment.specPath})`;
      }
    }
  }

  // Get PR metadata
  let prBody = '';
  try {
    const meta = getPRMetadata(prNumber);
    prBody = `Title: ${meta?.title ?? ''}\n\n${meta?.body ?? ''}`;
  } catch (err) {
    agentLog(assignment.agent, `Failed to fetch PR metadata: ${err}`, 'WARN');
  }

  // Build the review prompt
  const prompt = generateArchitectReviewPrompt({
    agentKey: assignment.agent,
    specName: assignment.spec,
    description: assignment.description,
    prNumber,
    reviewCycle: signalCycle,
    maxCycles,
    specContent,
    prBody,
    diff,
    projectName: config.project.name,
    architectReviewHints: config.settings.architectReviewHints,
  });

  // Write prompt to log for debugging
  const promptFile = join(getLogsDir(), `${batchName}-architect-review-${assignment.agent}-${assignment.spec}-cycle${signalCycle}.prompt.md`);
  writeUtf8(promptFile, prompt);

  // Run the review via Messages API
  const logFile = join(getLogsDir(), `${batchName}-architect-review-${assignment.agent}-${assignment.spec}-cycle${signalCycle}.log`);

  const result = await runArchitectReview({
    config,
    prompt,
    logFile,
  });

  // Record architect review cost in orch state
  if (result.costUsd > 0) {
    recordCostToOrchState(orchState, {
      timestamp: new Date().toISOString(),
      batchName,
      agent: assignment.agent,
      spec: assignment.spec,
      runType: 'architect-review',
      cycle: signalCycle,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
    });
  }

  if (result.error) {
    agentLog(assignment.agent, `Architect review error: ${result.error}`, 'ERROR');
    return null;
  }

  if (!result.verdict) {
    agentLog(assignment.agent, `Could not parse verdict from review output`, 'WARN');
    return null;
  }

  return {
    verdict: result.verdict.verdict,
    summary: result.verdict.summary,
    issues: result.verdict.issues ?? [],
  };
}

// ── Helper functions ─────────────────────────────────────────

/**
 * Extract PR number from a GitHub PR URL.
 * Handles: https://github.com/owner/repo/pull/123
 */
export function extractPRNumber(prUrl: string | null | undefined): number | null {
  if (!prUrl) return null;
  const match = prUrl.match(/\/pull\/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Format review issues as markdown for PR comments.
 */
function formatReviewIssues(issues: Array<{ severity: string; file: string; description: string }>): string {
  if (!issues || issues.length === 0) return '';

  const lines: string[] = ['### Issues'];
  for (const issue of issues) {
    const emoji = issue.severity === 'critical' ? '🔴' : issue.severity === 'major' ? '🟠' : '🟡';
    lines.push(`- ${emoji} **${issue.severity}** — \`${issue.file}\`: ${issue.description}`);
  }
  return lines.join('\n');
}

/**
 * Format review feedback for the review-agent prompt.
 */
function formatFeedbackForAgent(review: ArchitectReviewForAgentResult): string {
  const lines: string[] = [
    '# Architect Review Feedback',
    '',
    `## Summary`,
    review.summary,
    '',
  ];

  if (review.issues.length > 0) {
    lines.push('## Issues to Fix', '');
    for (const issue of review.issues) {
      lines.push(`### [${issue.severity.toUpperCase()}] ${issue.file}`);
      lines.push(issue.description);
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Show a one-line status summary. Returns true if all agents are terminal.
 */
function showStatusLine(orchState: OrchState, iteration: number): boolean {
  const counts: Record<string, number> = {};
  let allTerminal = true;

  for (const [, agentState] of Object.entries(orchState.agents)) {
    counts[agentState.status] = (counts[agentState.status] ?? 0) + 1;
    if (!TERMINAL_STATES.has(agentState.status)) {
      allTerminal = false;
    }
  }

  const parts: string[] = [];
  for (const [status, count] of Object.entries(counts)) {
    const emoji = {
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
    }[status] ?? '❓';
    parts.push(`${emoji} ${status}: ${count}`);
  }

  console.log(`  [Cycle ${iteration}] ${parts.join('  |  ')}`);
  return allTerminal;
}

/**
 * Print the final summary report.
 */
function printFinalReport(orchState: OrchState, _batch: BatchConfig): void {
  const approved: string[] = [];
  const failed: string[] = [];
  const maxCycles: string[] = [];
  const pending: string[] = [];

  const merged: string[] = [];

  for (const [key, state] of Object.entries(orchState.agents)) {
    switch (state.status) {
      case 'merged':
        merged.push(key);
        break;
      case 'approved':
      case 'soft-approved':
        approved.push(key);
        break;
      case 'failed':
        failed.push(key);
        break;
      case 'max-cycles':
        maxCycles.push(key);
        break;
      default:
        pending.push(key);
        break;
    }
  }

  if (merged.length > 0) {
    console.log(`  🔀 Merged (${merged.length}):`);
    for (const key of merged) {
      const state = orchState.agents[key];
      console.log(`     ${key} — PR #${state.prNumber}`);
    }
    console.log();
  }

  if (approved.length > 0) {
    console.log(`  ✅ Approved (${approved.length}):`);
    for (const key of approved) {
      const state = orchState.agents[key];
      console.log(`     ${key} — PR #${state.prNumber}`);
    }
    console.log();
  }

  if (failed.length > 0) {
    console.log(`  ❌ Failed (${failed.length}):`);
    for (const key of failed) {
      console.log(`     ${key}`);
    }
    console.log();
  }

  if (maxCycles.length > 0) {
    console.log(`  🚫 Max review cycles (${maxCycles.length}):`);
    for (const key of maxCycles) {
      console.log(`     ${key} — needs human intervention`);
    }
    console.log();
  }

  if (pending.length > 0) {
    console.log(`  ⏳ Still pending (${pending.length}):`);
    for (const key of pending) {
      console.log(`     ${key} — status: ${orchState.agents[key].status}`);
    }
    console.log();
  }

  const total = Object.keys(orchState.agents).length;
  const doneCount = approved.length + merged.length;
  console.log(`  Total: ${total} | Merged: ${merged.length} | Approved: ${approved.length} | Failed: ${failed.length + maxCycles.length} | Pending: ${pending.length}`);
  console.log();

  if (doneCount === total) {
    console.log('  🎉 All agents approved/merged! Ready for batch PR to main.');
  } else if (failed.length > 0 || maxCycles.length > 0) {
    console.log('  ⚠ Some agents need manual intervention.');
    console.log('  Fix issues, then re-run with --review-only to continue.');
  }
}

/**
 * Send a desktop notification.
 * Cross-platform:
 *   - macOS:   osascript display notification
 *   - Linux:   notify-send
 *   - Windows: BurntToast → NotifyIcon balloon tip fallback
 * Audio beep on all platforms (best-effort).
 */
function notify(config: OrchestratorConfig, message: string): void {
  if (!config.settings.notifications?.enabled) return;

  const platform = process.platform;
  const title = `${config.project.name} Orchestrator`;

  // 1. Audio beep (best-effort)
  try {
    if (platform === 'win32') {
      execSync(
        `powershell.exe -NoProfile -Command "[Console]::Beep(800, 200); [Console]::Beep(1000, 200); [Console]::Beep(1200, 300)"`,
        { stdio: 'ignore', timeout: 3000 },
      );
    } else if (platform === 'darwin') {
      execSync(`afplay /System/Library/Sounds/Glass.aiff`, { stdio: 'ignore', timeout: 3000 });
    } else {
      // Linux — terminal bell
      execSync(`echo -e '\\a'`, { stdio: 'ignore', timeout: 1000 });
    }
  } catch { /* non-fatal */ }

  if (platform === 'darwin') {
    // macOS: osascript notification
    const escaped = message.replace(/"/g, '\\"');
    const escapedTitle = title.replace(/"/g, '\\"');
    try {
      execSync(
        `osascript -e 'display notification "${escaped}" with title "${escapedTitle}"'`,
        { stdio: 'ignore', timeout: 5000 },
      );
      return;
    } catch { /* non-fatal */ }
  } else if (platform === 'linux') {
    // Linux: notify-send
    const escaped = message.replace(/'/g, "'\\''");
    const escapedTitle = title.replace(/'/g, "'\\''");
    try {
      execSync(
        `notify-send '${escapedTitle}' '${escaped}'`,
        { stdio: 'ignore', timeout: 5000 },
      );
      return;
    } catch { /* non-fatal — notify-send may not be installed */ }
  } else {
    // Windows: BurntToast → NotifyIcon fallback
    const escaped = message.replace(/'/g, "''");
    const escapedTitle = title.replace(/'/g, "''");

    // Try BurntToast (proper Windows notification center toast)
    try {
      execSync(
        `powershell.exe -NoProfile -Command "Import-Module BurntToast -ErrorAction Stop; New-BurntToastNotification -Text '${escapedTitle}','${escaped}'"`,
        { stdio: 'ignore', timeout: 5000 },
      );
      return; // BurntToast worked — done
    } catch { /* fall through to legacy method */ }

    // Fallback: NotifyIcon balloon tip
    try {
      execSync(
        `powershell.exe -NoProfile -Command "[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms'); $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; $n.ShowBalloonTip(5000, '${escapedTitle}', '${escaped}', 'Info'); Start-Sleep 1; $n.Dispose()"`,
        { stdio: 'ignore', timeout: 5000 },
      );
    } catch { /* non-fatal */ }
  }
}

// ── Comment Deduplication ─────────────────────────────────────

// ── Comment Deduplication ─────────────────────────────────────────

/**
 * Normalise a comment body for fuzzy comparison.
 * Strips markdown formatting, collapses whitespace, lowercases.
 */
export function normaliseBody(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, '')  // remove code blocks
    .replace(/`[^`]+`/g, '')          // remove inline code
    .replace(/\*\*|__|\*|_/g, '')     // remove bold/italic markers
    .replace(/#+\s*/g, '')            // remove heading markers
    .replace(/\s+/g, ' ')            // collapse whitespace
    .trim()
    .toLowerCase();
}

/**
 * Check if two comment bodies are similar enough to be considered duplicates.
 * Uses a simple token-overlap ratio (Jaccard-like).
 */
export function areSimilar(bodyA: string, bodyB: string, threshold = 0.7): boolean {
  const a = normaliseBody(bodyA);
  const b = normaliseBody(bodyB);

  // Exact match after normalisation
  if (a === b) return true;

  // Token overlap
  const tokensA = new Set(a.split(' ').filter(t => t.length > 2));
  const tokensB = new Set(b.split(' ').filter(t => t.length > 2));
  if (tokensA.size === 0 || tokensB.size === 0) return false;

  let overlap = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) overlap++;
  }

  const union = new Set([...tokensA, ...tokensB]).size;
  return union > 0 && (overlap / union) >= threshold;
}

/**
 * Filter out comments that closely match a comment from a previous review cycle.
 * Returns only genuinely new comments.
 */
export function deduplicateComments(
  comments: Array<{ path: string; body: string; line: number | null }>,
  reviewHistory: ReviewHistoryEntry[],
): Array<{ path: string; body: string; line: number | null }> {
  // Collect all previous inline comment bodies from review history.
  const previousBodies: string[] = [];
  for (const entry of reviewHistory) {
    if (entry.commentBodies) {
      previousBodies.push(...entry.commentBodies);
    }
  }

  if (previousBodies.length === 0) return comments;

  return comments.filter(comment => {
    for (const prevBody of previousBodies) {
      if (areSimilar(comment.body, prevBody)) return false;
    }
    return true;
  });
}

/**
 * Format remaining nits as a markdown file for human review.
 */
function formatRemainingNits(review: CopilotReviewResult): string {
  const lines: string[] = [
    '# Remaining Nits (Soft-Approved)',
    '',
    'These comments were present in the final Copilot review but the PR was',
    'soft-approved because they are duplicates from previous cycles or the',
    'review cycle threshold was reached with few remaining issues.',
    '',
    `**Copilot verdict:** ${review.state}`,
    `**Total comments:** ${review.comments.length}`,
    '',
  ];

  if (review.body) {
    lines.push('## Review Summary', '', review.body, '');
  }

  if (review.comments.length > 0) {
    lines.push('## Inline Comments', '');
    for (let i = 0; i < review.comments.length; i++) {
      const c = review.comments[i]!;
      const lineRef = c.line ? ` (line ${c.line})` : '';
      lines.push(`### ${i + 1}. ${c.path}${lineRef}`, '', c.body, '');
    }
  }

  return lines.join('\n');
}
