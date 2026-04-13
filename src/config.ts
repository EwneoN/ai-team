/**
 * Configuration loading — reads config.json and batch files.
 * Supports standalone CLI usage via --project-dir or AI_TEAM_PROJECT_DIR env var.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OrchestratorConfig, BatchConfig, AgentConfig, BatchAssignment } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Project dir (set via CLI --project-dir or env var) ───────

let _projectDir: string | null = null;

/**
 * Initialize the project directory. Must be called before any path functions.
 * Resolves relative paths against cwd.
 */
export function setProjectDir(dir: string): void {
  _projectDir = resolve(dir);
}

/**
 * The project's .ai-team/ directory (holds config, batches, signals, logs).
 * Falls back to legacy ai-team/ layout if setProjectDir() was not called
 * (for backward compatibility during migration).
 */
export function getProjectDir(): string {
  if (_projectDir) return _projectDir;
  // Legacy fallback: resolve relative to CLI source (ai-team/cli/src -> ai-team/)
  return resolve(__dirname, '..', '..');
}

/** Root of the project workspace (parent of the project dir) */
export function getProjectRoot(): string {
  return resolve(getProjectDir(), '..');
}

export function getSignalsDir(): string {
  return join(getProjectDir(), 'signals');
}

export function getLogsDir(): string {
  return join(getProjectDir(), 'logs');
}

export function getBatchesDir(): string {
  return join(getProjectDir(), 'batches');
}

/** Templates ship with the CLI package, not the project */
export function getTemplatesDir(): string {
  // Resolve relative to this file: src/config.ts or dist/config.js → parent → templates/
  return join(__dirname, '..', 'templates');
}

/**
 * Load the orchestrator config from {projectDir}/config.json.
 * Derives workingDir for agents that don't specify one explicitly,
 * using settings.workingDirBase (default: '../') + '{projectName}-{agentKey}'.
 */
export function loadConfig(): OrchestratorConfig {
  const configPath = join(getProjectDir(), 'config.json');
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found at ${configPath}. Copy config.json.example and edit it.`);
  }
  const raw = readFileSync(configPath, 'utf-8').replace(/^\uFEFF/, '');
  const config = JSON.parse(raw) as OrchestratorConfig;

  // Derive workingDir for agents that don't have one set
  const projectRoot = getProjectRoot();
  const basePath = config.settings.workingDirBase ?? '../';
  const resolvedBase = resolve(projectRoot, basePath);

  for (const [key, agent] of Object.entries(config.agents)) {
    if (!agent.workingDir) {
      agent.workingDir = join(resolvedBase, `${config.project.name}-${key}`);
    }
  }

  validateConfig(config);

  return config;
}

/**
 * Validate an orchestrator config. Throws with a list of all errors found.
 */
export function validateConfig(config: OrchestratorConfig): void {
  const errors: string[] = [];

  // project
  if (!config.project) {
    errors.push('Missing "project" section');
  } else {
    if (!config.project.name) errors.push('Missing "project.name"');
    if (!config.project.repoUrl) errors.push('Missing "project.repoUrl"');
    if (!config.project.mainBranch) errors.push('Missing "project.mainBranch"');
  }

  // agents
  if (!config.agents || Object.keys(config.agents).length === 0) {
    errors.push('Missing or empty "agents" section — at least one agent is required');
  } else {
    const requiredAgentFields = ['displayName', 'agentId', 'briefPath', 'globalRulesPath', 'chatmodeFile', 'branchPrefix'] as const;
    for (const [key, agent] of Object.entries(config.agents)) {
      for (const field of requiredAgentFields) {
        if (!agent[field]) errors.push(`agents.${key}: missing "${field}"`);
      }
      if (!agent.ownedPaths || !Array.isArray(agent.ownedPaths) || agent.ownedPaths.length === 0) {
        errors.push(`agents.${key}: missing or empty "ownedPaths" array`);
      }
    }
  }

  // models
  if (!config.models) {
    errors.push('Missing "models" section');
  } else {
    if (!config.models.architect) errors.push('Missing "models.architect"');
    if (!config.models.coAgent) errors.push('Missing "models.coAgent"');
  }

  // settings
  if (!config.settings) {
    errors.push('Missing "settings" section');
  } else {
    if (typeof config.settings.maxReviewCycles !== 'number') errors.push('Missing or invalid "settings.maxReviewCycles" (must be a number)');
  }

  if (errors.length > 0) {
    throw new Error(`Config validation failed:\n  - ${errors.join('\n  - ')}`);
  }
}

/**
 * Load a batch config file. Accepts an absolute path or a filename
 * (resolved relative to ai-team/batches/).
 */
export function loadBatch(batchFile: string): BatchConfig {
  let resolved = batchFile;
  if (!resolve(batchFile).startsWith('/') && !resolve(batchFile).includes(':\\')) {
    // Could be relative — resolve against batches dir
    resolved = resolve(getBatchesDir(), batchFile);
  }
  // Also try just resolving it as-is (handles both absolute and relative from cwd)
  if (!existsSync(resolved)) {
    resolved = resolve(batchFile);
  }
  if (!existsSync(resolved)) {
    // Try batches dir as last resort
    resolved = resolve(getBatchesDir(), batchFile);
  }
  if (!existsSync(resolved)) {
    throw new Error(`Batch file not found: ${batchFile} (tried ${resolved})`);
  }
  const raw = readFileSync(resolved, 'utf-8').replace(/^\uFEFF/, '');
  return JSON.parse(raw) as BatchConfig;
}

/**
 * Get a specific agent's config, with validation.
 */
export function getAgentConfig(config: OrchestratorConfig, agentKey: string): AgentConfig {
  const agent = config.agents[agentKey];
  if (!agent) {
    const valid = Object.keys(config.agents).join(', ');
    throw new Error(`Unknown agent key: ${agentKey}. Valid keys: ${valid}`);
  }
  return agent;
}

/**
 * Get the max review cycles for a specific agent.
 * Uses the agent-level override if set, otherwise falls back to the global setting.
 */
export function getMaxReviewCycles(config: OrchestratorConfig, agentKey: string): number {
  return config.agents[agentKey]?.maxReviewCycles ?? config.settings.maxReviewCycles;
}

/**
 * Resolve the model for an agent, with priority:
 *   1. Batch assignment override (assignment.model)
 *   2. Agent config override (config.agents[agentKey].model)
 *   3. Global default (config.models.architect for 'architect', config.models.coAgent otherwise)
 */
export function resolveModel(config: OrchestratorConfig, agentKey: string, assignment?: BatchAssignment): string {
  if (assignment?.model) return assignment.model;
  if (config.agents[agentKey]?.model) return config.agents[agentKey].model!;
  return agentKey === 'architect' ? config.models.architect : config.models.coAgent;
}
