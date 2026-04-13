/**
 * run-agent command — interactive single-agent run.
 * Equivalent to ai-team/scripts/run-agent.ps1
 *
 * Uses the Agent SDK for inline (foreground) execution.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, loadBatch, getAgentConfig, getLogsDir, getMaxReviewCycles } from '../config.js';
import { ensureDir, writeUtf8, readUtf8, checkPrerequisites } from '../helpers.js';
import { agentLog, header } from '../logger.js';
import { getSignalFile, readSignal } from '../signals.js';
import { checkoutBranch, getCurrentBranch } from '../git.js';
import { loadTemplate, renderClaudeMd, generateLaunchPrompt } from '../templates.js';
import { launchAgent } from '../claude.js';
import { getSidecarCostPath } from '../cost-ledger.js';

export interface RunAgentOptions {
  batchFile: string;
  agent: string;
  spec: string;
}

export async function runAgent(opts: RunAgentOptions): Promise<void> {
  const config = loadConfig();
  const batch = loadBatch(opts.batchFile);
  const batchName = batch.name;
  const batchBranch = `batch/${batchName}`;

  // Find assignment
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
  const model = opts.agent === 'architect' ? config.models.architect : config.models.coAgent;

  header(`Run Agent — ${agentCfg.displayName} / ${opts.spec}`);

  checkPrerequisites(config, true);

  // Auto-generate files if missing
  const claudeMdPath = join(agentDir, 'CLAUDE.md');
  const promptFile = join(logsDir, `${batchName}-${opts.agent}-${opts.spec}.prompt.md`);

  if (!existsSync(claudeMdPath) || !existsSync(promptFile)) {
    agentLog(opts.agent, 'Generating CLAUDE.md and prompt...', 'INFO');

    const template = loadTemplate();
    const claudeMd = renderClaudeMd({
      template,
      agentKey: opts.agent,
      agentConfig: agentCfg,
      assignment,
      batchName,
      signalFilePath: signalFile,
      maxReviewCycles: getMaxReviewCycles(config, opts.agent),
      projectName: config.project.name,
      projectRulesFile: config.settings.projectRulesFile,
    });

    writeUtf8(claudeMdPath, claudeMd);
    agentLog(opts.agent, '  → CLAUDE.md written', 'OK');

    const prompt = generateLaunchPrompt(agentCfg, assignment, batchBranch, config.project.name);
    ensureDir(logsDir);
    writeUtf8(promptFile, prompt);
    agentLog(opts.agent, '  → Prompt written', 'OK');
  }

  // Ensure correct branch
  const currentBranch = getCurrentBranch(agentDir);
  if (currentBranch !== subBranch) {
    if (!checkoutBranch(subBranch, agentDir)) {
      agentLog(opts.agent, `Could not checkout ${subBranch} — run create-batch first`, 'ERROR');
      process.exit(1);
    }
  }

  // Run via Agent SDK (inline/foreground)
  console.log('  Starting agent session via Agent SDK...');
  console.log('  Press Ctrl+C to stop.');
  console.log();

  const prompt = readUtf8(promptFile);
  const logFile = join(logsDir, `${batchName}-${opts.agent}-${opts.spec}.log`);

  const result = await launchAgent({
    config,
    prompt,
    agentKey: opts.agent,
    cwd: agentDir,
    logFile,
    model,
    onProgress: (msg) => console.log(`  ${msg}`),
  });

  console.log();
  if (result.success) {
    console.log(`  Completed (${result.numTurns} turns, $${result.costUsd.toFixed(4)}, ${result.durationMs}ms)`);
  } else {
    console.log(`  Failed: ${result.error ?? 'unknown error'}`);
  }

  // Write cost sidecar for orchestrator to ingest
  try {
    const entry = {
      timestamp: new Date().toISOString(),
      batchName,
      agent: opts.agent,
      spec: opts.spec,
      runType: 'launch' as const,
      cycle: 0,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      numTurns: result.numTurns,
      model,
    };
    writeUtf8(getSidecarCostPath(batchName, opts.agent, opts.spec), JSON.stringify(entry, null, 2));
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
}
