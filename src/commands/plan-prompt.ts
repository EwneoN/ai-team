/**
 * Plan prompt builder — assembles the PLANNER.md template and launch prompt
 * for the planning agent.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getTemplatesDir } from '../config.js';
import { readUtf8 } from '../helpers.js';
import type { OrchestratorConfig } from '../types.js';

/**
 * Render the PLANNER.md template with config-derived values.
 */
export function renderPlannerMd(opts: {
  config: OrchestratorConfig;
  intent: string;
  outputDir: string;
  batchName: string;
}): string {
  const { config, intent, outputDir, batchName } = opts;

  const templatePath = join(getTemplatesDir(), 'PLANNER.md.template');
  if (!existsSync(templatePath)) {
    throw new Error(`PLANNER.md template not found at ${templatePath}`);
  }
  const template = readUtf8(templatePath);

  const boundariesBlock = buildAgentBoundariesBlock(config);

  return template
    .replace(/\{PROJECT_NAME\}/g, () => config.project.name)
    .replace(/\{INTENT\}/g, () => intent)
    .replace(/\{OUTPUT_DIR\}/g, () => outputDir)
    .replace(/\{BATCH_NAME\}/g, () => batchName)
    .replace('{AGENT_BOUNDARIES_BLOCK}', () => boundariesBlock);
}

/**
 * Build the agent boundaries block from config for embedding in planner templates.
 */
export function buildAgentBoundariesBlock(config: OrchestratorConfig): string {
  const sections: string[] = [];

  for (const [key, agent] of Object.entries(config.agents)) {
    const paths = agent.ownedPaths.map((p) => `  - \`${p}\``).join('\n');
    sections.push(
      `### ${key} — ${agent.displayName}\n` +
      `- Branch prefix: \`${agent.branchPrefix}\`\n` +
      `- Owned paths:\n${paths}`,
    );
  }

  return sections.join('\n\n');
}

/**
 * Build the launch prompt for the planning agent.
 */
export function buildPlannerPrompt(intent: string): string {
  return [
    'Plan and generate specs for the following work:',
    '',
    `"${intent}"`,
    '',
    'Read your CLAUDE.md for full instructions on how to generate specs and the batch file.',
    'Start by exploring the codebase to understand existing patterns before generating anything.',
  ].join('\n');
}

/**
 * Slugify an intent string for use as a batch name.
 * "add billing with Stripe" → "add-billing-with-stripe"
 *
 * Truncates at word boundaries to avoid mid-word cuts like "the-".
 */
export function slugify(text: string, maxLen = 50): string {
  const full = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  if (full.length <= maxLen) return full;

  // Truncate at the last hyphen before maxLen to avoid mid-word cuts
  const truncated = full.slice(0, maxLen);
  const lastHyphen = truncated.lastIndexOf('-');
  return lastHyphen > 0 ? truncated.slice(0, lastHyphen) : truncated;
}
