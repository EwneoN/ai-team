/**
 * Logging and display utilities.
 * Equivalent to Write-AgentLog, Write-Header, Write-Step in helpers.ps1
 */

import chalk from 'chalk';
import type { LogLevel } from './types.js';

const levelStyles: Record<LogLevel, { symbol: string; color: (s: string) => string }> = {
  INFO: { symbol: '·', color: chalk.cyan },
  OK: { symbol: '✓', color: chalk.green },
  WARN: { symbol: '!', color: chalk.yellow },
  ERROR: { symbol: '✗', color: chalk.red },
};

/**
 * Log a message with agent context and level formatting.
 */
export function agentLog(agent: string, message: string, level: LogLevel = 'INFO'): void {
  const { symbol, color } = levelStyles[level];
  const timestamp = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const line = `  ${color(symbol)} ${chalk.dim(`[${timestamp}]`)} ${chalk.white(agent)} ${color(message)}`;
  console.log(line);
}

/**
 * Print a box-drawn header.
 */
export function header(title: string): void {
  const bar = '═'.repeat(title.length + 4);
  console.log();
  console.log(chalk.cyan(`  ╔${bar}╗`));
  console.log(chalk.cyan(`  ║  ${title}  ║`));
  console.log(chalk.cyan(`  ╚${bar}╝`));
  console.log();
}

/**
 * Print a numbered step.
 */
export function step(number: number, description: string): void {
  console.log(`  ${chalk.yellow(`[${number}]`)} ${description}`);
}

/**
 * Print a dim info line.
 */
export function dim(message: string): void {
  console.log(chalk.dim(`  ${message}`));
}

/**
 * Print an error and optionally exit.
 */
export function fatal(message: string): never {
  console.error(chalk.red(`\n  ✗ ${message}\n`));
  process.exit(1);
}
