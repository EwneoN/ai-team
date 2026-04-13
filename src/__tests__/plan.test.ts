import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { renderPlannerMd, buildPlannerPrompt, slugify } from '../commands/plan-prompt.js';
import { parseSpec } from '../spec-parser.js';
import { setProjectDir } from '../config.js';
import type { OrchestratorConfig } from '../types.js';

// ── Test helpers ─────────────────────────────────────────────

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
        ownedPaths: ['amplify/functions/**', 'amplify/shared/**', 'tests/unit/**'],
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

// ── slugify ──────────────────────────────────────────────────

describe('slugify', () => {
  it('converts spaces to hyphens', () => {
    expect(slugify('add billing with Stripe')).toBe('add-billing-with-stripe');
  });

  it('removes special characters', () => {
    expect(slugify('Add Billing! @Stripe #123')).toBe('add-billing-stripe-123');
  });

  it('trims leading/trailing hyphens', () => {
    expect(slugify('--hello world--')).toBe('hello-world');
  });

  it('truncates at word boundary, not mid-word', () => {
    const long = 'improve match tracker scoreboard active turn indicators the current scoreboard has a subtle tint';
    const result = slugify(long);
    expect(result.length).toBeLessThanOrEqual(50);
    expect(result).not.toMatch(/-$/); // no trailing hyphen
    expect(result).not.toMatch(/\b[a-z]$/); // shouldn't cut a word to 1 char
  });

  it('respects custom maxLen', () => {
    expect(slugify('one two three four five six', 15)).toBe('one-two-three');
  });

  it('handles empty string', () => {
    expect(slugify('')).toBe('');
  });
});

// ── buildPlannerPrompt ───────────────────────────────────────

describe('buildPlannerPrompt', () => {
  it('includes the intent string', () => {
    const prompt = buildPlannerPrompt('add billing with Stripe');
    expect(prompt).toContain('add billing with Stripe');
  });

  it('instructs agent to read CLAUDE.md', () => {
    const prompt = buildPlannerPrompt('anything');
    expect(prompt).toContain('CLAUDE.md');
  });

  it('instructs agent to explore codebase first', () => {
    const prompt = buildPlannerPrompt('anything');
    expect(prompt).toContain('exploring the codebase');
  });
});

// ── renderPlannerMd ──────────────────────────────────────────

describe('renderPlannerMd', () => {
  it('injects project name', () => {
    const md = renderPlannerMd({
      config: testConfig(),
      intent: 'test feature',
      outputDir: 'docs/specs',
      batchName: 'test-feature',
    });
    expect(md).toContain('TestProject');
  });

  it('injects intent', () => {
    const md = renderPlannerMd({
      config: testConfig(),
      intent: 'add billing with Stripe',
      outputDir: 'docs/specs',
      batchName: 'billing',
    });
    expect(md).toContain('add billing with Stripe');
  });

  it('injects output directory', () => {
    const md = renderPlannerMd({
      config: testConfig(),
      intent: 'test',
      outputDir: 'custom/specs',
      batchName: 'test',
    });
    expect(md).toContain('custom/specs');
  });

  it('injects batch name', () => {
    const md = renderPlannerMd({
      config: testConfig(),
      intent: 'test',
      outputDir: 'docs/specs',
      batchName: 'my-batch',
    });
    expect(md).toContain('my-batch');
  });

  it('includes agent boundaries for all configured agents', () => {
    const md = renderPlannerMd({
      config: testConfig(),
      intent: 'test',
      outputDir: 'docs/specs',
      batchName: 'test',
    });
    expect(md).toContain('backend — Backend Engineer');
    expect(md).toContain('frontend — Frontend Engineer');
    expect(md).toContain('amplify/functions/**');
    expect(md).toContain('src/**');
  });

  it('includes branch prefixes in boundaries', () => {
    const md = renderPlannerMd({
      config: testConfig(),
      intent: 'test',
      outputDir: 'docs/specs',
      batchName: 'test',
    });
    expect(md).toContain('Branch prefix: `backend`');
    expect(md).toContain('Branch prefix: `frontend`');
  });
});

// ── Integration: mock planner output passes validation ───────

import { validateBatch } from '../commands/validate.js';

describe('planner output integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `plan-test-${randomUUID()}`);
    mkdirSync(join(tmpDir, '.ai-team', 'batches'), { recursive: true });
    mkdirSync(join(tmpDir, 'docs', 'specs'), { recursive: true });

    // Write a minimal config.json so loadConfig works
    writeFileSync(
      join(tmpDir, '.ai-team', 'config.json'),
      JSON.stringify(testConfig(), null, 2),
    );

    setProjectDir(join(tmpDir, '.ai-team'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('mock spec passes parseSpec extraction', () => {
    const specContent = [
      '# Spec: backend — billing-api',
      '',
      '## Summary',
      'Add Stripe billing API endpoints.',
      '',
      '## Target Agent',
      '**backend** → Backend Engineer',
      '',
      '## Requirements',
      'Implement checkout session creation.',
      '',
      '### Files to Modify',
      '- amplify/functions/resolvers/subscriptions/createCheckoutSession/handler.ts',
      '- amplify/shared/lib/repositories/billing-repository.ts',
      '',
      '### Files NOT to Modify',
      '- src/app/billing/page.tsx (owned by frontend)',
      '',
      '## Acceptance Criteria',
      '- [ ] TypeScript compiles without errors',
    ].join('\n');

    const specPath = join(tmpDir, 'docs', 'specs', 'backend-billing-api.md');
    writeFileSync(specPath, specContent);

    const parsed = parseSpec(specPath);
    expect(parsed.targetAgent).toBe('backend');
    expect(parsed.filesToModify).toContain(
      'amplify/functions/resolvers/subscriptions/createCheckoutSession/handler.ts',
    );
    expect(parsed.filesToModify.length).toBe(2);
    expect(parsed.warnings.length).toBe(0);
  });

  it('mock batch with valid specs passes validateBatch', () => {
    // Write spec files
    const backendSpec = [
      '# Spec: backend — billing',
      '## Target Agent',
      '**backend** → Backend Engineer',
      '### Files to Modify',
      '- amplify/functions/resolvers/billing/handler.ts',
    ].join('\n');

    const frontendSpec = [
      '# Spec: frontend — billing-ui',
      '## Target Agent',
      '**frontend** → Frontend Engineer',
      '### Files to Modify',
      '- src/app/billing/page.tsx',
    ].join('\n');

    writeFileSync(join(tmpDir, 'docs', 'specs', 'backend-billing.md'), backendSpec);
    writeFileSync(join(tmpDir, 'docs', 'specs', 'frontend-billing-ui.md'), frontendSpec);

    // Write batch file
    const batch = {
      name: 'billing',
      baseBranch: 'main',
      description: 'Add billing',
      assignments: [
        {
          agent: 'backend',
          spec: 'backend-billing',
          specPath: 'docs/specs/backend-billing.md',
          description: 'Billing API',
          round: 1,
        },
        {
          agent: 'frontend',
          spec: 'frontend-billing-ui',
          specPath: 'docs/specs/frontend-billing-ui.md',
          description: 'Billing UI',
          round: 2,
        },
      ],
    };

    const batchPath = join(tmpDir, '.ai-team', 'batches', 'billing.json');
    writeFileSync(batchPath, JSON.stringify(batch, null, 2));

    const result = validateBatch({ batchFile: batchPath });

    expect(result.errors.length).toBe(0);
  });
});
