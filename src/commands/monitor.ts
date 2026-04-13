/**
 * monitor command — live dashboard showing agent status.
 * Equivalent to ai-team/scripts/monitor.ps1
 */

import chalk from 'chalk';
import { loadConfig, loadBatch } from '../config.js';
import { sleep, getElapsedTime, isProcessRunning } from '../helpers.js';
import { readSignal, readBatchState, getSignalFile } from '../signals.js';


export interface MonitorOptions {
  batchFile?: string;
  batchName?: string;
  pollInterval?: number;
}

export async function monitor(opts: MonitorOptions): Promise<void> {
  const config = loadConfig();
  
  // Accept either a batch file or a batch name
  let batchName: string;
  if (opts.batchFile) {
    const batch = loadBatch(opts.batchFile);
    batchName = batch.name;
  } else if (opts.batchName) {
    batchName = opts.batchName;
  } else {
    throw new Error('Either --batch-file or batchName argument is required');
  }
  
  const pollInterval = (opts.pollInterval ?? config.settings.monitorPollIntervalSeconds) * 1000;

  console.log();
  console.log(chalk.cyan(`  ╔════════════════════════════════════════════════════════════════╗`));
  console.log(chalk.cyan(`  ║  Agent Monitor — ${batchName.padEnd(44)}║`));
  console.log(chalk.cyan(`  ╚════════════════════════════════════════════════════════════════╝`));
  console.log();
  console.log(chalk.dim('  Press Ctrl+C to stop monitoring.'));
  console.log();

  const batchState = readBatchState(batchName);

  // Build an assignments list from batch state entries
  const assignments: Array<{ agent: string; spec: string }> = batchState?.agents.map((a) => ({
    agent: a.agent,
    spec: a.spec,
  })) ?? [];

  if (assignments.length === 0) {
    console.log(chalk.yellow('  No batch state found. Run launch first.'));
    return;
  }

  try {
    while (true) {
      // Clear screen for live update
      process.stdout.write('\x1B[2J\x1B[0f');

      const timestamp = new Date().toLocaleTimeString('en-GB', { hour12: false });
      console.log();
      console.log(chalk.cyan(`  Agent Monitor — ${batchName}  [${timestamp}]`));
      console.log(chalk.dim(`  ${'─'.repeat(60)}`));
      console.log();

      // Table header
      console.log(
        `  ${chalk.dim('Agent'.padEnd(12))} ${chalk.dim('Spec'.padEnd(30))} ${chalk.dim('Status'.padEnd(12))} ${chalk.dim('PID'.padEnd(8))} ${chalk.dim('Elapsed')}`,
      );
      console.log(chalk.dim(`  ${'─'.repeat(75)}`));

      let allDone = true;

      for (const assignment of assignments) {
        const agentKey = assignment.agent;
        const specName = assignment.spec;

        // Check signal
        const signalFile = getSignalFile(batchName, agentKey, specName);
        const signal = readSignal(signalFile);

        // Check process
        const agentEntry = batchState?.agents.find(
          (a) => a.agent === agentKey && a.spec === specName,
        );
        const pid = agentEntry?.pid;
        const running = pid ? isProcessRunning(pid) : false;

        // Determine status
        let status: string;
        let statusColor: (s: string) => string;

        if (signal?.status === 'completed') {
          status = '✅ Done';
          statusColor = chalk.green;
        } else if (signal?.status === 'failed') {
          status = '❌ Failed';
          statusColor = chalk.red;
        } else if (running) {
          status = '🔄 Running';
          statusColor = chalk.cyan;
          allDone = false;
        } else if (pid) {
          status = '⚠ Exited';
          statusColor = chalk.yellow;
        } else {
          status = '⏳ Waiting';
          statusColor = chalk.dim;
          allDone = false;
        }

        const elapsed = agentEntry?.startedAt ? getElapsedTime(agentEntry.startedAt) : '-';
        const pidStr = pid ? String(pid) : '-';

        console.log(
          `  ${agentKey.padEnd(12)} ${specName.padEnd(30)} ${statusColor(status.padEnd(12))} ${pidStr.padEnd(8)} ${elapsed}`,
        );
      }

      console.log();

      if (allDone) {
        console.log(chalk.green('  All agents have completed.'));
        console.log();
        break;
      }

      // Progress bar
      const total = assignments.length;
      const done = assignments.filter((a) => {
        const sig = readSignal(getSignalFile(batchName, a.agent, a.spec));
        return sig?.status === 'completed' || sig?.status === 'failed';
      }).length;
      const pct = Math.round((done / total) * 100);
      const barWidth = 40;
      const filled = Math.round((done / total) * barWidth);
      const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
      console.log(`  Progress: [${bar}] ${done}/${total} (${pct}%)`);
      console.log();

      const nextCheck = new Date(Date.now() + pollInterval).toLocaleTimeString('en-GB', { hour12: false });
      console.log(chalk.dim(`  Next check at ${nextCheck} (Ctrl+C to stop)`));

      await sleep(pollInterval);
    }
  } catch {
    // Ctrl+C
    console.log();
    console.log('  Monitor stopped.');
  }
}
