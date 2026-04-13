/**
 * review-agent command — re-launch a co-agent to address review feedback.
 * Equivalent to ai-team/scripts/review-agent.ps1
 *
 * Supports both inline (foreground) and background launch via Agent SDK.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, loadBatch, getAgentConfig, getLogsDir, getMaxReviewCycles, resolveModel } from '../config.js';
import { ensureDir, writeUtf8, readUtf8, installPostCommitHook, getBoundaryHookOpts } from '../helpers.js';
import { agentLog, header } from '../logger.js';
import { getSignalFile, readReviewState, writeReviewState, readSignal } from '../signals.js';
import { checkoutBranch, getCurrentBranch, pullBranch } from '../git.js';
import { getPRReviewComments } from '../git.js';
import { generateReviewPrompt, renderReviewClaudeMd } from '../templates.js';
import { launchAgent, generateRunnerScript, spawnBackgroundAgent, spawnVisibleAgent } from '../claude.js';
import { getSidecarCostPath } from '../cost-ledger.js';


export interface ReviewAgentOptions {
  batchFile: string;
  agent: string;
  spec: string;
  feedback?: string;
  feedbackFile?: string;
  prNumber?: number;
  interactive?: boolean;
  /** If true, open the agent in a visible Windows Terminal tab */
  visible?: boolean;
  /** Cycle number from the orchestrator — ensures signal reviewCycle matches the orchestrator's expectation */
  orchestratorCycle?: number;
}

export async function reviewAgent(opts: ReviewAgentOptions): Promise<number | null> {
  const config = loadConfig();
  const batch = loadBatch(opts.batchFile);
  const batchName = batch.name;
  const maxCycles = getMaxReviewCycles(config, opts.agent);

  // Find the assignment
  const assignment = batch.assignments.find(
    (a) => a.agent === opts.agent && a.spec === opts.spec,
  );
  if (!assignment) {
    throw new Error(`No assignment found for agent '${opts.agent}' with spec '${opts.spec}' in batch '${batchName}'`);
  }

  const agentCfg = getAgentConfig(config, opts.agent);
  const subBranch = `batch/${batchName}--${agentCfg.branchPrefix}--${opts.spec}`;
  const agentDir = agentCfg.workingDir;
  const signalFile = getSignalFile(batchName, opts.agent, opts.spec);
  const logsDir = getLogsDir();

  header(`Review Agent — ${agentCfg.displayName} / ${opts.spec}`);

  // Collect feedback
  let feedbackText = '';

  if (opts.feedback) {
    feedbackText = opts.feedback;
  }

  if (opts.feedbackFile) {
    if (!existsSync(opts.feedbackFile)) {
      throw new Error(`Feedback file not found: ${opts.feedbackFile}`);
    }
    const fileFeedback = readUtf8(opts.feedbackFile);
    feedbackText = feedbackText ? `${feedbackText}\n\n---\n\n${fileFeedback}` : fileFeedback;
  }

  if (opts.prNumber && opts.prNumber > 0) {
    agentLog(opts.agent, `Pulling review comments from PR #${opts.prNumber}`, 'INFO');
    const parts = getPRReviewComments(opts.prNumber);
    if (parts.length > 0) {
      const prFeedback = parts.join('\n\n---\n\n');
      feedbackText = feedbackText ? `${feedbackText}\n\n---\n\n${prFeedback}` : prFeedback;
      agentLog(opts.agent, `Collected ${parts.length} review comment(s)`, 'OK');
    } else {
      agentLog(opts.agent, `No review comments found on PR #${opts.prNumber}`, 'WARN');
    }
  }

  if (!feedbackText) {
    throw new Error('No feedback provided. Use --feedback, --feedback-file, or --pr (with review comments on the PR).');
  }

  // Track review cycles
  const reviewState = readReviewState(batchName, opts.agent, opts.spec);

  if (reviewState.count >= maxCycles) {
    throw new Error(`REVIEW LIMIT REACHED (${maxCycles} cycles) for ${opts.agent}/${opts.spec}. This spec needs human intervention.`);
  }

  reviewState.count++;
  // Use the orchestrator's cycle number if provided, so the signal file's
  // reviewCycle matches what the orchestrator expects. Fall back to the
  // review-agent's own counter for CLI / manual invocations.
  const cycle = opts.orchestratorCycle ?? reviewState.count;

  // Truncate feedback for history log
  const feedbackSummary = feedbackText.length > 500
    ? feedbackText.substring(0, 500) + '...'
    : feedbackText;

  reviewState.history.push({
    cycle,
    timestamp: new Date().toISOString(),
    feedback: feedbackSummary,
  });

  writeReviewState(batchName, opts.agent, opts.spec, reviewState);

  console.log(`  Review cycle: ${cycle} of ${maxCycles}`);
  console.log();

  // Overwrite CLAUDE.md with slim review template (strips "Your Task" + arch doc refs)
  const reviewClaudeMd = renderReviewClaudeMd({
    agentKey: opts.agent,
    agentConfig: agentCfg,
    assignment,
    batchName,
    signalFilePath: signalFile,
    maxReviewCycles: maxCycles,
    projectName: config.project.name,
    projectRulesFile: config.settings.projectRulesFile,
  });
  writeUtf8(join(agentDir, 'CLAUDE.md'), reviewClaudeMd);
  agentLog(opts.agent, '  → Slim review CLAUDE.md written', 'INFO');

  // Build review prompt — pre-populate prUrl so the agent doesn't read the old signal file
  const existingSignal = readSignal(signalFile);
  const prUrl = existingSignal?.prUrl ?? (opts.prNumber ? `https://github.com/${config.project.repoUrl?.replace(/.*github\.com\//, '').replace(/\.git$/, '')}/pull/${opts.prNumber}` : undefined);
  const prompt = generateReviewPrompt({
    agentConfig: agentCfg,
    assignment,
    agentKey: opts.agent,
    specName: opts.spec,
    subBranch,
    signalFile,
    cycle,
    maxCycles,
    feedbackText,
    projectName: config.project.name,
    prUrl,
  });

  // Write prompt file
  ensureDir(logsDir);
  const promptFile = join(logsDir, `${batchName}-${opts.agent}-${opts.spec}.review-${cycle}.prompt.md`);
  writeUtf8(promptFile, prompt);
  agentLog(opts.agent, 'Review prompt written', 'INFO');

  // Ensure correct branch
  const currentBranch = getCurrentBranch(agentDir);
  if (currentBranch !== subBranch) {
    if (!checkoutBranch(subBranch, agentDir)) {
      throw new Error(`Could not checkout ${subBranch} — does the branch exist?`);
    }
  }

  // Pull latest
  pullBranch(subBranch, agentDir);

  // Ensure post-commit hook is installed (boundary enforcement + Co-Authored-By stripping)
  installPostCommitHook(agentDir, opts.agent, getBoundaryHookOpts());

  const logFile = join(logsDir, `${batchName}-${opts.agent}-${opts.spec}.review-${cycle}.log`);
  const model = resolveModel(config, opts.agent, assignment);

  if (opts.interactive) {
    // Inline (foreground) launch via Agent SDK
    console.log('  Starting inline review session via Agent SDK...');
    console.log();

    const reviewBudget = config.settings.reviewMaxBudgetUsd ?? 2.0;
    const reviewMaxTurns = config.settings.reviewMaxTurns ?? 30;
    const result = await launchAgent({
      config,
      prompt,
      agentKey: opts.agent,
      cwd: agentDir,
      logFile,
      model,
      maxBudgetUsd: reviewBudget,
      maxTurns: reviewMaxTurns,
      onProgress: (msg) => agentLog(opts.agent, msg, 'INFO'),
    });

    console.log();
    if (result.success) {
      agentLog(opts.agent, `Review completed (${result.numTurns} turns, $${result.costUsd.toFixed(4)})`, 'OK');
    } else {
      agentLog(opts.agent, `Review failed: ${result.error ?? 'unknown error'}`, 'ERROR');
    }

    // Write cost sidecar for orchestrator to ingest
    try {
      const entry = {
        timestamp: new Date().toISOString(),
        batchName,
        agent: opts.agent,
        spec: opts.spec,
        runType: 'review-fix' as const,
        cycle,
        costUsd: result.costUsd,
        durationMs: result.durationMs,
        numTurns: result.numTurns,
        model,
      };
      writeUtf8(getSidecarCostPath(batchName, opts.agent, opts.spec, 'review-fix', cycle), JSON.stringify(entry, null, 2));
    } catch (err) {
      agentLog(opts.agent, `Failed to write cost sidecar: ${err}`, 'WARN');
    }

    // Check for signal
    const signal = readSignal(signalFile);
    if (signal) {
      console.log(`  Signal: ${signal.status}`);
    } else {
      console.log('  No signal file written.');
    }
    console.log();
  } else {
    // Background launch via generated runner script
    const runnerContent = generateRunnerScript({
      config,
      agentKey: opts.agent,
      specName: opts.spec,
      batchName,
      subBranch,
      agentDir,
      promptFile,
      logFile,
      displayName: `${agentCfg.displayName} (review cycle ${cycle})`,
      model,
    });

    const runnerPath = join(logsDir, `${batchName}-${opts.agent}-${opts.spec}-review-${cycle}-runner.mjs`);
    writeUtf8(runnerPath, runnerContent);

    let pid: number | null = null;

    if (opts.visible) {
      const title = `${agentCfg.displayName} — review ${cycle}`;
      const launched = spawnVisibleAgent(runnerPath, title);
      if (launched) {
        agentLog(opts.agent, `Review launched in visible terminal (cycle ${cycle} of ${maxCycles})`, 'OK');
        pid = -1; // sentinel: visible-running — no trackable background PID
      } else {
        agentLog(opts.agent, 'Visible launch failed — falling back to background', 'WARN');
        pid = spawnBackgroundAgent(runnerPath);
      }
    } else {
      pid = spawnBackgroundAgent(runnerPath);
    }

    if (!opts.visible && pid) {
      agentLog(opts.agent, `Review launched (PID: ${pid}, cycle ${cycle} of ${maxCycles})`, 'OK');
    } else if (!opts.visible && !pid) {
      agentLog(opts.agent, 'Failed to launch review process', 'ERROR');
    }

    console.log();
    console.log(`  Review cycle ${cycle} launched for ${opts.agent}/${opts.spec}`);
    if (pid) console.log(`  PID: ${pid}`);
    console.log();
    console.log(`  Tail the log:`);
    console.log(`    Get-Content '${logFile}' -Wait -Tail 50`);
    console.log();

    return pid;
  }

  return null;
}
