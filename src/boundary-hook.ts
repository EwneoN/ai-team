#!/usr/bin/env node
/**
 * Standalone boundary enforcement script for git hooks.
 *
 * Usage: node boundary-hook.js --agent <key> --config <path>
 *
 * Checks the latest commit's changed files against the agent's ownedPaths.
 *
 * Exit codes:
 *   0  — no violations (or check skipped due to missing config/agent/args)
 *   10 — boundary violations found (caller should revert the commit)
 *
 * Designed to be called from a post-commit hook. The hook script handles
 * reverting the commit when this script exits with code 10.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { checkBoundaryViolations } from './boundary-check.js';

// ── Parse CLI args ──────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const agentKey = getArg('agent');
const configPath = getArg('config');

if (!agentKey || !configPath) {
  // Missing args — skip check rather than block commits
  process.exit(0);
}

// ── Load config ─────────────────────────────────────────────

let config: { agents: Record<string, { ownedPaths?: string[] }> };
try {
  const raw = readFileSync(configPath, 'utf-8').replace(/^\uFEFF/, '');
  config = JSON.parse(raw);
} catch {
  // Config unreadable — skip check rather than block commits
  process.exit(0);
}

const agent = config.agents?.[agentKey];
if (!agent) {
  // Agent not in config — skip check
  process.exit(0);
}

const ownedPaths = agent.ownedPaths;
if (!ownedPaths || ownedPaths.length === 0) {
  // No boundaries defined — allow all
  process.exit(0);
}

// ── Get changed files from the latest commit ────────────────

let changedFiles: string[];
try {
  const output = execFileSync(
    'git',
    ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', 'HEAD'],
    { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
  changedFiles = output.trim().split('\n').filter(Boolean);
} catch {
  // Can't read commit (orphan, shallow, etc.) — skip check
  process.exit(0);
}

if (changedFiles.length === 0) {
  process.exit(0);
}

// ── Check boundaries ────────────────────────────────────────

const violations = checkBoundaryViolations(changedFiles, ownedPaths);

if (violations.length > 0) {
  console.error('\n⛔ BOUNDARY VIOLATION');
  console.error(`Agent "${agentKey}" committed files outside its owned paths:\n`);
  for (const f of violations) {
    console.error(`  ✗ ${f}`);
  }
  console.error('\nAllowed paths:');
  for (const p of ownedPaths) {
    console.error(`  • ${p}`);
  }
  console.error('\nThe post-commit hook will revert this commit. Fix the violations and try again.\n');
  process.exit(10);
}

process.exit(0);
