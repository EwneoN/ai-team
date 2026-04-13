import { describe, it, expect } from 'vitest';
import { resolveModel } from '../config.js';
import type { OrchestratorConfig, BatchAssignment } from '../types.js';

function baseConfig(overrides?: Partial<OrchestratorConfig>): OrchestratorConfig {
  return {
    project: { name: 'Test', repoUrl: 'https://github.com/test/repo', mainBranch: 'main' },
    agents: {
      backend: {
        displayName: 'Backend',
        agentId: 'be-001',
        workingDir: '/tmp/test-backend',
        briefPath: 'docs/briefs/backend.md',
        globalRulesPath: '.github/copilot-instructions.md',
        chatmodeFile: '.github/agents/backend.md',
        ownedPaths: ['src/backend/**'],
        branchPrefix: 'be',
      },
      architect: {
        displayName: 'Architect',
        agentId: 'arch-001',
        workingDir: '/tmp/test-architect',
        briefPath: 'docs/briefs/architect.md',
        globalRulesPath: '.github/copilot-instructions.md',
        chatmodeFile: '.github/agents/architect.md',
        ownedPaths: ['docs/**'],
        branchPrefix: 'arch',
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
    ...overrides,
  };
}

function assignment(overrides?: Partial<BatchAssignment>): BatchAssignment {
  return {
    agent: 'backend',
    spec: 'drive-state',
    specPath: 'docs/specs/backend-drive-state.md',
    description: 'Drive state management',
    ...overrides,
  };
}

describe('resolveModel', () => {
  it('returns global coAgent model when no overrides are set', () => {
    const config = baseConfig();
    expect(resolveModel(config, 'backend')).toBe('claude-sonnet-4-6');
  });

  it('returns global architect model for architect key', () => {
    const config = baseConfig({
      models: { architect: 'claude-opus-4-6', coAgent: 'claude-sonnet-4-6', fallback: 'claude-sonnet-4-6' },
    });
    expect(resolveModel(config, 'architect')).toBe('claude-opus-4-6');
  });

  it('uses agent-level model override over global default', () => {
    const config = baseConfig();
    config.agents.backend.model = 'claude-opus-4-6';
    expect(resolveModel(config, 'backend')).toBe('claude-opus-4-6');
  });

  it('uses batch assignment model override over agent-level', () => {
    const config = baseConfig();
    config.agents.backend.model = 'claude-opus-4-6';
    const a = assignment({ model: 'claude-haiku-35' });
    expect(resolveModel(config, 'backend', a)).toBe('claude-haiku-35');
  });

  it('uses batch assignment model over global when no agent-level set', () => {
    const config = baseConfig();
    const a = assignment({ model: 'claude-opus-4-6' });
    expect(resolveModel(config, 'backend', a)).toBe('claude-opus-4-6');
  });

  it('falls back to global when assignment has no model override', () => {
    const config = baseConfig();
    config.agents.backend.model = 'claude-opus-4-6';
    const a = assignment(); // no model field
    expect(resolveModel(config, 'backend', a)).toBe('claude-opus-4-6');
  });

  it('falls through to global for unknown agent keys', () => {
    const config = baseConfig();
    expect(resolveModel(config, 'nonexistent')).toBe('claude-sonnet-4-6');
  });
});
