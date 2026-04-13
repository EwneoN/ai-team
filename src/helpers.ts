/**
 * Shared utility functions.
 * Equivalent to Ensure-Directory, Read-Utf8File, Write-Utf8File,
 * Ensure-AgentWorkspace, Test-Prerequisites, Get-ElapsedTime from helpers.ps1
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, execFileSync, spawn, type ExecSyncOptions } from 'node:child_process';
import { agentLog } from './logger.js';
import { getProjectDir } from './config.js';
import type { AgentConfig, ProjectConfig, OrchestratorConfig } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Ensure a directory exists, creating it recursively if needed.
 */
export function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

/**
 * Read a UTF-8 file, returning its contents.
 */
export function readUtf8(path: string): string {
  return readFileSync(path, 'utf-8');
}

/**
 * Write a UTF-8 file.
 */
export function writeUtf8(path: string, content: string): void {
  writeFileSync(path, content, 'utf-8');
}

/**
 * Run a shell command and return stdout. Throws on non-zero exit.
 */
export function exec(cmd: string, options?: ExecSyncOptions): string {
  return (execSync(cmd, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  }) as string).trim();
}

/**
 * Run a shell command, returning { code, stdout, stderr }.
 * Does NOT throw on non-zero exit.
 */
export function execSafe(cmd: string, options?: ExecSyncOptions): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execSync(cmd, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      ...options,
    });
    return { code: 0, stdout: (stdout as string).trim(), stderr: '' };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      code: e.status ?? 1,
      stdout: (e.stdout ?? '').toString().trim(),
      stderr: (e.stderr ?? '').toString().trim(),
    };
  }
}

/**
 * Run an executable with an argument array (no shell interpolation).
 * Returns stdout. Throws on non-zero exit.
 */
export function execFileArr(file: string, args: string[], options?: ExecSyncOptions): string {
  return (execFileSync(file, args, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  }) as string).trim();
}

/**
 * Run an executable with an argument array (no shell interpolation).
 * Returns { code, stdout, stderr }. Does NOT throw on non-zero exit.
 */
export function execFileSafe(file: string, args: string[], options?: ExecSyncOptions): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(file, args, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      ...options,
    });
    return { code: 0, stdout: (stdout as string).trim(), stderr: '' };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      code: e.status ?? 1,
      stdout: (e.stdout ?? '').toString().trim(),
      stderr: (e.stderr ?? '').toString().trim(),
    };
  }
}

/**
 * Resolve the paths needed for boundary enforcement in the post-commit hook.
 * Always points at the compiled .js script so the hook can run it with `node`
 * (the agent workspace won't have `tsx` installed). In dev without a build,
 * the file won't exist and the hook gracefully warns & skips enforcement.
 */
export function getBoundaryHookOpts(): { boundaryHookPath: string; configPath: string } {
  return {
    boundaryHookPath: join(__dirname, 'boundary-hook.js'),
    configPath: join(getProjectDir(), 'config.json'),
  };
}

/**
 * Install a post-commit git hook that:
 * 1. Enforces agent boundary ownership (reverts commit if violations found)
 * 2. Strips Co-Authored-By trailers that the Claude CLI injects
 *
 * Uses post-commit (not pre-commit) because Claude Code passes --no-verify
 * which skips pre-commit and commit-msg hooks. Git does NOT skip post-commit
 * with --no-verify.
 *
 * Boundary enforcement:
 * - Calls the standalone boundary-hook.js script to check committed files
 * - If violations found, soft-resets the commit (files remain staged)
 * - Agent sees the error output and must fix before recommitting
 *
 * Co-Author stripping:
 * - An env-var guard prevents infinite recursion from the amend
 */
export function installPostCommitHook(
  repoDir: string,
  agentKey: string,
  boundaryOpts?: { boundaryHookPath: string; configPath: string },
): void {
  const hooksDir = join(repoDir, '.git', 'hooks');
  ensureDir(hooksDir);
  const hookPath = join(hooksDir, 'post-commit');

  // Build boundary check block (only if paths provided)
  let boundaryBlock = '';
  if (boundaryOpts) {
    // Convert Windows backslashes to forward slashes for Git Bash
    const hookScript = boundaryOpts.boundaryHookPath.replace(/\\/g, '/');
    const cfgJson = boundaryOpts.configPath.replace(/\\/g, '/');
    boundaryBlock = `
# ── Boundary enforcement ──────────────────────────────────────
# Check that committed files are within the agent's owned paths.
# Exit 10 = violations found → revert. Other non-zero = hook failure → warn only.
[ -z "$AI_TEAM_STRIPPING_COAUTHOR" ] && {
  node "${hookScript}" --agent "${agentKey}" --config "${cfgJson}"
  status=$?
  if [ "$status" -eq 10 ]; then
    # Revert the commit, keeping changes staged.
    # Handle initial commits (no parent) with update-ref -d HEAD.
    if git rev-parse --verify HEAD^ >/dev/null 2>&1; then
      git reset --soft HEAD~1
    else
      git update-ref -d HEAD
    fi
    exit 1
  elif [ "$status" -ne 0 ]; then
    >&2 echo "warning: boundary-hook failed with exit code $status; skipping boundary enforcement"
  fi
}
`;
  }

  // Shell script — runs inside Git Bash on Windows
  const hookContent = `#!/bin/sh
# Auto-installed by AI Team orchestrator.
# 1. Boundary enforcement: reverts commits with out-of-bounds files
# 2. Co-Author stripping: removes Claude CLI Co-Authored-By trailers
# Uses post-commit because Claude Code uses --no-verify (skips pre-commit).
# Guard against infinite recursion from the amend.
[ -n "$AI_TEAM_STRIPPING_COAUTHOR" ] && exit 0
${boundaryBlock}
# ── Co-Author stripping ──────────────────────────────────────
msg=$(git log -1 --format=%B)
cleaned=$(echo "$msg" | sed '/^Co-[Aa]uthored-[Bb]y:/d')

if [ "$msg" != "$cleaned" ]; then
  export AI_TEAM_STRIPPING_COAUTHOR=1
  echo "$cleaned" | git commit --amend -F -
fi
`;

  writeFileSync(hookPath, hookContent, { encoding: 'utf-8', mode: 0o755 });
  // chmodSync for platforms where writeFileSync mode is ignored
  try {
    chmodSync(hookPath, 0o755);
  } catch {
    // On Windows, chmod may be a no-op — Git Bash still executes hooks fine
  }
  const features = boundaryOpts ? 'boundary enforcement + Co-Authored-By stripping' : 'Co-Authored-By stripping';
  agentLog(agentKey, `Installed post-commit hook (${features})`, 'OK');
}

/**
 * Ensure an agent's workspace exists. Clones if missing, fetches if present.
 */
export function ensureAgentWorkspace(
  agentKey: string,
  agentConfig: AgentConfig,
  projectConfig: ProjectConfig,
): boolean {
  const dir = agentConfig.workingDir;
  const gitDir = join(dir, '.git');

  const boundaryOpts = getBoundaryHookOpts();

  if (existsSync(gitDir)) {
    agentLog(agentKey, 'Workspace exists — fetching latest...', 'INFO');
    try {
      execSync('git fetch origin --quiet', { cwd: dir, stdio: 'pipe' });
      agentLog(agentKey, 'Fetched latest from origin', 'OK');
    } catch (err) {
      agentLog(agentKey, `Fetch warning: ${err}`, 'WARN');
    }
    installPostCommitHook(dir, agentKey, boundaryOpts);
    return true;
  }

  agentLog(agentKey, `Workspace not found — cloning to ${dir}...`, 'INFO');
  const parentDir = join(dir, '..');
  ensureDir(parentDir);

  const { code } = execFileSafe('git', ['clone', projectConfig.repoUrl, dir, '--quiet']);
  if (code !== 0) {
    agentLog(agentKey, 'Clone FAILED — cannot continue', 'ERROR');
    return false;
  }

  // Configure git identity
  const emailDomain = projectConfig.emailDomain ?? projectConfig.name + '.local';
  execFileSync('git', ['config', 'user.name', `${agentConfig.displayName} (AI Agent)`], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', `ai-agent-${agentKey}@${emailDomain}`], { cwd: dir, stdio: 'pipe' });

  installPostCommitHook(dir, agentKey, boundaryOpts);

  agentLog(agentKey, `Cloned and configured → ${dir}`, 'OK');
  return true;
}

/**
 * Check that required CLI tools are installed.
 */
export function checkPrerequisites(config: OrchestratorConfig, includeClaude = false): void {
  const missing: string[] = [];

  // Git
  try {
    execSync('git --version', { stdio: 'pipe' });
  } catch {
    missing.push('git (https://git-scm.com)');
  }

  // GitHub CLI
  try {
    execSync('gh --version', { stdio: 'pipe' });
  } catch {
    missing.push('gh (https://cli.github.com)');
  }

  // Claude CLI
  if (includeClaude) {
    const cmd = config.settings.claudeCliCommand;
    try {
      execSync(`${cmd} --version`, { stdio: 'pipe' });
    } catch {
      missing.push(`${cmd} — Claude Code CLI (https://docs.anthropic.com/en/docs/claude-code)`);
    }
  }

  if (missing.length > 0) {
    console.error('\n  Missing prerequisites:');
    for (const m of missing) {
      console.error(`    • ${m}`);
    }
    console.error();
    throw new Error('Install missing prerequisites and try again.');
  }
}

/**
 * Format elapsed time from a start date/ISO string.
 */
export function getElapsedTime(start: string | Date): string {
  const startDate = start instanceof Date ? start : new Date(start);
  const ms = Date.now() - startDate.getTime();
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const seconds = Math.floor((ms % 60000) / 1000);

  if (hours >= 1) return `${hours}h ${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

/**
 * Strip YAML frontmatter (---...---) from a markdown/chatmode file.
 */
export function stripYamlFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return match ? match[1].trimStart() : content;
}

/**
 * Sleep for a given number of milliseconds.
 * Optionally accepts an AbortSignal to cancel early.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Check whether a process with the given PID is still running.
 * Uses signal 0 which checks existence without actually sending a signal.
 */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run local validation: lint → typecheck → test.
 * Mirrors the GitHub Actions pr-validation.yml workflow.
 * Stops on first failure (no point running tests if typecheck fails).
 */
export function runValidation(projectRoot: string): import('./types.js').ValidationResult[] {
  const steps = [
    { name: 'lint', cmd: 'npm run lint', timeoutMs: 120_000 },
    { name: 'typecheck', cmd: 'npm run typecheck', timeoutMs: 120_000 },
    { name: 'test', cmd: 'npm run test -- --passWithNoTests', timeoutMs: 300_000 },
  ];

  const results: import('./types.js').ValidationResult[] = [];

  for (const step of steps) {
    const start = Date.now();
    const { code, stdout, stderr } = execSafe(step.cmd, {
      cwd: projectRoot,
      timeout: step.timeoutMs,
    });
    const durationMs = Date.now() - start;
    const output = [stdout, stderr].filter(Boolean).join('\n');

    results.push({
      step: step.name,
      passed: code === 0,
      output,
      durationMs,
    });

    if (code !== 0) break; // stop on first failure
  }

  return results;
}

/**
 * Launch a CLI command in a new terminal window.
 * Tries Windows Terminal (wt.exe) first, falls back to cmd.exe.
 * Returns true if the window was launched successfully.
 * Only supported on Windows — returns false on other platforms.
 */
export function launchInNewWindow(title: string, command: string, cwd: string): boolean {
  if (process.platform !== 'win32') {
    console.error('  --detach is only supported on Windows.');
    return false;
  }

  const hasWt = (() => {
    try {
      execSync('where wt.exe', { stdio: 'ignore' });
      return true;
    } catch { return false; }
  })();

  try {
    if (hasWt) {
      spawn('wt.exe', [
        '-w', 'new',
        '--title', title,
        '-d', cwd,
        '--', 'cmd', '/c', command,
      ], { detached: true, stdio: 'ignore' }).unref();
    } else {
      // Fallback: open a standard cmd window
      spawn('cmd.exe', ['/c', 'start', `"${title}"`, 'cmd', '/c', command], {
        cwd,
        detached: true,
        stdio: 'ignore',
        shell: true,
      }).unref();
    }
    return true;
  } catch {
    return false;
  }
}
