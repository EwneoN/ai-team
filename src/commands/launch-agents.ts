/**
 * launch-agents command — prepare and launch co-agents for a batch.
 * Equivalent to ai-team/scripts/launch-agents.ps1
 *
 * Uses the Agent SDK for background launches and inline (foreground) launches.
 */

import { join, isAbsolute, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { loadConfig, loadBatch, getAgentConfig, getLogsDir, getSignalsDir, resolveModel } from '../config.js';
import { ensureDir, ensureAgentWorkspace, writeUtf8, checkPrerequisites, sleep, execFileSafe } from '../helpers.js';
import { agentLog, header, dim } from '../logger.js';
import { getSignalFile, readSignal, readBatchState, writeBatchState } from '../signals.js';
import { checkoutBranch, getCurrentBranch, fetchOrigin, mergeBatchBranch, remoteBranchExists } from '../git.js';
import { loadTemplate, renderClaudeMd, generateLaunchPrompt } from '../templates.js';
import { generateRunnerScript, spawnBackgroundAgent, spawnVisibleAgent, launchAgent } from '../claude.js';
import { getSidecarCostPath } from '../cost-ledger.js';
import { validateBatch } from './validate.js';
import type { LaunchStateEntry, BatchState, BatchAssignment, OrchestratorConfig } from '../types.js';

export interface LaunchAgentsOptions {
  batchFile: string;
  agent?: string;
  dryRun?: boolean;
  /** If true, run agents inline (foreground) instead of as background processes */
  inline?: boolean;
  /** If true, open each agent in a visible Windows Terminal tab */
  visible?: boolean;
  /**
   * Only launch assignments in this specific round. Skips the inter-round
   * wait-for-signals / wait-for-merges logic (the caller is responsible for
   * sequencing rounds when this is set). Used by the orchestrator to avoid
   * blocking Phase 1b while Phase 2 handles review cycles.
   */
  roundFilter?: number;
  /** Cumulative context from previous rounds, injected into CLAUDE.md */
  previousRoundContext?: string;
}

/**
 * Returns a set of `agent/spec` keys that were actually launched.
 * Callers can use this to avoid marking failed launches as "launched".
 */
export async function launchAgents(opts: LaunchAgentsOptions): Promise<Set<string>> {
  const config = loadConfig();
  const batch = loadBatch(opts.batchFile);
  const batchName = batch.name;
  const batchBranch = `batch/${batchName}`;
  const logsDir = getLogsDir();
  const signalsDir = getSignalsDir();

  header(`Launching Agents — Batch: ${batchName}`);

  if (opts.dryRun) {
    console.log('  ⚠ DRY RUN — files will be generated but agents won\'t start');
    console.log();
  }

  // Check prerequisites
  checkPrerequisites(config, !opts.dryRun);

  ensureDir(logsDir);
  ensureDir(signalsDir);

  // Load template
  const template = loadTemplate();

  // Filter assignments
  let assignments = batch.assignments;
  if (opts.agent) {
    assignments = assignments.filter((a) => a.agent === opts.agent);
    if (assignments.length === 0) {
      throw new Error(`No assignments found for agent '${opts.agent}' in batch '${batchName}'`);
    }
  }

  // ── Workspace collision guard ──────────────────────────────
  // Group assignments by round (default round = 1).
  // Within each round, verify no two assignments share the same workingDir.
  const roundMap = new Map<number, typeof assignments>();
  for (const a of assignments) {
    const r = a.round ?? 1;
    if (!roundMap.has(r)) roundMap.set(r, []);
    roundMap.get(r)!.push(a);
  }

  const sortedRounds = [...roundMap.keys()].sort((a, b) => a - b);

  for (const round of sortedRounds) {
    const group = roundMap.get(round)!;
    const workspaceSeen = new Map<string, string>(); // workingDir → spec
    for (const a of group) {
      const dir = getAgentConfig(config, a.agent).workingDir;
      const prev = workspaceSeen.get(dir);
      if (prev) {
        throw new Error(
          `Workspace collision in round ${round}: specs '${prev}' and '${a.spec}' ` +
          `both target workspace '${dir}'. Move one to a different round.`
        );
      }
      workspaceSeen.set(dir, a.spec);
    }
  }

  // ── Pre-flight boundary validation ─────────────────────
  const validation = validateBatch({ batchFile: opts.batchFile });
  if (validation.errors.length > 0) {
    for (const w of validation.warnings) agentLog('validate', w, 'WARN');
    for (const e of validation.errors) agentLog('validate', e, 'ERROR');
    throw new Error(
      `Pre-flight validation found ${validation.errors.length} error(s). ` +
      'Fix specs/batch before launching agents.'
    );
  }
  for (const w of validation.warnings) agentLog('validate', w, 'WARN');

  if (sortedRounds.length > 1) {
    console.log(`  Batch has ${sortedRounds.length} rounds: ${sortedRounds.join(', ')}`);
    console.log();
  }

  const stateEntries: LaunchStateEntry[] = [];

  for (const round of sortedRounds) {
    // Skip rounds not matching the filter (caller manages round sequencing)
    if (opts.roundFilter !== undefined && round !== opts.roundFilter) {
      continue;
    }

    // If this is not the first round AND no roundFilter is set, wait for
    // previous-round signals + merges (standalone launch-agents behaviour).
    // When roundFilter IS set the caller (orchestrator) handles sequencing.
    if (round > sortedRounds[0] && !opts.dryRun && opts.roundFilter === undefined) {
      const prevRoundSpecs = stateEntries.map(e => e.spec);
      agentLog('orchestrator', `Round ${round}: waiting for round ${round - 1} agents to complete...`, 'INFO');
      await waitForSignals(config, batch.name, prevRoundSpecs, assignments);
      agentLog('orchestrator', `Round ${round - 1} agents done — waiting for PRs to be merged before launching round ${round}...`, 'OK');
      await waitForPRsMerged(config, batch.name, prevRoundSpecs, assignments);
      agentLog('orchestrator', `Round ${round - 1} PRs merged — launching round ${round}`, 'OK');
    }

    if (sortedRounds.length > 1) {
      header(`Round ${round}`);
    }

    const roundAssignments = roundMap.get(round)!;

  for (const assignment of roundAssignments) {
    const agentKey = assignment.agent;
    const specName = assignment.spec;
    const agentCfg = getAgentConfig(config, agentKey);

    const subBranch = `batch/${batchName}--${agentCfg.branchPrefix}--${specName}`;
    const agentDir = agentCfg.workingDir;
    const signalFile = getSignalFile(batchName, agentKey, specName);
    const logFile = join(logsDir, `${batchName}-${agentKey}-${specName}.log`);
    const model = resolveModel(config, agentKey, assignment);

    // Ensure workspace
    const wsReady = ensureAgentWorkspace(agentKey, agentCfg, config.project);
    if (!wsReady) {
      agentLog(agentKey, 'Workspace setup failed — skipping', 'ERROR');
      continue;
    }

    agentLog(agentKey, `Preparing: ${specName}`, 'INFO');

    // 1. Generate CLAUDE.md
    const claudeMd = renderClaudeMd({
      template,
      agentKey,
      agentConfig: agentCfg,
      assignment,
      batchName,
      signalFilePath: signalFile,
      maxReviewCycles: config.settings.maxReviewCycles,
      projectName: config.project.name,
      projectRulesFile: config.settings.projectRulesFile,
      previousRoundContext: opts.previousRoundContext,
    });

    const claudeMdPath = join(agentDir, 'CLAUDE.md');
    writeUtf8(claudeMdPath, claudeMd);
    agentLog(agentKey, '  → CLAUDE.md written', 'INFO');

    // 2. Write prompt file
    const prompt = generateLaunchPrompt(agentCfg, assignment, batchBranch, config.project.name);
    const promptFile = join(logsDir, `${batchName}-${agentKey}-${specName}.prompt.md`);
    writeUtf8(promptFile, prompt);
    agentLog(agentKey, '  → Prompt file written', 'INFO');

    // 3. Ensure sub-branch exists (JIT creation)
    fetchOrigin(agentDir);

    // Delete stale local branch if it exists (leftover from a previous run)
    // Must happen before checkout to avoid checking out an outdated local copy.
    const currentBranch = getCurrentBranch(agentDir);
    if (currentBranch !== subBranch) {
      const { stdout: localBranches } = execFileSafe('git', ['branch', '--list', subBranch], { cwd: agentDir });
      if (localBranches.trim()) {
        // Only delete if the branch has no unpushed commits
        const { stdout: upstreamRef, code: forEachRefCode } = execFileSafe(
          'git', ['for-each-ref', '--format=%(upstream:short)', `refs/heads/${subBranch}`], { cwd: agentDir },
        );
        if (forEachRefCode !== 0) {
          agentLog(agentKey, `Skipping delete of local branch ${subBranch} (failed to determine upstream)`, 'WARN');
        } else if (upstreamRef.trim()) {
          const { stdout: aheadBehind, code: revListCode } = execFileSafe(
            'git', ['rev-list', '--left-right', '--count', `${upstreamRef.trim()}...${subBranch}`], { cwd: agentDir },
          );
          if (revListCode !== 0) {
            agentLog(agentKey, `Skipping delete of local branch ${subBranch} (failed to determine divergence)`, 'WARN');
          } else {
            const parts = aheadBehind.trim().split('\t');
            const ahead = parts.length === 2 ? Number(parts[1]) : 0;
            if (Number.isFinite(ahead) && ahead > 0) {
              agentLog(agentKey, `Skipping delete of local branch ${subBranch} (${ahead} unpushed commit(s))`, 'WARN');
            } else {
              execFileSafe('git', ['branch', '-D', subBranch], { cwd: agentDir });
              agentLog(agentKey, `Deleted stale local branch ${subBranch}`, 'INFO');
            }
          }
        } else {
          // No upstream — delete anyway since JIT branches always push with -u
          execFileSafe('git', ['branch', '-D', subBranch], { cwd: agentDir });
          agentLog(agentKey, `Deleted local branch ${subBranch} (no upstream)`, 'INFO');
        }
      }
    }

    if (currentBranch === subBranch) {
      // Already on the sub-branch — reset to origin to avoid stale local state
      if (remoteBranchExists(subBranch, agentDir)) {
        // Only hard-reset when the working tree is clean
        const { stdout: statusOut } = execFileSafe('git', ['status', '--porcelain'], { cwd: agentDir });
        if (statusOut.trim()) {
          agentLog(agentKey, `Skipping hard reset of ${subBranch} (working tree has uncommitted changes)`, 'WARN');
        } else {
          execFileSafe('git', ['reset', '--hard', `origin/${subBranch}`, '--quiet'], { cwd: agentDir });
          agentLog(agentKey, `Reset ${subBranch} to origin`, 'INFO');
        }
      }
    } else if (remoteBranchExists(subBranch, agentDir)) {
      // Sub-branch already exists on origin — checkout tracking branch
      if (!checkoutBranch(subBranch, agentDir)) {
        agentLog(agentKey, `Could not checkout ${subBranch}`, 'ERROR');
        continue;
      }
    } else {
      // Create sub-branch from batch branch (JIT)
      if (!remoteBranchExists(batchBranch, agentDir)) {
        agentLog(agentKey, `FATAL: Batch branch ${batchBranch} not found on origin — run create-batch first`, 'ERROR');
        continue;
      }
      const { code: createCode } = execFileSafe('git', ['checkout', '-b', subBranch, `origin/${batchBranch}`, '--quiet'], { cwd: agentDir });
      if (createCode !== 0) {
        agentLog(agentKey, `Failed to create ${subBranch} from ${batchBranch}`, 'ERROR');
        continue;
      }
      const { code: pushCode } = execFileSafe('git', ['push', '-u', 'origin', subBranch, '--quiet'], { cwd: agentDir });
      if (pushCode !== 0) {
        agentLog(agentKey, `Created ${subBranch} locally but push failed`, 'WARN');
      }
      agentLog(agentKey, `Created sub-branch ${subBranch} (JIT)`, 'OK');
    }

    // 3b. For round 2+, merge latest batch branch into sub-branch
    if (round > 1) {
      agentLog(agentKey, `Merging latest batch branch into sub-branch (round ${round})...`, 'INFO');
      if (!mergeBatchBranch(batchBranch, agentDir)) {
        agentLog(agentKey, `Merge of ${batchBranch} failed — agent may have stale code`, 'ERROR');
      }
    }

    // 3c. Verify spec file exists on the branch
    if (!assignment.specPath || isAbsolute(assignment.specPath) || assignment.specPath.includes('..')) {
      agentLog(agentKey, `FATAL: Invalid specPath "${assignment.specPath}" — must be a relative path without traversal. Skipping agent.`, 'ERROR');
      continue;
    }
    const specFileOnBranch = resolve(agentDir, assignment.specPath);
    if (!specFileOnBranch.startsWith(resolve(agentDir))) {
      agentLog(agentKey, `FATAL: specPath escapes workspace boundary. Skipping agent.`, 'ERROR');
      continue;
    }
    if (!existsSync(specFileOnBranch)) {
      agentLog(agentKey, `FATAL: Spec file not found at ${specFileOnBranch}. Ensure specs are committed to ${batchBranch} before launching. Skipping agent.`, 'ERROR');
      continue;
    }
    let specContent: string;
    try {
      specContent = readFileSync(specFileOnBranch, 'utf-8').trim();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      agentLog(agentKey, `FATAL: Failed to read spec file at ${specFileOnBranch}: ${message}. Skipping agent.`, 'ERROR');
      continue;
    }
    if (!specContent) {
      agentLog(agentKey, `FATAL: Spec file at ${specFileOnBranch} is empty. Skipping agent.`, 'ERROR');
      continue;
    }

    // 4. Launch
    let agentPid: number | null = null;

    if (!opts.dryRun) {
      // Stagger launches
      if (stateEntries.length > 0) {
        const staggerDelay = config.settings.launchStaggerSeconds;
        if (staggerDelay > 0) {
          agentLog(agentKey, `Waiting ${staggerDelay}s before launch (stagger)`, 'INFO');
          await sleep(staggerDelay * 1000);
        }
      }

      if (opts.inline) {
        // Inline (foreground) launch via Agent SDK
        agentLog(agentKey, `Launching inline via Agent SDK (model: ${model})...`, 'INFO');
        const result = await launchAgent({
          config,
          prompt,
          agentKey,
          cwd: agentDir,
          logFile,
          model,
          onProgress: (msg) => agentLog(agentKey, msg, 'INFO'),
        });

        if (result.success) {
          agentLog(agentKey, `Completed (${result.numTurns} turns, $${result.costUsd.toFixed(4)})`, 'OK');
        } else {
          agentLog(agentKey, `Failed: ${result.error ?? 'unknown error'}`, 'ERROR');
        }

        // Write cost sidecar for orchestrator to ingest
        try {
          const entry = {
            timestamp: new Date().toISOString(),
            batchName,
            agent: agentKey,
            spec: specName,
            runType: 'launch' as const,
            cycle: 0,
            costUsd: result.costUsd,
            durationMs: result.durationMs,
            numTurns: result.numTurns,
            model,
          };
          writeUtf8(getSidecarCostPath(batchName, agentKey, specName), JSON.stringify(entry, null, 2));
        } catch (err) {
          agentLog(agentKey, `Failed to write cost sidecar: ${err}`, 'WARN');
        }
      } else {
        // Background launch via generated runner script
        const runnerContent = generateRunnerScript({
          config,
          agentKey,
          specName,
          batchName,
          subBranch,
          agentDir,
          promptFile,
          logFile,
          displayName: agentCfg.displayName,
          model,
        });

        const runnerPath = join(logsDir, `${batchName}-${agentKey}-${specName}-runner.mjs`);
        writeUtf8(runnerPath, runnerContent);
        agentLog(agentKey, '  → Runner script written', 'INFO');

        if (opts.visible) {
          const launched = spawnVisibleAgent(runnerPath, `${agentCfg.displayName} — ${specName}`);
          if (launched) {
            agentLog(agentKey, 'Launched in visible terminal', 'OK');
          } else {
            agentLog(agentKey, 'Visible launch failed — falling back to background', 'WARN');
            agentPid = spawnBackgroundAgent(runnerPath);
          }
        } else {
          agentPid = spawnBackgroundAgent(runnerPath);
        }
        if (!opts.visible && agentPid) {
          agentLog(agentKey, `Launched background (PID: ${agentPid})`, 'OK');
        } else if (!opts.visible && !agentPid) {
          agentLog(agentKey, 'Failed to launch background process', 'ERROR');
        }
      }
    } else {
      agentLog(agentKey, 'DRY RUN — would launch here', 'WARN');
    }

    // 5. Record state
    stateEntries.push({
      agent: agentKey,
      spec: specName,
      description: assignment.description,
      branch: subBranch,
      pid: agentPid,
      logFile,
      signalFile,
      runnerPath: join(logsDir, `${batchName}-${agentKey}-${specName}-runner.mjs`),
      promptFile,
      claudeMdPath,
      startedAt: new Date().toISOString(),
      status: opts.dryRun ? 'dry-run' : 'running',
    });
  }

  } // close round loop

  // Save batch state (merge with existing when roundFilter is set to preserve
  // earlier round entries that were launched separately)
  let existingAgents: LaunchStateEntry[] = [];
  if (opts.roundFilter !== undefined) {
    const existing = readBatchState(batchName);
    if (existing) {
      // Deduplicate: keep only entries NOT in the current launch set
      const newKeys = new Set(stateEntries.map((e) => `${e.agent}/${e.spec}`));
      existingAgents = existing.agents.filter((e) => !newKeys.has(`${e.agent}/${e.spec}`));
    }
  }

  const state: BatchState = {
    batchName,
    batchBranch,
    batchFile: opts.batchFile,
    startedAt: new Date().toISOString(),
    agents: [...existingAgents, ...stateEntries],
  };
  writeBatchState(batchName, state);

  // Summary
  const running = stateEntries.filter((e) => e.status === 'running').length;
  const dryRunCount = stateEntries.filter((e) => e.status === 'dry-run').length;

  console.log();
  if (running > 0) {
    console.log(`  ${running} agent(s) launched.`);
    console.log();
    dim('Monitor progress:');
    console.log(`    npx tsx ai-team/cli/src/index.ts monitor ${batchName}`);
    console.log();
    dim('Tail a specific agent\'s log:');
    for (const entry of stateEntries) {
      console.log(`    Get-Content '${entry.logFile}' -Wait -Tail 50  # ${entry.agent}`);
    }
  } else if (dryRunCount > 0) {
    console.log(`  Dry run complete. ${dryRunCount} agent(s) prepared.`);
    dim('Review the generated files, then re-run without --dry-run.');
  }
  console.log();

  return new Set(stateEntries.map(e => `${e.agent}/${e.spec}`));
}

/**
 * Poll signal files until every spec in `specNames` has a completed/failed signal.
 * Used to serialize rounds — blocks until the previous round finishes.
 */
async function waitForSignals(
  config: OrchestratorConfig,
  batchName: string,
  specNames: string[],
  assignments: BatchAssignment[],
): Promise<void> {
  const pollInterval = (config.settings.monitorPollIntervalSeconds ?? 30) * 1000;
  const specToAgent = new Map(assignments.map(a => [a.spec, a.agent]));

  while (true) {
    let allDone = true;
    for (const spec of specNames) {
      const agentKey = specToAgent.get(spec);
      if (!agentKey) continue;
      const signalPath = getSignalFile(batchName, agentKey, spec);
      if (!existsSync(signalPath)) {
        allDone = false;
        break;
      }
      const signal = readSignal(signalPath);
      if (!signal || (signal.status !== 'completed' && signal.status !== 'failed')) {
        allDone = false;
        break;
      }
    }
    if (allDone) return;
    await sleep(pollInterval);
  }
}

/**
 * After all signals indicate completion, wait for the corresponding PRs
 * to be merged into the batch branch before launching the next round.
 * This prevents round N+1 agents from working against stale code.
 */
async function waitForPRsMerged(
  config: OrchestratorConfig,
  batchName: string,
  specNames: string[],
  assignments: BatchAssignment[],
): Promise<void> {
  const pollInterval = (config.settings.monitorPollIntervalSeconds ?? 30) * 1000;
  const specToAgent = new Map(assignments.map(a => [a.spec, a.agent]));

  while (true) {
    let allMerged = true;
    for (const spec of specNames) {
      const agentKey = specToAgent.get(spec);
      if (!agentKey) continue;
      const signalPath = getSignalFile(batchName, agentKey, spec);
      const signal = readSignal(signalPath);
      if (!signal?.prUrl) continue; // failed agents without PRs — skip

      // Extract PR number from URL (e.g. https://github.com/owner/repo/pull/9 → 9)
      const prMatch = signal.prUrl.match(/\/pull\/(\d+)/);
      if (!prMatch) continue;
      const prNumber = prMatch[1];

      try {
        const result = execFileSafe('gh', ['pr', 'view', prNumber, '--json', 'state', '--jq', '.state']);
        const prState = result.stdout.trim();
        if (prState !== 'MERGED') {
          allMerged = false;
          agentLog(agentKey, `PR #${prNumber} state: ${prState} — waiting for merge`, 'INFO');
          break;
        }
      } catch {
        allMerged = false;
        break;
      }
    }
    if (allMerged) return;
    await sleep(pollInterval);
  }
}
