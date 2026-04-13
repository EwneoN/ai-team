import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { generateRoundSummary, buildCumulativeContext, renderClaudeMd } from '../templates.js';
import type { AgentConfig, BatchAssignment, BatchConfig, OrchState, OrchAgentState } from '../types.js';

// ── Helpers ──────────────────────────────────────────────────

let tmpDir: string;
let agentDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `ctx-fwd-test-${randomUUID()}`);
  agentDir = join(tmpDir, 'agent');
  mkdirSync(agentDir, { recursive: true });
  // Create minimal agent files
  writeFileSync(join(agentDir, 'chatmode.md'), '# Chatmode\nRules here.');
  writeFileSync(join(agentDir, 'global-rules.md'), '# Global\nShared rules.');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeOrchAgentState(overrides?: Partial<OrchAgentState>): OrchAgentState {
  return {
    status: 'merged',
    lastReviewedCycle: 1,
    prNumber: 42,
    prUrl: 'https://github.com/org/repo/pull/42',
    reviewHistory: [],
    ...overrides,
  };
}

function makeBatch(assignments: BatchAssignment[]): BatchConfig {
  return {
    name: 'test-batch',
    description: 'Test batch',
    assignments,
  };
}

function makeOrchState(agents: Record<string, OrchAgentState>, roundSummaries?: Record<number, string>): OrchState {
  return {
    batchName: 'test-batch',
    startedAt: new Date().toISOString(),
    agents,
    roundSummaries,
  };
}

// ── generateRoundSummary ────────────────────────────────────

describe('generateRoundSummary', () => {
  it('returns empty string for round with no assignments', () => {
    const batch = makeBatch([
      { agent: 'backend', spec: 'api', specPath: 'specs/api.md', description: 'Add API', round: 1 },
    ]);
    const orchState = makeOrchState({ 'backend/api': makeOrchAgentState() });

    const result = generateRoundSummary({ orchState, batch, round: 2 });
    expect(result).toBe('');
  });

  it('generates summary with agent info and status', () => {
    const batch = makeBatch([
      { agent: 'backend', spec: 'api', specPath: 'specs/api.md', description: 'Add API endpoints', round: 1 },
    ]);
    const orchState = makeOrchState({
      'backend/api': makeOrchAgentState({ prNumber: 42, status: 'merged' }),
    });

    // Mock gh pr view by not providing it — falls back to assignment description
    const result = generateRoundSummary({ orchState, batch, round: 1 });

    expect(result).toContain('### Round 1');
    expect(result).toContain('**backend** — Add API endpoints');
    expect(result).toContain('PR: #42 (merged)');
  });

  it('includes signal notes when provided', () => {
    const batch = makeBatch([
      { agent: 'frontend', spec: 'dashboard', specPath: 'specs/dash.md', description: 'Build dashboard', round: 1 },
    ]);
    const orchState = makeOrchState({
      'frontend/dashboard': makeOrchAgentState({ prNumber: 55 }),
    });

    const result = generateRoundSummary({
      orchState,
      batch,
      round: 1,
      readSignalNotes: () => 'Added new Chart component using recharts',
    });

    expect(result).toContain('Notes: Added new Chart component using recharts');
  });

  it('handles multiple agents in the same round', () => {
    const batch = makeBatch([
      { agent: 'backend', spec: 'api', specPath: 'specs/api.md', description: 'Add API', round: 1 },
      { agent: 'frontend', spec: 'ui', specPath: 'specs/ui.md', description: 'Build UI', round: 1 },
    ]);
    const orchState = makeOrchState({
      'backend/api': makeOrchAgentState({ prNumber: 10 }),
      'frontend/ui': makeOrchAgentState({ prNumber: 11 }),
    });

    const result = generateRoundSummary({ orchState, batch, round: 1 });

    expect(result).toContain('**backend**');
    expect(result).toContain('**frontend**');
    expect(result).toContain('PR: #10');
    expect(result).toContain('PR: #11');
  });

  it('skips agents with no orch state', () => {
    const batch = makeBatch([
      { agent: 'backend', spec: 'api', specPath: 'specs/api.md', description: 'Add API', round: 1 },
      { agent: 'ghost', spec: 'phantom', specPath: 'specs/phantom.md', description: 'Ghost task', round: 1 },
    ]);
    const orchState = makeOrchState({
      'backend/api': makeOrchAgentState({ prNumber: 10 }),
      // ghost/phantom has no entry
    });

    const result = generateRoundSummary({ orchState, batch, round: 1 });

    expect(result).toContain('**backend**');
    expect(result).not.toContain('**ghost**');
  });

  it('handles agents with no PR number', () => {
    const batch = makeBatch([
      { agent: 'backend', spec: 'api', specPath: 'specs/api.md', description: 'Add API', round: 1 },
    ]);
    const orchState = makeOrchState({
      'backend/api': makeOrchAgentState({ prNumber: null, status: 'failed' }),
    });

    const result = generateRoundSummary({ orchState, batch, round: 1 });

    expect(result).toContain('PR: #? (failed)');
  });
});

// ── buildCumulativeContext ───────────────────────────────────

describe('buildCumulativeContext', () => {
  it('returns empty string when no roundSummaries exist', () => {
    const orchState = makeOrchState({});
    expect(buildCumulativeContext(orchState)).toBe('');
  });

  it('returns empty string when roundSummaries is empty object', () => {
    const orchState = makeOrchState({}, {});
    expect(buildCumulativeContext(orchState)).toBe('');
  });

  it('returns context block with single round summary', () => {
    const orchState = makeOrchState({}, {
      1: '### Round 1\n\n**backend** — Add API\n- PR: #42 (merged)',
    });

    const result = buildCumulativeContext(orchState);

    expect(result).toContain('## Context from Previous Rounds');
    expect(result).toContain('### Round 1');
    expect(result).toContain('**backend** — Add API');
  });

  it('concatenates multiple rounds in order', () => {
    const orchState = makeOrchState({}, {
      2: '### Round 2\n\n**frontend** — Build UI',
      1: '### Round 1\n\n**backend** — Add API',
    });

    const result = buildCumulativeContext(orchState);

    const round1Pos = result.indexOf('Round 1');
    const round2Pos = result.indexOf('Round 2');
    expect(round1Pos).toBeLessThan(round2Pos);
  });
});

// ── Template placeholder ────────────────────────────────────

describe('{PREVIOUS_ROUND_CONTEXT} placeholder', () => {
  function minimalTemplate(): string {
    return `# {AGENT_DISPLAY_NAME}

{CHATMODE_CONTENT}

{GLOBAL_RULES_CONTENT}

{PROJECT_RULES}

{PREVIOUS_ROUND_CONTEXT}

---

## Task

Spec: {SPEC_PATH}
Desc: {SPEC_DESCRIPTION}
Branch: {BRANCH_NAME}
Batch: {BATCH_BRANCH}
Signal: {SIGNAL_FILE_PATH}
Cycles: {MAX_REVIEW_CYCLES}
ID: {AGENT_ID}
Key: {AGENT_KEY}
Owned: {OWNED_PATHS_LIST}
Name: {PROJECT_NAME}
SignalId: {SIGNAL_ID}
Spec name: {SPEC_NAME}
`;
  }

  function createAgentConfig(): AgentConfig {
    return {
      displayName: 'Backend Engineer',
      agentId: 'backend-001',
      workingDir: agentDir,
      briefPath: 'docs/briefs/backend.md',
      globalRulesPath: 'global-rules.md',
      chatmodeFile: 'chatmode.md',
      ownedPaths: ['src/backend/**'],
      branchPrefix: 'backend',
    };
  }

  it('renders empty when previousRoundContext is not provided', () => {
    const result = renderClaudeMd({
      template: minimalTemplate(),
      agentKey: 'backend',
      agentConfig: createAgentConfig(),
      assignment: { agent: 'backend', spec: 'api', specPath: 'specs/api.md', description: 'Add API', round: 1 },
      batchName: 'test-batch',
      signalFilePath: '/tmp/signal.json',
      maxReviewCycles: 10,
      projectName: 'TestProject',
    });

    // Should not contain the context header
    expect(result).not.toContain('Context from Previous Rounds');
  });

  it('renders context when previousRoundContext is provided', () => {
    const context = `---

## Context from Previous Rounds

### Round 1

**backend** — feat: add API
- PR: #42 (merged)`;

    const result = renderClaudeMd({
      template: minimalTemplate(),
      agentKey: 'frontend',
      agentConfig: createAgentConfig(),
      assignment: { agent: 'frontend', spec: 'ui', specPath: 'specs/ui.md', description: 'Build UI', round: 2 },
      batchName: 'test-batch',
      signalFilePath: '/tmp/signal.json',
      maxReviewCycles: 10,
      projectName: 'TestProject',
      previousRoundContext: context,
    });

    expect(result).toContain('Context from Previous Rounds');
    expect(result).toContain('**backend** — feat: add API');
    expect(result).toContain('PR: #42 (merged)');
  });
});

// ── Review prompt PR description update ─────────────────────

describe('review prompt PR description update', () => {
  it('includes instruction to update PR description', async () => {
    // Import generateReviewPrompt
    const { generateReviewPrompt } = await import('../templates.js');

    const result = generateReviewPrompt({
      agentConfig: {
        displayName: 'Backend Engineer',
        agentId: 'backend-001',
        workingDir: agentDir,
        briefPath: 'docs/briefs/backend.md',
        globalRulesPath: 'global-rules.md',
        chatmodeFile: 'chatmode.md',
        ownedPaths: ['src/backend/**'],
        branchPrefix: 'backend',
      },
      assignment: { agent: 'backend', spec: 'api', specPath: 'specs/api.md', description: 'Add API', round: 1 },
      agentKey: 'backend',
      specName: 'api',
      subBranch: 'batch/test--backend--api',
      signalFile: '/tmp/signal.json',
      cycle: 2,
      maxCycles: 10,
      feedbackText: 'Fix the auth check',
      projectName: 'TestProject',
      prUrl: 'https://github.com/org/repo/pull/42',
    });

    expect(result).toContain('Update PR description');
    expect(result).toContain('gh pr edit');
  });
});
