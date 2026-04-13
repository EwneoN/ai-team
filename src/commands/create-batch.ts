/**
 * create-batch command — create batch branch and commit spec files.
 * Equivalent to ai-team/scripts/create-batch.ps1
 */

import { existsSync, unlinkSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';
import { loadConfig, loadBatch, getAgentConfig, getSignalsDir, getProjectRoot } from '../config.js';
import { ensureDir, ensureAgentWorkspace, execFileArr, execFileSafe } from '../helpers.js';
import { agentLog, header, step } from '../logger.js';
import { getSignalFile } from '../signals.js';
import { fetchOrigin } from '../git.js';
import { validate } from './validate.js';

export interface CreateBatchOptions {
  batchFile: string;
  /** Skip pre-flight boundary validation */
  skipValidation?: boolean;
}

export function createBatch(opts: CreateBatchOptions): void {
  // ── Pre-flight validation ──────────────────────────────────
  if (!opts.skipValidation) {
    const passed = validate({ batchFile: opts.batchFile });
    if (!passed) {
      throw new Error('Pre-flight validation failed. Fix specs/batch and retry, or use --skip-validation to override.');
    }
  }

  const config = loadConfig();
  const batch = loadBatch(opts.batchFile);
  const batchName = batch.name;
  const batchBranch = `batch/${batchName}`;
  const sourceBranch = batch.baseBranch || config.project.mainBranch;

  header(`Create Batch Branches — ${batchName}`);

  // Use the first agent's workspace to create the batch branch
  const firstAgent = batch.assignments[0];
  if (!firstAgent) {
    throw new Error('Batch has no assignments');
  }

  const firstAgentCfg = getAgentConfig(config, firstAgent.agent);

  // Ensure workspace
  const wsReady = ensureAgentWorkspace(firstAgent.agent, firstAgentCfg, config.project);
  if (!wsReady) {
    throw new Error(`Could not prepare workspace for ${firstAgent.agent}`);
  }

  const cwd = firstAgentCfg.workingDir;

  // Fetch latest
  step(1, 'Fetching latest from origin...');
  fetchOrigin(cwd);

  // Create batch branch from main (or skip if it exists)
  step(2, `Creating batch branch: ${batchBranch}`);
  const { code: branchCheck } = execFileSafe('git', ['ls-remote', '--heads', 'origin', batchBranch], { cwd });
  
  if (branchCheck === 0) {
    // Check if remote has this branch (ls-remote outputs a line if it exists)
    const { stdout: lsOutput } = execFileSafe('git', ['ls-remote', '--heads', 'origin', batchBranch], { cwd });
    if (lsOutput.includes(batchBranch)) {
      agentLog('batch', `Branch ${batchBranch} already exists on origin — skipping creation`, 'WARN');
      execFileSafe('git', ['checkout', batchBranch, '--quiet'], { cwd });
      execFileSafe('git', ['pull', 'origin', batchBranch, '--quiet'], { cwd });
    } else {
      // Create fresh from source branch
      execFileSafe('git', ['checkout', sourceBranch, '--quiet'], { cwd });
      execFileSafe('git', ['pull', 'origin', sourceBranch, '--quiet'], { cwd });
      execFileArr('git', ['checkout', '-b', batchBranch], { cwd });
      execFileArr('git', ['push', '-u', 'origin', batchBranch], { cwd });
      agentLog('batch', `Created ${batchBranch} from ${sourceBranch}`, 'OK');
    }
  } else {
    // Create fresh from source branch
    execFileSafe('git', ['checkout', sourceBranch, '--quiet'], { cwd });
    execFileSafe('git', ['pull', 'origin', sourceBranch, '--quiet'], { cwd });
    execFileArr('git', ['checkout', '-b', batchBranch], { cwd });
    execFileArr('git', ['push', '-u', 'origin', batchBranch], { cwd });
    agentLog('batch', `Created ${batchBranch} from ${sourceBranch}`, 'OK');
  }

  // Commit spec files to batch branch so agents can read them
  step(3, 'Committing spec files to batch branch...');
  const projectRoot = getProjectRoot();
  const specPaths = [...new Set(batch.assignments.map(a => a.specPath))];
  let specsCopied = 0;

  const copiedSpecPaths: string[] = [];

  for (const specPath of specPaths) {
    // Reject empty, absolute, or parent-relative paths to prevent writes outside repo
    if (!specPath || isAbsolute(specPath) || specPath.includes('..')) {
      agentLog('batch', `Rejecting spec path with traversal: ${specPath}`, 'ERROR');
      continue;
    }
    const srcFile = resolve(projectRoot, specPath);
    const destFile = resolve(cwd, specPath);
    // Verify resolved paths stay within their respective roots
    if (!srcFile.startsWith(resolve(projectRoot)) || !destFile.startsWith(resolve(cwd))) {
      agentLog('batch', `Spec path escapes repo boundary: ${specPath}`, 'ERROR');
      continue;
    }
    if (!existsSync(srcFile)) {
      agentLog('batch', `Spec not found at ${srcFile} — skipping`, 'WARN');
      continue;
    }
    mkdirSync(dirname(destFile), { recursive: true });
    copyFileSync(srcFile, destFile);
    copiedSpecPaths.push(specPath);
    specsCopied++;
  }

  if (specsCopied > 0) {
    // Only git-add paths that were actually copied (avoids git add failing on missing pathspecs)
    const specGlobs = copiedSpecPaths.map(p => p.replace(/\\/g, '/'));
    execFileSafe('git', ['add', ...specGlobs], { cwd });

    // Only commit if there are staged changes (specs may already be on the branch)
    const { code: diffCode } = execFileSafe('git', ['diff', '--cached', '--quiet'], { cwd });
    if (diffCode !== 0) {
      const { code: commitCode } = execFileSafe(
        'git', ['commit', '-m', `chore: add spec files for batch ${batchName} [skip ci]`], { cwd },
      );
      if (commitCode === 0) {
        const { code: pushCode } = execFileSafe('git', ['push', 'origin', batchBranch, '--quiet'], { cwd });
        if (pushCode === 0) {
          agentLog('batch', `Committed ${specsCopied} spec file(s) to ${batchBranch}`, 'OK');
        } else {
          agentLog('batch', 'Spec commit pushed locally but push failed', 'WARN');
        }
      } else {
        agentLog('batch', 'Failed to commit spec files', 'ERROR');
      }
    } else {
      agentLog('batch', 'Spec files already on batch branch — nothing to commit', 'OK');
    }
  } else {
    agentLog('batch', 'No spec files found to commit', 'WARN');
  }

  // Sub-branches are created JIT in launch-agents when each round starts.
  // This avoids creating branches for rounds that may never run and simplifies
  // cleanup on reset (fewer stale local/remote branches to delete).

  // Clean old signal files
  step(4, 'Cleaning old signal files...');
  const signalsDir = getSignalsDir();
  ensureDir(signalsDir);

  for (const assignment of batch.assignments) {
    const signalFile = getSignalFile(batchName, assignment.agent, assignment.spec);
    if (existsSync(signalFile)) {
      unlinkSync(signalFile);
      agentLog(assignment.agent, 'Removed old signal file', 'INFO');
    }
  }

  console.log();
  agentLog('batch', `Batch branches created for ${batchName} (${batch.assignments.length} agents)`, 'OK');
  console.log();
}
