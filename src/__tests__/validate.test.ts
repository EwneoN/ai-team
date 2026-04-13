import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSpec } from '../spec-parser.js';
import { validateBatch } from '../commands/validate.js';
import { setProjectDir } from '../config.js';

// ── parseSpec ────────────────────────────────────────────────

describe('parseSpec', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'spec-parser-'));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeSpec(name: string, content: string): string {
    const path = join(tempDir, name);
    writeFileSync(path, content, 'utf-8');
    return path;
  }

  it('extracts target agent from ## Target Agent section', () => {
    const path = writeSpec('agent.md', [
      '# Spec: Backend — Feature X',
      '',
      '## Target Agent',
      '**backend** → Backend Engineer',
    ].join('\n'));

    const result = parseSpec(path);
    expect(result.targetAgent).toBe('backend');
  });

  it('extracts target agent from title fallback', () => {
    const path = writeSpec('title.md', [
      '# Spec: frontend — Dashboard Page',
      '',
      '## Requirements',
      'Build a dashboard.',
    ].join('\n'));

    const result = parseSpec(path);
    expect(result.targetAgent).toBe('frontend');
  });

  it('extracts files from ### Files to Modify bullet list', () => {
    const path = writeSpec('files.md', [
      '# Spec: Backend — Feature',
      '',
      '## Target Agent',
      '**backend** → Backend Engineer',
      '',
      '### Files to Modify',
      '- amplify/functions/resolvers/foo/handler.ts',
      '- amplify/shared/lib/repositories/bar.ts',
      '- `amplify/data/schema.graphql`',
      '',
      '### Files NOT to Modify',
      '- src/app/page.tsx',
      '- amplify/backend.ts',
    ].join('\n'));

    const result = parseSpec(path);
    expect(result.filesToModify).toEqual([
      'amplify/data/schema.graphql',
      'amplify/functions/resolvers/foo/handler.ts',
      'amplify/shared/lib/repositories/bar.ts',
    ]);
    expect(result.filesToExclude).toEqual([
      'amplify/backend.ts',
      'src/app/page.tsx',
    ]);
  });

  it('extracts files from inline **File:** notation', () => {
    const path = writeSpec('inline.md', [
      '# Spec: Backend — Feature',
      '',
      '## Target Agent',
      '**backend** → Backend Engineer',
      '',
      '## Requirements',
      '',
      '### Step 1',
      '**File:** `amplify/functions/resolvers/query/handler.ts`',
      'Add the query handler.',
      '',
      '### Step 2',
      '**File:** amplify/shared/lib/service.ts',
      'Add the service.',
    ].join('\n'));

    const result = parseSpec(path);
    expect(result.filesToModify).toContain('amplify/functions/resolvers/query/handler.ts');
    expect(result.filesToModify).toContain('amplify/shared/lib/service.ts');
  });

  it('warns when no files can be extracted', () => {
    const path = writeSpec('empty.md', [
      '# Spec: Backend — Feature',
      '',
      '## Requirements',
      'Just do the thing.',
    ].join('\n'));

    const result = parseSpec(path);
    expect(result.filesToModify).toEqual([]);
    expect(result.warnings).toContain(
      'Could not extract any "Files to Modify" from spec — boundary check will be skipped for this spec',
    );
  });

  it('warns when spec file does not exist', () => {
    const result = parseSpec('/nonexistent/spec.md');
    expect(result.warnings).toContain('Spec file not found: /nonexistent/spec.md');
  });

  it('handles mixed-format sections', () => {
    const path = writeSpec('mixed.md', [
      '# Spec: infra — Setup',
      '',
      '## Target Agent',
      '**infra** → Infra Engineer',
      '',
      '### Files to Modify',
      '- .github/workflows/ci.yml',
      '* amplify/backend.ts',
      '- `package.json`',
      '',
      '## Other stuff',
      'Unrelated content.',
    ].join('\n'));

    const result = parseSpec(path);
    expect(result.targetAgent).toBe('infra');
    expect(result.filesToModify).toContain('.github/workflows/ci.yml');
    expect(result.filesToModify).toContain('amplify/backend.ts');
    expect(result.filesToModify).toContain('package.json');
  });
});

// ── validateBatch ────────────────────────────────────────────

describe('validateBatch', () => {
  let tempDir: string;
  let projectDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'validate-batch-'));
    projectDir = join(tempDir, '.ai-team');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(projectDir, 'batches'), { recursive: true });
    mkdirSync(join(tempDir, 'docs', 'specs'), { recursive: true });

    // Write config.json
    const config = {
      project: { name: 'test', repoUrl: 'https://github.com/test/repo', mainBranch: 'main' },
      agents: {
        backend: {
          displayName: 'Backend',
          agentId: 'backend-001',
          workingDir: join(tempDir, 'ws-backend'),
          briefPath: 'docs/backend.md',
          globalRulesPath: '.github/copilot-instructions.md',
          chatmodeFile: '.github/agents/backend.md',
          ownedPaths: ['amplify/functions/**', 'amplify/data/**', 'amplify/shared/**'],
          branchPrefix: 'backend',
        },
        frontend: {
          displayName: 'Frontend',
          agentId: 'frontend-001',
          workingDir: join(tempDir, 'ws-frontend'),
          briefPath: 'docs/frontend.md',
          globalRulesPath: '.github/copilot-instructions.md',
          chatmodeFile: '.github/agents/frontend.md',
          ownedPaths: ['src/**', 'next.config.ts'],
          branchPrefix: 'frontend',
        },
      },
      models: { architect: 'claude-sonnet-4-6', coAgent: 'claude-sonnet-4-6', fallback: 'claude-sonnet-4-6' },
      settings: {
        maxReviewCycles: 5,
        monitorPollIntervalSeconds: 30,
        maxRetries: 3,
        retryBaseDelaySeconds: 10,
        launchStaggerSeconds: 5,
        maxBudgetUsd: 10,
        reviewMode: 'none',
        copilotReviewPollIntervalSeconds: 30,
        copilotReviewTimeoutMinutes: 10,
        notifications: { enabled: false },
      },
    };
    writeFileSync(join(projectDir, 'config.json'), JSON.stringify(config, null, 2));

    setProjectDir(projectDir);
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeBatch(name: string, batch: object): string {
    const path = join(projectDir, 'batches', `${name}.json`);
    writeFileSync(path, JSON.stringify(batch, null, 2));
    return path;
  }

  function writeSpec(name: string, content: string): void {
    writeFileSync(join(tempDir, 'docs', 'specs', `${name}.md`), content);
  }

  it('passes a valid batch with correct boundaries', () => {
    writeSpec('backend-ok', [
      '# Spec: Backend — OK',
      '## Target Agent',
      '**backend** → Backend Engineer',
      '### Files to Modify',
      '- amplify/functions/resolvers/foo/handler.ts',
      '- amplify/data/schema.graphql',
    ].join('\n'));

    const batchFile = writeBatch('valid', {
      name: 'valid-test',
      description: 'test batch',
      assignments: [{
        agent: 'backend',
        spec: 'backend-ok',
        specPath: 'docs/specs/backend-ok.md',
        description: 'test',
        round: 1,
      }],
    });

    const result = validateBatch({ batchFile });
    expect(result.errors).toEqual([]);
  });

  it('detects boundary violations', () => {
    writeSpec('backend-bad', [
      '# Spec: Backend — Bad',
      '## Target Agent',
      '**backend** → Backend Engineer',
      '### Files to Modify',
      '- amplify/functions/resolvers/foo/handler.ts',
      '- src/app/page.tsx',
      '- .github/workflows/ci.yml',
    ].join('\n'));

    const batchFile = writeBatch('violations', {
      name: 'violation-test',
      description: 'test batch',
      assignments: [{
        agent: 'backend',
        spec: 'backend-bad',
        specPath: 'docs/specs/backend-bad.md',
        description: 'test',
        round: 1,
      }],
    });

    const result = validateBatch({ batchFile });
    expect(result.errors.length).toBeGreaterThan(0);
    const errorText = result.errors.join('\n');
    expect(errorText).toContain('src/app/page.tsx');
    expect(errorText).toContain('.github/workflows/ci.yml');
  });

  it('detects workspace collisions', () => {
    writeSpec('be-one', '# Spec: Backend — One\n## Target Agent\n**backend**\n');
    writeSpec('be-two', '# Spec: Backend — Two\n## Target Agent\n**backend**\n');

    const batchFile = writeBatch('collision', {
      name: 'collision-test',
      description: 'test batch',
      assignments: [
        { agent: 'backend', spec: 'be-one', specPath: 'docs/specs/be-one.md', description: 'one', round: 1 },
        { agent: 'backend', spec: 'be-two', specPath: 'docs/specs/be-two.md', description: 'two', round: 1 },
      ],
    });

    const result = validateBatch({ batchFile });
    const errorText = result.errors.join('\n');
    expect(errorText).toContain('collision');
  });

  it('detects missing spec files', () => {
    const batchFile = writeBatch('missing-spec', {
      name: 'missing-spec-test',
      description: 'test batch',
      assignments: [{
        agent: 'backend',
        spec: 'nonexistent',
        specPath: 'docs/specs/does-not-exist.md',
        description: 'test',
        round: 1,
      }],
    });

    const result = validateBatch({ batchFile });
    const errorText = result.errors.join('\n');
    expect(errorText).toContain('spec file not found');
  });

  it('detects unknown agent key', () => {
    const batchFile = writeBatch('bad-agent', {
      name: 'bad-agent-test',
      description: 'test batch',
      assignments: [{
        agent: 'unicorn',
        spec: 'unicorn-spec',
        specPath: 'docs/specs/backend-ok.md',
        description: 'test',
        round: 1,
      }],
    });

    const result = validateBatch({ batchFile });
    const errorText = result.errors.join('\n');
    expect(errorText).toContain('unknown agent');
    expect(errorText).toContain('unicorn');
  });

  it('detects cross-file conflicts', () => {
    writeSpec('be-schema', [
      '# Spec: Backend — Schema',
      '## Target Agent',
      '**backend** → Backend Engineer',
      '### Files to Modify',
      '- amplify/data/schema.graphql',
    ].join('\n'));

    writeSpec('be-schema2', [
      '# Spec: Backend — Schema2',
      '## Target Agent',
      '**backend** → Backend Engineer',
      '### Files to Modify',
      '- amplify/data/schema.graphql',
    ].join('\n'));

    const batchFile = writeBatch('cross-file', {
      name: 'cross-file-test',
      description: 'test batch',
      assignments: [
        { agent: 'backend', spec: 'be-schema', specPath: 'docs/specs/be-schema.md', description: 'schema', round: 1 },
        { agent: 'backend', spec: 'be-schema2', specPath: 'docs/specs/be-schema2.md', description: 'schema2', round: 2 },
      ],
    });

    const result = validateBatch({ batchFile });
    const warnText = result.warnings.join('\n');
    expect(warnText).toContain('amplify/data/schema.graphql');
    expect(warnText).toContain('merge conflict');
  });

  it('warns on agent mismatch between spec and batch', () => {
    writeSpec('fe-mismatch', [
      '# Spec: Frontend — Mismatch',
      '## Target Agent',
      '**frontend** → Frontend Engineer',
      '### Files to Modify',
      '- src/app/page.tsx',
    ].join('\n'));

    const batchFile = writeBatch('mismatch', {
      name: 'mismatch-test',
      description: 'test batch',
      assignments: [{
        agent: 'backend',
        spec: 'fe-mismatch',
        specPath: 'docs/specs/fe-mismatch.md',
        description: 'test',
        round: 1,
      }],
    });

    const result = validateBatch({ batchFile });
    const warnText = result.warnings.join('\n');
    expect(warnText).toContain('frontend');
    expect(warnText).toContain('backend');
  });
});
