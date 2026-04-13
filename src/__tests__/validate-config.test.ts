import { describe, it, expect } from 'vitest';
import { validateConfig } from '../config.js';
import type { OrchestratorConfig } from '../types.js';

function validConfig(): OrchestratorConfig {
  return {
    project: { name: 'TestProject', repoUrl: 'https://github.com/test/repo', mainBranch: 'main' },
    agents: {
      backend: {
        displayName: 'Backend Engineer',
        agentId: 'backend-001',
        workingDir: '/tmp/test-backend',
        briefPath: 'docs/briefs/backend.md',
        globalRulesPath: '.github/copilot-instructions.md',
        chatmodeFile: '.github/agents/backend.md',
        ownedPaths: ['src/backend/**'],
        branchPrefix: 'be',
      },
    },
    models: { architect: 'claude-sonnet-4-6', coAgent: 'claude-sonnet-4-6', fallback: 'claude-sonnet-4-6' },
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
  };
}

describe('validateConfig', () => {
  it('accepts a valid config without throwing', () => {
    expect(() => validateConfig(validConfig())).not.toThrow();
  });

  it('rejects missing project section', () => {
    const cfg = validConfig();
    (cfg as unknown as Record<string, unknown>).project = undefined;
    expect(() => validateConfig(cfg)).toThrow('Missing "project" section');
  });

  it('rejects missing project.name', () => {
    const cfg = validConfig();
    cfg.project.name = '';
    expect(() => validateConfig(cfg)).toThrow('project.name');
  });

  it('rejects missing project.repoUrl and project.mainBranch together', () => {
    const cfg = validConfig();
    cfg.project.repoUrl = '';
    cfg.project.mainBranch = '';
    expect(() => validateConfig(cfg)).toThrow(/project\.repoUrl.*project\.mainBranch/s);
  });

  it('rejects empty agents', () => {
    const cfg = validConfig();
    cfg.agents = {};
    expect(() => validateConfig(cfg)).toThrow('at least one agent');
  });

  it('rejects agent missing required fields', () => {
    const cfg = validConfig();
    cfg.agents.broken = {
      displayName: '',
      agentId: '',
      workingDir: '/tmp',
      briefPath: '',
      globalRulesPath: '',
      chatmodeFile: '',
      ownedPaths: [],
      branchPrefix: '',
    };
    const err = getValidationError(cfg);
    expect(err).toContain('agents.broken: missing "displayName"');
    expect(err).toContain('agents.broken: missing "agentId"');
    expect(err).toContain('agents.broken: missing or empty "ownedPaths"');
  });

  it('rejects missing models section', () => {
    const cfg = validConfig();
    (cfg as unknown as Record<string, unknown>).models = undefined;
    expect(() => validateConfig(cfg)).toThrow('Missing "models" section');
  });

  it('rejects missing models.architect', () => {
    const cfg = validConfig();
    cfg.models.architect = '';
    expect(() => validateConfig(cfg)).toThrow('models.architect');
  });

  it('rejects missing settings section', () => {
    const cfg = validConfig();
    (cfg as unknown as Record<string, unknown>).settings = undefined;
    expect(() => validateConfig(cfg)).toThrow('Missing "settings" section');
  });

  it('rejects non-numeric maxReviewCycles', () => {
    const cfg = validConfig();
    (cfg.settings as unknown as Record<string, unknown>).maxReviewCycles = 'three';
    expect(() => validateConfig(cfg)).toThrow('settings.maxReviewCycles');
  });

  it('lists ALL errors at once, not just the first', () => {
    const cfg = validConfig();
    cfg.project.name = '';
    cfg.project.repoUrl = '';
    cfg.models.architect = '';
    const err = getValidationError(cfg);
    expect(err).toContain('project.name');
    expect(err).toContain('project.repoUrl');
    expect(err).toContain('models.architect');
  });
});

function getValidationError(cfg: OrchestratorConfig): string {
  try {
    validateConfig(cfg);
    return '';
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }
}
