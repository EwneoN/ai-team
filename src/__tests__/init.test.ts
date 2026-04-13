import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { init } from '../commands/init.js';
import { renderPlannerAgentMd, renderPlanClaudeCommand } from '../templates.js';
import { setProjectDir } from '../config.js';
import type { OrchestratorConfig } from '../types.js';

function testConfig(): OrchestratorConfig {
  return {
    project: {
      name: 'TestProject',
      repoUrl: 'https://github.com/test/repo',
      mainBranch: 'main',
    },
    agents: {
      backend: {
        displayName: 'Backend Engineer',
        agentId: 'backend-001',
        workingDir: '/tmp/test-backend',
        briefPath: 'docs/briefs/backend.md',
        globalRulesPath: '.github/copilot-instructions.md',
        chatmodeFile: '.github/agents/backend.md',
        ownedPaths: ['amplify/functions/**', 'amplify/shared/**'],
        branchPrefix: 'backend',
      },
      frontend: {
        displayName: 'Frontend Engineer',
        agentId: 'frontend-001',
        workingDir: '/tmp/test-frontend',
        briefPath: 'docs/briefs/frontend.md',
        globalRulesPath: '.github/copilot-instructions.md',
        chatmodeFile: '.github/agents/frontend.md',
        ownedPaths: ['src/**', 'next.config.ts'],
        branchPrefix: 'frontend',
      },
    },
    models: {
      architect: 'claude-sonnet-4-6',
      coAgent: 'claude-sonnet-4-6',
      fallback: 'claude-sonnet-4-6',
    },
    settings: {
      reviewMode: 'copilot',
      copilotReviewPollIntervalSeconds: 30,
      copilotReviewTimeoutMinutes: 10,
      maxReviewCycles: 3,
      monitorPollIntervalSeconds: 15,
      maxRetries: 2,
      retryBaseDelaySeconds: 5,
      launchStaggerSeconds: 2,
      maxBudgetUsd: 10,
      notifications: { enabled: false },
    },
  } as OrchestratorConfig;
}

// ── renderPlannerAgentMd ─────────────────────────────────────

describe('renderPlannerAgentMd', () => {
  it('injects project name', () => {
    const md = renderPlannerAgentMd({
      config: testConfig(),
      projectDir: '.ai-team',
    });
    expect(md).toContain('TestProject');
  });

  it('injects project dir', () => {
    const md = renderPlannerAgentMd({
      config: testConfig(),
      projectDir: '.ai-team',
    });
    expect(md).toContain('ai-team -p .ai-team plan');
  });

  it('injects spec output dir with default', () => {
    const md = renderPlannerAgentMd({
      config: testConfig(),
      projectDir: '.ai-team',
    });
    expect(md).toContain('docs/specs');
  });

  it('injects custom spec output dir', () => {
    const md = renderPlannerAgentMd({
      config: testConfig(),
      projectDir: '.ai-team',
      specOutputDir: 'custom/specs',
    });
    expect(md).toContain('custom/specs');
  });

  it('includes agent boundaries for all agents', () => {
    const md = renderPlannerAgentMd({
      config: testConfig(),
      projectDir: '.ai-team',
    });
    expect(md).toContain('backend — Backend Engineer');
    expect(md).toContain('frontend — Frontend Engineer');
    expect(md).toContain('amplify/functions/**');
    expect(md).toContain('src/**');
  });

  it('is valid YAML frontmatter', () => {
    const md = renderPlannerAgentMd({
      config: testConfig(),
      projectDir: '.ai-team',
    });
    expect(md).toMatch(/^---\r?\n/);
    expect(md).toMatch(/\r?\n---\r?\n/);
  });

  it('includes description with project name for discovery', () => {
    const md = renderPlannerAgentMd({
      config: testConfig(),
      projectDir: '.ai-team',
    });
    const descLine = md.split('\n').find((l) => l.startsWith('description:'));
    expect(descLine).toContain('TestProject');
  });
});

// ── renderPlanClaudeCommand ──────────────────────────────────

describe('renderPlanClaudeCommand', () => {
  it('injects project name', () => {
    const md = renderPlanClaudeCommand({
      config: testConfig(),
      projectDir: '.ai-team',
    });
    expect(md).toContain('TestProject');
  });

  it('injects project dir', () => {
    const md = renderPlanClaudeCommand({
      config: testConfig(),
      projectDir: '.ai-team',
    });
    expect(md).toContain('ai-team -p .ai-team plan');
  });

  it('injects spec output dir with default', () => {
    const md = renderPlanClaudeCommand({
      config: testConfig(),
      projectDir: '.ai-team',
    });
    expect(md).toContain('docs/specs');
  });

  it('injects custom spec output dir', () => {
    const md = renderPlanClaudeCommand({
      config: testConfig(),
      projectDir: '.ai-team',
      specOutputDir: 'custom/specs',
    });
    expect(md).toContain('custom/specs');
  });

  it('includes agent boundaries for all agents', () => {
    const md = renderPlanClaudeCommand({
      config: testConfig(),
      projectDir: '.ai-team',
    });
    expect(md).toContain('backend — Backend Engineer');
    expect(md).toContain('frontend — Frontend Engineer');
    expect(md).toContain('amplify/functions/**');
    expect(md).toContain('src/**');
  });

  it('has no YAML frontmatter', () => {
    const md = renderPlanClaudeCommand({
      config: testConfig(),
      projectDir: '.ai-team',
    });
    expect(md).not.toMatch(/^---\r?\n/);
  });

  it('includes $ARGUMENTS placeholder', () => {
    const md = renderPlanClaudeCommand({
      config: testConfig(),
      projectDir: '.ai-team',
    });
    expect(md).toContain('$ARGUMENTS');
  });
});

// ── init command ─────────────────────────────────────────────

describe('init', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `init-test-${randomUUID()}`);
    mkdirSync(join(tmpDir, '.ai-team'), { recursive: true });

    writeFileSync(
      join(tmpDir, '.ai-team', 'config.json'),
      JSON.stringify(testConfig(), null, 2),
    );

    setProjectDir(join(tmpDir, '.ai-team'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates planner.agent.md in .github/agents/', () => {
    init({ force: false });
    const target = join(tmpDir, '.github', 'agents', 'planner.agent.md');
    expect(existsSync(target)).toBe(true);
  });

  it('generated file contains project name', () => {
    init({ force: false });
    const target = join(tmpDir, '.github', 'agents', 'planner.agent.md');
    const content = readFileSync(target, 'utf-8');
    expect(content).toContain('TestProject');
  });

  it('skips if file already exists (no --force)', () => {
    const target = join(tmpDir, '.github', 'agents', 'planner.agent.md');
    mkdirSync(join(tmpDir, '.github', 'agents'), { recursive: true });
    writeFileSync(target, 'custom content');

    init({ force: false });

    const content = readFileSync(target, 'utf-8');
    expect(content).toBe('custom content');
  });

  it('overwrites if --force is set', () => {
    const target = join(tmpDir, '.github', 'agents', 'planner.agent.md');
    mkdirSync(join(tmpDir, '.github', 'agents'), { recursive: true });
    writeFileSync(target, 'custom content');

    init({ force: true });

    const content = readFileSync(target, 'utf-8');
    expect(content).not.toBe('custom content');
    expect(content).toContain('TestProject');
  });

  it('creates .github/agents/ directory if missing', () => {
    const agentsDir = join(tmpDir, '.github', 'agents');
    expect(existsSync(agentsDir)).toBe(false);

    init({ force: false });

    expect(existsSync(agentsDir)).toBe(true);
  });

  it('creates plan.md in .claude/commands/', () => {
    init({ force: false });
    const target = join(tmpDir, '.claude', 'commands', 'plan.md');
    expect(existsSync(target)).toBe(true);
  });

  it('Claude Code plan.md contains project name', () => {
    init({ force: false });
    const target = join(tmpDir, '.claude', 'commands', 'plan.md');
    const content = readFileSync(target, 'utf-8');
    expect(content).toContain('TestProject');
  });

  it('scaffolds both files in a single init call', () => {
    init({ force: false });
    expect(existsSync(join(tmpDir, '.github', 'agents', 'planner.agent.md'))).toBe(true);
    expect(existsSync(join(tmpDir, '.claude', 'commands', 'plan.md'))).toBe(true);
  });
});
