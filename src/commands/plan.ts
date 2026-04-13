/**
 * plan command — generate specs and batch file from a high-level intent.
 *
 * Spawns a planning agent via the Agent SDK that explores the project codebase,
 * then writes spec files and a batch JSON. After generation, runs validateBatch()
 * to catch issues early.
 */

import { existsSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, getProjectRoot, getLogsDir } from '../config.js';
import { ensureDir, writeUtf8, readUtf8 } from '../helpers.js';
import { header, agentLog, step, dim } from '../logger.js';
import { launchAgent } from '../claude.js';
import { validateBatch } from './validate.js';
import { getSidecarCostPath } from '../cost-ledger.js';
import { renderPlannerMd, buildPlannerPrompt, slugify } from './plan-prompt.js';

export interface PlanOptions {
  intent: string;
  outputDir?: string;
  batchName?: string;
  model?: string;
}

export async function plan(opts: PlanOptions): Promise<void> {
  const config = loadConfig();
  const projectRoot = getProjectRoot();
  const outputDir = opts.outputDir ?? 'docs/specs';
  const batchName = slugify(opts.batchName ?? opts.intent) || 'batch';
  const model = opts.model ?? config.models.architect;

  header(`Plan — "${opts.intent}"`);

  // ── 1. Render planner CLAUDE.md ──────────────────────────
  step(1, 'Rendering planner template...');

  const plannerMd = renderPlannerMd({
    config,
    intent: opts.intent,
    outputDir,
    batchName,
  });

  // Back up existing CLAUDE.md if present, write planner version
  const claudeMdPath = join(projectRoot, 'CLAUDE.md');
  const backupPath = claudeMdPath + '.plan-backup';
  let hadExisting = false;

  // Remove stale backup from a previous interrupted run
  if (existsSync(backupPath)) {
    unlinkSync(backupPath);
    agentLog('plan', 'Removed stale CLAUDE.md backup from prior run', 'INFO');
  }

  try {
    if (existsSync(claudeMdPath)) {
      renameSync(claudeMdPath, backupPath);
      hadExisting = true;
      agentLog('plan', 'Backed up existing CLAUDE.md', 'INFO');
    }

    writeUtf8(claudeMdPath, plannerMd);
    agentLog('plan', 'CLAUDE.md written for planner agent', 'OK');
    // ── 2. Build launch prompt ───────────────────────────────
    step(2, 'Building launch prompt...');
    const prompt = buildPlannerPrompt(opts.intent);

    const logsDir = getLogsDir();
    ensureDir(logsDir);
    const promptFile = join(logsDir, `plan-${batchName}.prompt.md`);
    writeUtf8(promptFile, prompt);

    // ── 3. Launch planning agent ─────────────────────────────
    step(3, 'Launching planning agent...');
    dim(`  Model: ${model}`);
    dim(`  CWD: ${projectRoot}`);
    console.log();

    const logFile = join(logsDir, `plan-${batchName}.log`);

    const result = await launchAgent({
      config,
      prompt,
      agentKey: 'planner',
      cwd: projectRoot,
      logFile,
      model,
      maxBudgetUsd: config.settings.maxBudgetUsd,
      onProgress: (msg) => console.log(`  ${msg}`),
    });

    // Write cost sidecar for orchestrator to ingest
    try {
      const entry = {
        timestamp: new Date().toISOString(),
        batchName,
        agent: 'planner',
        spec: 'plan',
        runType: 'launch' as const,
        cycle: 0,
        costUsd: result.costUsd,
        durationMs: result.durationMs,
        numTurns: result.numTurns,
        model,
      };
      writeUtf8(getSidecarCostPath(batchName, 'planner', 'plan'), JSON.stringify(entry, null, 2));
    } catch (err) {
      agentLog('plan', `Failed to write cost sidecar: ${err}`, 'WARN');
    }

    console.log();
    if (result.success) {
      agentLog('plan', `Agent completed (${result.numTurns} turns, $${result.costUsd.toFixed(4)})`, 'OK');
    } else {
      agentLog('plan', `Agent failed: ${result.error ?? 'unknown error'}`, 'ERROR');
    }

    // ── 4. Validate generated output ─────────────────────────
    step(4, 'Validating generated output...');

    const batchFile = join(projectRoot, '.ai-team', 'batches', `${batchName}.json`);

    if (!existsSync(batchFile)) {
      agentLog('plan', `Batch file not found at ${batchFile}`, 'ERROR');
      agentLog('plan', 'The planning agent may not have generated output. Check the log:', 'WARN');
      dim(`  ${logFile}`);
      return;
    }

    const validation = validateBatch({ batchFile });

    if (validation.errors.length > 0) {
      agentLog('plan', `Validation found ${validation.errors.length} error(s)`, 'WARN');
      for (const e of validation.errors) {
        console.log(`    ✗ ${e}`);
      }
      console.log();
      agentLog('plan', 'Fix the specs/batch manually, then run: ai-team validate -b ' + batchFile, 'INFO');
    } else {
      agentLog('plan', 'Validation passed', 'OK');
    }

    if (validation.warnings.length > 0) {
      for (const w of validation.warnings) {
        console.log(`    ⚠ ${w}`);
      }
    }

    // ── 5. Print summary ────────────────────────────────────
    console.log();
    header('Plan Complete');

    // List generated spec files
    const batchRaw = readUtf8(batchFile);
    try {
      const batch = JSON.parse(batchRaw);
      if (batch.assignments?.length) {
        console.log('  Generated specs:');
        for (const a of batch.assignments) {
          const specExists = existsSync(join(projectRoot, a.specPath));
          const marker = specExists ? '✓' : '✗';
          console.log(`    ${marker} ${a.specPath} (${a.agent}, round ${a.round ?? 1})`);
        }
      }
    } catch {
      agentLog('plan', 'Could not parse batch file for summary', 'WARN');
    }

    console.log();
    console.log(`  Batch: ${batchFile}`);
    console.log();
    console.log('  Review the generated specs, then run:');
    console.log(`    ai-team orchestrate -b ${batchFile}`);
    console.log();
  } finally {
    // ── Restore CLAUDE.md ─────────────────────────────────
    try {
      unlinkSync(claudeMdPath);
    } catch { /* ignore */ }

    if (hadExisting && existsSync(backupPath)) {
      renameSync(backupPath, claudeMdPath);
      agentLog('plan', 'Restored original CLAUDE.md', 'OK');
    }
  }
}
