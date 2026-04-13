#!/usr/bin/env node
/**
 * AI Team CLI — orchestrates AI agent teams for parallel development.
 *
 * Usage:
 *   npx tsx ai-team/cli/src/index.ts <command> [options]
 *
 * Commands:
 *   create-batch   Create batch and sub-branches for all assignments
 *   launch         Launch co-agents for a batch
 *   run            Run a single agent interactively (foreground)
 *   monitor        Live dashboard for a running batch
 *   orchestrate    Full orchestration loop (create → launch → review → approve)
 *   cost-report    Display cost summary from the cost ledger
 *   archive-logs   Archive completed batch logs to prevent unbounded growth
 */

import { Command } from 'commander';
import { resolve } from 'node:path';
import { createBatch } from './commands/create-batch.js';
import { launchAgents } from './commands/launch-agents.js';
import { runAgent } from './commands/run-agent.js';
import { monitor } from './commands/monitor.js';
import { orchestrate } from './commands/orchestrate.js';
import { costReport } from './commands/cost-report.js';
import { archiveLogs } from './commands/archive-logs.js';
import { clean } from './commands/clean.js';
import { status } from './commands/status.js';
import { listBatches } from './commands/list-batches.js';
import { reset } from './commands/reset.js';
import { validate } from './commands/validate.js';
import { plan } from './commands/plan.js';
import { init } from './commands/init.js';
import { launchInNewWindow } from './helpers.js';
import { setProjectDir, loadConfig as loadConfigFn } from './config.js';

const program = new Command();

/**
 * Re-invoke the current CLI command in a visible Windows Terminal tab.
 * Strips --detach from args to prevent infinite re-exec.
 */
function detachToVisibleTerminal(title: string): void {
  const args = process.argv.slice(2).filter(a => a !== '--detach');
  const quotedArgs = args.map(a => a.includes(' ') ? `"${a}"` : a);
  // Re-invoke using the same node + entry point (works whether tsx, dist, or npx)
  const entry = process.argv[1];
  const cmd = `${process.execPath} ${entry} ${quotedArgs.join(' ')}`;
  const launched = launchInNewWindow(title, cmd, process.cwd());
  if (launched) {
    console.log(`  ${title} launched in new terminal tab.`);
  } else {
    console.error('  Failed to open new window. Run without --detach.');
    process.exit(1);
  }
}

program
  .name('ai-team')
  .description('AI Team CLI — orchestrates AI agent teams for parallel development')
  .version('1.0.0')
  .option('-p, --project-dir <path>', 'Path to the project .ai-team/ directory', process.env.AI_TEAM_PROJECT_DIR)
  .hook('preAction', () => {
    const dir = program.opts().projectDir;
    if (dir) setProjectDir(resolve(dir));
  });

// ── create-batch ─────────────────────────────────────────────

program
  .command('create-batch')
  .description('Create batch branch and commit spec files (sub-branches created JIT at launch)')
  .requiredOption('-b, --batch-file <path>', 'Path to batch JSON file')
  .option('--skip-validation', 'Skip pre-flight boundary validation')
  .action((opts) => {
    createBatch({ batchFile: opts.batchFile, skipValidation: opts.skipValidation });
  });

// ── launch ───────────────────────────────────────────────────

program
  .command('launch')
  .description('Launch co-agents for a batch')
  .requiredOption('-b, --batch-file <path>', 'Path to batch JSON file')
  .option('-a, --agent <key>', 'Launch only this agent (e.g. "backend")')
  .option('--dry-run', 'Generate files but don\'t start processes')
  .option('--inline', 'Run agents inline (foreground) instead of background')
  .option('--visible', 'Open each agent in a visible Windows Terminal tab')
  .option('--detach', 'Launch this command in a new terminal window')
  .action(async (opts) => {
    if (opts.detach) {
      detachToVisibleTerminal('AI Team Launch');
      return;
    }
    await launchAgents({
      batchFile: opts.batchFile,
      agent: opts.agent,
      dryRun: opts.dryRun,
      inline: opts.inline,
      visible: opts.visible,
    });
  });

// ── run ──────────────────────────────────────────────────────

program
  .command('run')
  .description('Run a single agent interactively (foreground, via Agent SDK)')
  .requiredOption('-b, --batch-file <path>', 'Path to batch JSON file')
  .requiredOption('-a, --agent <key>', 'Agent key (e.g. "backend")')
  .requiredOption('-s, --spec <name>', 'Spec name')
  .action(async (opts) => {
    await runAgent({
      batchFile: opts.batchFile,
      agent: opts.agent,
      spec: opts.spec,
    });
  });

// ── monitor ──────────────────────────────────────────────────

program
  .command('monitor')
  .description('Live dashboard showing agent status for a running batch')
  .argument('<batchName>', 'Batch name to monitor')
  .option('-i, --interval <seconds>', 'Poll interval in seconds', parseInt)
  .action(async (batchName, opts) => {
    await monitor({ batchName, pollInterval: opts.interval });
  });

// ── orchestrate ──────────────────────────────────────────────

program
  .command('orchestrate')
  .description('Full orchestration: create branches → launch agents → review → approve → finalize')
  .requiredOption('-b, --batch-file <path>', 'Path to batch JSON file')
  .option('--skip-branches', 'Skip branch creation (branches already exist)')
  .option('--skip-launch', 'Skip agent launch (agents already running)')
  .option('--review-only', 'Skip both branch creation and launch — review only')
  .option('--poll-interval <seconds>', 'Override poll interval in seconds', parseInt)
  .option('--review-mode <mode>', 'Review mode: copilot (default), architect, or none')
  .option('--pr-title <title>', 'Override the batch PR title (default: "feat: {batchName}")')
  .option('--timeout <minutes>', 'Idle timeout in minutes (0 = disable, default: config or 90)', parseInt)
  .option('--visible', 'Open agents in visible Windows Terminal tabs (implies --detach)')
  .option('--detach', 'Launch orchestrator in a new terminal window')
  .action(async (opts) => {
    // --visible on orchestrate should detach to a new terminal (it's long-running)
    // but only if we haven't already detached (prevent infinite spawn loop)
    if (opts.detach) {
      detachToVisibleTerminal('AI Team Orchestrator');
      return;
    }
    await orchestrate({
      batchFile: opts.batchFile,
      skipBranches: opts.skipBranches,
      skipLaunch: opts.skipLaunch,
      reviewOnly: opts.reviewOnly,
      pollInterval: opts.pollInterval,
      reviewMode: opts.reviewMode,
      prTitle: opts.prTitle,
      timeout: opts.timeout,
      visible: opts.visible,
    });
  });

// ── cost-report ──────────────────────────────────────────────

program
  .command('cost-report')
  .description('Display cost summary from the cost ledger')
  .option('-b, --batch <name>', 'Filter by batch name')
  .option('--json', 'Output raw JSON instead of formatted report')
  .action((opts) => {
    costReport({ batch: opts.batch, json: opts.json });
  });

// ── archive-logs ─────────────────────────────────────────────

program
  .command('archive-logs')
  .description('Archive completed batch logs to ai-team/logs/archived/{batchName}/')
  .option('-b, --batch <name>', 'Archive logs for a specific batch name')
  .option('--all', 'Archive all detected batches')
  .option('--dry-run', 'Preview what would be archived without moving files')
  .action((opts) => {
    archiveLogs({ batch: opts.batch, dryRun: opts.dryRun, all: opts.all });
  });

// ── validate ─────────────────────────────────────────────────

program
  .command('validate')
  .description('Pre-flight validation: batch schema, boundaries, workspace collisions, config sync')
  .requiredOption('-b, --batch-file <path>', 'Path to batch JSON file')
  .option('--warn-only', 'Print warnings but don\'t fail on boundary violations')
  .action((opts) => {
    const passed = validate({ batchFile: opts.batchFile, warnOnly: opts.warnOnly });
    if (!passed) process.exit(1);
  });

// ── validate-config ──────────────────────────────────────────

program
  .command('validate-config')
  .description('Validate the project config.json and print a summary')
  .action(() => {
    try {
      loadConfigFn(); // validateConfig is called inside loadConfig
      console.log('✅ Config is valid.');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`❌ ${message}`);
      process.exit(1);
    }
  });

// ── status ───────────────────────────────────────────────────

program
  .command('status')
  .description('Display the current state of a batch (agents, phases, costs)')
  .argument('<batchName>', 'Batch name to inspect')
  .option('--json', 'Output machine-readable JSON')
  .action((batchName, opts) => {
    status(batchName, { json: opts.json });
  });

// ── list-batches ─────────────────────────────────────────────

program
  .command('list-batches')
  .description('List all known batches with their status and cost')
  .option('--json', 'Output machine-readable JSON')
  .action((opts) => {
    listBatches({ json: opts.json });
  });

// ── clean ────────────────────────────────────────────────────

program
  .command('clean')
  .description('Archive logs and delete PID state for completed batches')
  .option('-b, --batch <name>', 'Clean a specific batch name')
  .option('--all', 'Clean all completed/merged batches')
  .option('--dry-run', 'Preview what would be cleaned without making changes')
  .option('--force', 'Clean batches regardless of phase (including active ones)')
  .option('--commit', 'Commit and push .ai-team/ changes after cleaning')
  .action((opts) => {
    clean({ batch: opts.batch, all: opts.all, dryRun: opts.dryRun, force: opts.force, commit: opts.commit });
  });

// ── reset ────────────────────────────────────────────────────

program
  .command('reset')
  .description('Reset an agent to a specific state for recovery (retry, fresh, approved)')
  .requiredOption('-b, --batch <name>', 'Batch name')
  .requiredOption('-a, --agent <key>', 'Agent key (e.g. "backend")')
  .requiredOption('-s, --spec <name>', 'Spec name')
  .requiredOption('--to <preset>', 'Reset preset: retry, fresh, or approved')
  .option('--dry-run', 'Preview changes without applying them')
  .option('--force', 'Reset even if agent has a live process')
  .action((opts) => {
    const validPresets = ['retry', 'fresh', 'approved'] as const;
    if (!validPresets.includes(opts.to)) {
      console.error(`Invalid preset: "${opts.to}". Must be one of: ${validPresets.join(', ')}`);
      process.exit(1);
    }
    reset({
      batchFile: opts.batch,
      agent: opts.agent,
      spec: opts.spec,
      to: opts.to as 'retry' | 'fresh' | 'approved',
      dryRun: opts.dryRun,
      force: opts.force,
    });
  });

// ── plan ─────────────────────────────────────────────────────

program
  .command('plan')
  .description('Generate specs and batch from high-level intent using a planning agent')
  .argument('<intent>', 'High-level description of what to build')
  .option('-o, --output-dir <dir>', 'Directory for generated specs', 'docs/specs')
  .option('-n, --batch-name <name>', 'Batch name (defaults to slugified intent)')
  .option('--model <model>', 'Model override for planner agent')
  .action(async (intent, opts) => {
    await plan({
      intent,
      outputDir: opts.outputDir,
      batchName: opts.batchName,
      model: opts.model,
    });
  });

// ── init ─────────────────────────────────────────────────────

program
  .command('init')
  .description('Scaffold project customization files (agent modes, etc.) from templates')
  .option('--force', 'Overwrite existing files')
  .action((opts) => {
    init({ force: opts.force });
  });

// ── Parse and run ────────────────────────────────────────────

program.parseAsync(process.argv).catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
