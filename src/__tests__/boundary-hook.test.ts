import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync, execSync } from 'node:child_process';
import { checkBoundaryViolations } from '../boundary-check.js';
import { installPostCommitHook } from '../helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── checkBoundaryViolations (shared logic) ───────────────────

describe('checkBoundaryViolations', () => {
  const ownedPaths = ['src/**', 'tests/**', 'next.config.ts'];

  it('returns empty array when all files are within boundaries', () => {
    const files = ['src/app/page.tsx', 'src/components/Button.tsx', 'tests/unit/foo.test.ts'];
    expect(checkBoundaryViolations(files, ownedPaths)).toEqual([]);
  });

  it('returns violations for files outside boundaries', () => {
    const files = ['src/app/page.tsx', 'amplify/functions/handler.ts', 'docs/README.md'];
    const violations = checkBoundaryViolations(files, ownedPaths);
    expect(violations).toEqual(['amplify/functions/handler.ts', 'docs/README.md']);
  });

  it('allows exact file matches (not just globs)', () => {
    const files = ['next.config.ts'];
    expect(checkBoundaryViolations(files, ownedPaths)).toEqual([]);
  });

  it('returns empty for empty file list', () => {
    expect(checkBoundaryViolations([], ownedPaths)).toEqual([]);
  });

  it('returns empty when no boundaries defined', () => {
    const files = ['anything/goes.ts'];
    expect(checkBoundaryViolations(files, [])).toEqual([]);
  });

  it('handles dotfiles with dot: true', () => {
    const paths = ['.github/**'];
    const files = ['.github/workflows/ci.yml'];
    expect(checkBoundaryViolations(files, paths)).toEqual([]);
  });

  it('rejects files that partially match but are outside glob', () => {
    const paths = ['src/**'];
    const files = ['src-backup/old.ts'];
    expect(checkBoundaryViolations(files, paths)).toEqual(['src-backup/old.ts']);
  });
});

// ── installPostCommitHook ─────────────────────────────────────

describe('installPostCommitHook', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `hook-test-${randomUUID()}`);
    mkdirSync(join(tmpDir, '.git', 'hooks'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates post-commit hook file', () => {
    installPostCommitHook(tmpDir, 'backend');
    const hookPath = join(tmpDir, '.git', 'hooks', 'post-commit');
    expect(existsSync(hookPath)).toBe(true);
  });

  it('hook contains co-author stripping logic', () => {
    installPostCommitHook(tmpDir, 'backend');
    const content = readFileSync(join(tmpDir, '.git', 'hooks', 'post-commit'), 'utf-8');
    expect(content).toContain('Co-Authored-By');
    expect(content).toContain('AI_TEAM_STRIPPING_COAUTHOR');
  });

  it('hook without boundary opts has no boundary check', () => {
    installPostCommitHook(tmpDir, 'backend');
    const content = readFileSync(join(tmpDir, '.git', 'hooks', 'post-commit'), 'utf-8');
    expect(content).not.toContain('boundary-hook');
    expect(content).not.toContain('BOUNDARY VIOLATION');
  });

  it('hook with boundary opts includes boundary enforcement', () => {
    installPostCommitHook(tmpDir, 'backend', {
      boundaryHookPath: '/path/to/dist/boundary-hook.js',
      configPath: '/path/to/config.json',
    });
    const content = readFileSync(join(tmpDir, '.git', 'hooks', 'post-commit'), 'utf-8');
    expect(content).toContain('boundary-hook.js');
    expect(content).toContain('config.json');
    expect(content).toContain('--agent "backend"');
    // Handles initial commits
    expect(content).toContain('git rev-parse --verify HEAD^');
    expect(content).toContain('git update-ref -d HEAD');
    expect(content).toContain('git reset --soft HEAD~1');
  });

  it('always uses node to run the boundary hook script', () => {
    installPostCommitHook(tmpDir, 'backend', {
      boundaryHookPath: '/dist/boundary-hook.js',
      configPath: '/config.json',
    });
    const content = readFileSync(join(tmpDir, '.git', 'hooks', 'post-commit'), 'utf-8');
    expect(content).toContain('node "/dist/boundary-hook.js"');
    expect(content).not.toContain('npx');
    expect(content).not.toContain('tsx');
  });

  it('converts Windows backslashes to forward slashes in hook paths', () => {
    installPostCommitHook(tmpDir, 'frontend', {
      boundaryHookPath: 'C:\\Users\\dev\\ai-team\\dist\\boundary-hook.js',
      configPath: 'C:\\Users\\dev\\project\\.ai-team\\config.json',
    });
    const content = readFileSync(join(tmpDir, '.git', 'hooks', 'post-commit'), 'utf-8');
    expect(content).not.toContain('\\');
    expect(content).toContain('C:/Users/dev/ai-team/dist/boundary-hook.js');
    expect(content).toContain('C:/Users/dev/project/.ai-team/config.json');
  });

  it('boundary check runs before co-author stripping', () => {
    installPostCommitHook(tmpDir, 'backend', {
      boundaryHookPath: '/dist/boundary-hook.js',
      configPath: '/config.json',
    });
    const content = readFileSync(join(tmpDir, '.git', 'hooks', 'post-commit'), 'utf-8');
    const boundaryIdx = content.indexOf('boundary-hook');
    // Match the actual sed stripping command, not the header comment
    const coAuthorIdx = content.indexOf("sed '/^Co-");
    expect(boundaryIdx).toBeLessThan(coAuthorIdx);
  });

  it('only resets on exit code 10 (violations), warns on other failures', () => {
    installPostCommitHook(tmpDir, 'backend', {
      boundaryHookPath: '/dist/boundary-hook.js',
      configPath: '/config.json',
    });
    const content = readFileSync(join(tmpDir, '.git', 'hooks', 'post-commit'), 'utf-8');
    // Captures exit code
    expect(content).toContain('status=$?');
    // Only resets on exit 10
    expect(content).toContain('"$status" -eq 10');
    // Warns on other non-zero codes
    expect(content).toContain('skipping boundary enforcement');
  });
});

// ── Integration: boundary-hook.ts in a real git repo ─────────

describe('boundary-hook integration', () => {
  let repoDir: string;
  let configDir: string;
  let configPath: string;

  beforeEach(() => {
    // Create separate dirs: one for the git repo, one for the config
    const baseDir = join(tmpdir(), `boundary-test-${randomUUID()}`);
    repoDir = join(baseDir, 'repo');
    configDir = join(baseDir, 'config');
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });

    // Init a real git repo
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir, stdio: 'pipe' });

    // Write config OUTSIDE the repo so it doesn't get committed
    const config = {
      agents: {
        backend: {
          ownedPaths: ['amplify/**', 'tests/unit/**'],
        },
        frontend: {
          ownedPaths: ['src/**'],
        },
      },
    };
    configPath = join(configDir, 'config.json');
    writeFileSync(configPath, JSON.stringify(config));
  });

  afterEach(() => {
    rmSync(join(repoDir, '..'), { recursive: true, force: true });
  });

  it('exits 0 when committed files are within boundaries', () => {
    // Create a file within backend boundaries and commit it
    mkdirSync(join(repoDir, 'amplify', 'functions'), { recursive: true });
    writeFileSync(join(repoDir, 'amplify', 'functions', 'handler.ts'), 'export {}');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'test'], { cwd: repoDir, stdio: 'pipe' });

    // Run boundary hook
    const result = runBoundaryHook(repoDir, 'backend');
    expect(result.code).toBe(0);
  });

  it('exits 10 when committed files violate boundaries', () => {
    // Create a file outside backend boundaries and commit it
    mkdirSync(join(repoDir, 'src', 'app'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'app', 'page.tsx'), 'export {}');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'test'], { cwd: repoDir, stdio: 'pipe' });

    // Run boundary hook
    const result = runBoundaryHook(repoDir, 'backend');
    expect(result.code).toBe(10);
    expect(result.stderr).toContain('BOUNDARY VIOLATION');
    expect(result.stderr).toContain('src/app/page.tsx');
  });

  it('lists only violating files, not allowed ones', () => {
    // Create both allowed and disallowed files
    mkdirSync(join(repoDir, 'amplify', 'functions'), { recursive: true });
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    writeFileSync(join(repoDir, 'amplify', 'functions', 'ok.ts'), 'export {}');
    writeFileSync(join(repoDir, 'src', 'bad.ts'), 'export {}');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'test'], { cwd: repoDir, stdio: 'pipe' });

    const result = runBoundaryHook(repoDir, 'backend');
    expect(result.code).toBe(10);
    expect(result.stderr).toContain('src/bad.ts');
    expect(result.stderr).not.toContain('amplify/functions/ok.ts');
  });

  it('exits 0 for unknown agent (graceful skip)', () => {
    mkdirSync(join(repoDir, 'anything'), { recursive: true });
    writeFileSync(join(repoDir, 'anything', 'file.ts'), 'export {}');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'test'], { cwd: repoDir, stdio: 'pipe' });

    const result = runBoundaryHook(repoDir, 'nonexistent');
    expect(result.code).toBe(0);
  });

  it('exits 0 when no files changed (empty commit)', () => {
    // Create initial commit so HEAD exists
    writeFileSync(join(repoDir, 'init.txt'), 'init');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'pipe' });

    // Empty commit
    execFileSync('git', ['commit', '--allow-empty', '-m', 'empty'], { cwd: repoDir, stdio: 'pipe' });

    const result = runBoundaryHook(repoDir, 'backend');
    expect(result.code).toBe(0);
  });

  /** Helper: run boundary-hook.ts via tsx against the test repo */
  function runBoundaryHook(cwd: string, agent: string): { code: number; stdout: string; stderr: string } {
    const scriptPath = join(__dirname, '..', 'boundary-hook.ts');
    // Run npx from ai-team root (where tsx is installed), but point git at the test repo
    const aiTeamRoot = join(__dirname, '..', '..');
    const cmd = `npx tsx "${scriptPath}" --agent "${agent}" --config "${configPath}"`;
    try {
      const stdout = execSync(cmd, {
        cwd: aiTeamRoot,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GIT_DIR: join(cwd, '.git'),
          GIT_WORK_TREE: cwd,
        },
      });
      return { code: 0, stdout: stdout.trim(), stderr: '' };
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return {
        code: e.status ?? 1,
        stdout: (e.stdout ?? '').toString().trim(),
        stderr: (e.stderr ?? '').toString().trim(),
      };
    }
  }
});
