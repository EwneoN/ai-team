/**
 * CLAUDE.md template rendering and prompt generation.
 * Equivalent to the template logic in launch-agents.ps1
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getTemplatesDir } from './config.js';
import { readUtf8, stripYamlFrontmatter, execFileSafe } from './helpers.js';
import { buildAgentBoundariesBlock } from './commands/plan-prompt.js';
import type { AgentConfig, BatchAssignment, BatchConfig, OrchestratorConfig, OrchState } from './types.js';

/**
 * Load the CLAUDE.md template from ai-team/templates/.
 */
export function loadTemplate(): string {
  const templatePath = join(getTemplatesDir(), 'CLAUDE.md.template');
  if (!existsSync(templatePath)) {
    throw new Error(`CLAUDE.md template not found at ${templatePath}`);
  }
  return readUtf8(templatePath);
}

/**
 * Load the slim review-cycle CLAUDE.md template.
 * Falls back to the full template if the review template doesn't exist.
 */
export function loadReviewTemplate(): string {
  const templatePath = join(getTemplatesDir(), 'CLAUDE.md.review.template');
  if (!existsSync(templatePath)) {
    console.warn('Review template not found, falling back to full template');
    return loadTemplate();
  }
  return readUtf8(templatePath);
}

/**
 * Read a file from an agent's working directory, with fallback message.
 */
function readAgentFile(agentDir: string, relativePath: string, description: string): string {
  const fullPath = join(agentDir, relativePath);
  if (existsSync(fullPath)) {
    return readUtf8(fullPath);
  }
  console.warn(`    ⚠ ${description} not found: ${fullPath}`);
  return `<!-- ${description} not found at ${relativePath} -->`;
}

interface RenderClaudeMdOptions {
  template: string;
  agentKey: string;
  agentConfig: AgentConfig;
  assignment: BatchAssignment;
  batchName: string;
  signalFilePath: string;
  maxReviewCycles: number;
  projectName: string;
  /** Path (relative to project root) to a project-specific rules file.
   *  Loaded from the agent's working directory. Omit to skip. */
  projectRulesFile?: string;
  /** Cumulative context from previous rounds. Empty string for round 1. */
  previousRoundContext?: string;
}

/**
 * Render a CLAUDE.md from the template with all placeholders replaced.
 */
export function renderClaudeMd(opts: RenderClaudeMdOptions): string {
  const { template, agentKey, agentConfig, assignment, batchName, signalFilePath, maxReviewCycles, projectName, projectRulesFile } = opts;
  const agentDir = agentConfig.workingDir;
  const subBranch = `batch/${batchName}--${agentConfig.branchPrefix}--${assignment.spec}`;
  const batchBranch = `batch/${batchName}`;

  // Read content files (spec is NOT embedded — agents read it from disk to save tokens)
  const chatmodeRaw = readAgentFile(agentDir, agentConfig.chatmodeFile, 'Chatmode file');
  const chatmodeContent = stripYamlFrontmatter(chatmodeRaw);
  const globalRulesContent = readAgentFile(agentDir, agentConfig.globalRulesPath, 'Global rules');

  // Load project-specific rules if configured
  let projectRulesContent = '';
  if (projectRulesFile) {
    const rulesPath = join(agentDir, projectRulesFile);
    if (existsSync(rulesPath)) {
      projectRulesContent = `---\n\n## Project-Specific Rules\n\n${readUtf8(rulesPath)}`;
    } else {
      console.warn(`    ⚠ Project rules file not found: ${rulesPath}`);
    }
  }

  const ownedPathsList = agentConfig.ownedPaths.map((p) => `- \`${p}\``).join('\n');

  // Replace simple placeholders with regex
  let result = template
    .replace(/\{AGENT_DISPLAY_NAME\}/g, agentConfig.displayName)
    .replace(/\{AGENT_ID\}/g, agentConfig.agentId)
    .replace(/\{AGENT_KEY\}/g, agentKey)
    .replace(/\{BRIEF_PATH\}/g, agentConfig.briefPath)
    .replace(/\{OWNED_PATHS_LIST\}/g, ownedPathsList)
    .replace(/\{BRANCH_NAME\}/g, subBranch)
    .replace(/\{BATCH_BRANCH\}/g, batchBranch)
    .replace(/\{SPEC_PATH\}/g, assignment.specPath)
    .replace(/\{SPEC_NAME\}/g, assignment.spec)
    .replace(/\{SPEC_DESCRIPTION\}/g, assignment.description)
    .replace(/\{SIGNAL_FILE_PATH\}/g, signalFilePath.replace(/\\/g, '/'))
    .replace(/\{MAX_REVIEW_CYCLES\}/g, String(maxReviewCycles))
    .replace(/\{SIGNAL_ID\}/g, randomUUID())
    .replace(/\{PROJECT_NAME\}/g, projectName);

  // Inject content blocks (use string replace to avoid regex issues with content)
  result = result.replace('{CHATMODE_CONTENT}', chatmodeContent);
  result = result.replace('{GLOBAL_RULES_CONTENT}', globalRulesContent);
  result = result.replace('{PROJECT_RULES}', projectRulesContent);
  result = result.replace('{PREVIOUS_ROUND_CONTEXT}', opts.previousRoundContext ?? '');

  return result;
}

/**
 * Render a slim review-cycle CLAUDE.md with no "Your Task" or architecture doc references.
 * Reduces token usage on review cycles where the agent only needs to address feedback.
 */
export function renderReviewClaudeMd(opts: Omit<RenderClaudeMdOptions, 'template'>): string {
  const template = loadReviewTemplate();
  const { agentKey, agentConfig, assignment, batchName, maxReviewCycles, projectName, projectRulesFile } = opts;
  const agentDir = agentConfig.workingDir;
  const subBranch = `batch/${batchName}--${agentConfig.branchPrefix}--${assignment.spec}`;
  const batchBranch = `batch/${batchName}`;

  const chatmodeRaw = readAgentFile(agentDir, agentConfig.chatmodeFile, 'Chatmode file');
  const chatmodeContent = stripYamlFrontmatter(chatmodeRaw);
  const globalRulesContent = readAgentFile(agentDir, agentConfig.globalRulesPath, 'Global rules');
  const ownedPathsList = agentConfig.ownedPaths.map((p) => `- \`${p}\``).join('\n');

  // Load project-specific rules if configured
  let projectRulesContent = '';
  if (projectRulesFile) {
    const rulesPath = join(agentDir, projectRulesFile);
    if (existsSync(rulesPath)) {
      projectRulesContent = `---\n\n## Project-Specific Rules\n\n${readUtf8(rulesPath)}`;
    } else {
      console.warn(`    ⚠ Project rules file not found: ${rulesPath}`);
    }
  }

  let result = template
    .replace(/\{AGENT_DISPLAY_NAME\}/g, agentConfig.displayName)
    .replace(/\{AGENT_ID\}/g, agentConfig.agentId)
    .replace(/\{AGENT_KEY\}/g, agentKey)
    .replace(/\{OWNED_PATHS_LIST\}/g, ownedPathsList)
    .replace(/\{BRANCH_NAME\}/g, subBranch)
    .replace(/\{BATCH_BRANCH\}/g, batchBranch)
    .replace(/\{MAX_REVIEW_CYCLES\}/g, String(maxReviewCycles))
    .replace(/\{PROJECT_NAME\}/g, projectName);

  result = result.replace('{CHATMODE_CONTENT}', chatmodeContent);
  result = result.replace('{GLOBAL_RULES_CONTENT}', globalRulesContent);
  result = result.replace('{PROJECT_RULES}', projectRulesContent);
  result = result.replace('{PREVIOUS_ROUND_CONTEXT}', opts.previousRoundContext ?? '');

  return result;
}

/**
 * Generate the initial launch prompt for an agent.
 */
export function generateLaunchPrompt(
  agentConfig: AgentConfig,
  assignment: BatchAssignment,
  batchBranch: string,
  projectName: string,
): string {
  return `You are the ${agentConfig.displayName} for the ${projectName} project.

Your CLAUDE.md file contains your identity, spec, rules, and completion protocol. It is loaded automatically as your system context.

You MUST read your brief from disk first: ${agentConfig.briefPath}
Then read your spec from disk: ${assignment.specPath}

CRITICAL: If ${assignment.specPath} does not exist or is empty, STOP IMMEDIATELY. Write a failed signal and do not proceed. Never improvise without a spec.

YOUR TASK:
Implement the spec: "${assignment.description}"

WORKFLOW:
1. Read your brief at ${agentConfig.briefPath} -- understand your role, coding standards, and gotchas
2. Read and review the spec at ${assignment.specPath} -- understand task requirements and acceptance criteria
3. Read any architecture or context docs referenced in your CLAUDE.md or brief
4. Implement the changes (only modify files within your owned paths)
5. Self-review: run typecheck, check acceptance criteria, verify no boundary violations
6. Commit with conventional commit format and Agent trailer
7. Push the branch and create a PR targeting ${batchBranch}
8. Write the completion signal file as described in CLAUDE.md

Begin now. Start by reading your brief.
`;
}

/**
 * Generate the review/fix prompt for an agent.
 */
export function generateReviewPrompt(opts: {
  agentConfig: AgentConfig;
  assignment: BatchAssignment;
  agentKey: string;
  specName: string;
  subBranch: string;
  signalFile: string;
  cycle: number;
  maxCycles: number;
  feedbackText: string;
  projectName: string;
  prUrl?: string;
}): string {
  const { agentConfig, assignment, agentKey, specName, subBranch, signalFile, cycle, maxCycles, feedbackText, projectName, prUrl } = opts;

  return `You are the ${agentConfig.displayName} for the ${projectName} project.
You previously implemented the spec "${assignment.description}" and created a PR.
The Architect has reviewed your work and found issues that need fixing.

## CRITICAL: THIS IS A REVIEW FIX TASK — NOT THE ORIGINAL SPEC

Your CLAUDE.md file contains a "Your Task" section that says to implement the original spec.
IGNORE THAT SECTION. The original spec is ALREADY IMPLEMENTED and the PR is open.
Your ONLY task right now is to fix the issues listed in the REVIEW FEEDBACK below.

You may read CLAUDE.md for your identity, file ownership rules, and commit conventions ONLY.
Do NOT re-read the spec. Do NOT re-implement anything. Do NOT report existing work as done.
Do NOT read your brief file -- you already know your role from previous work. Focus ONLY on the feedback.

## REVIEW FEEDBACK (from the Architect -- review cycle ${cycle} of ${maxCycles}):

${feedbackText}

## YOUR TASK (this overrides CLAUDE.md "Your Task" section):

1. Read the review feedback above -- understand every issue raised
2. Open the specific files mentioned in the feedback
3. Address every numbered comment. For each one, choose ONE of:
   a. Fix the code as described, OR
   b. If the comment is a style nit or subjective preference you disagree with, use "wont-fix" in comment-outcomes.json with a clear reason. Do not waste cycles on changes that don't improve correctness or readability, OR
   c. If the comment asks you to modify a file outside your boundary, use "skipped" with reason "file outside boundary"
4. **Sibling audit** -- When fixing a bug in one handler or component method, audit ALL other handlers/methods in the same file for the same class of bug. Example: if a click handler has a race condition, check every other click handler and stepper callback in the same component. Fix them all in one commit — do not wait for the reviewer to flag siblings individually.
5. **Full-matrix sweep** -- When fixing an edge case (ARIA state, empty/loading/error, boundary value), enumerate ALL state combinations for that component and verify your fix covers them all. Do not fix only the reported case while leaving identical gaps in adjacent states.
6. **Comment consistency** -- When you change code behavior, update or remove nearby code comments that describe the old behavior. Stale comments that contradict the code are a common source of review feedback.
7. Self-review: run typecheck (npx tsc --noEmit) and tests
8. Commit with conventional format -- include a per-comment summary:
   fix: address review feedback (cycle ${cycle})

   Comment 1: <what you did>
   Comment 2: <what you did>
   ... (one line per comment)

   Agent: ${agentConfig.agentId}
9. Push: git push origin ${subBranch}
10. **Update PR description if needed**: If your fixes changed the implementation approach, added/removed files,
   or altered the public API surface, update the PR description to reflect the current state:
   \`gh pr edit --body "..."\` (keep the same section structure — update the Changes and Notes sections).
   Only update if the changes are material — minor fixes don't need a description update.
11. If any review comments include a \`[comment-id:NNNN]\` tag, write a comment outcomes file at:
   ${signalFile.replace(/\\/g, '/').replace(/\.json$/, '.comment-outcomes.json')}

   Write this JSON:
   {
     "outcomes": [
       { "commentId": NNNN, "status": "fixed" },
       { "commentId": MMMM, "status": "skipped", "reason": "Out of scope — tracked in issue #47" },
       { "commentId": PPPP, "status": "wont-fix", "reason": "Already handled by existing validation" }
     ]
   }

   For each comment with a \`[comment-id:NNNN]\` tag:
   - "fixed" = you addressed the comment with a code change
   - "skipped" = you intentionally skipped it (provide reason)
   - "wont-fix" = the comment is incorrect or not applicable (provide reason)

   **IMPORTANT: Write this file BEFORE the completion signal in step 12.**

12. **CRITICAL** — **OVERWRITE** the completion signal file at this EXACT ABSOLUTE path using the **Write** tool (NOT Edit — you must replace the entire file):
   ${signalFile.replace(/\\/g, '/')}

   Write this EXACT JSON (fill in only the timestamp). Do NOT read the existing file — use these values directly:
   {
     "agent": "${agentKey}",
     "spec": "${specName}",
     "status": "completed",
     "branch": "${subBranch}",
     "prUrl": "${prUrl ?? '<paste your PR URL>'}",
     "timestamp": "<current ISO 8601 timestamp>",
     "reviewCycle": ${cycle},
     "signalId": "${randomUUID()}",
     "notes": "Addressed review feedback cycle ${cycle}"
   }

   **IMPORTANT: You MUST use the Write tool to overwrite the entire file. Do NOT use Edit/Read on this file. The signalId and reviewCycle above are mandatory — if they are missing or wrong, the orchestrator will not detect your work.**

   **This MUST be the last file you write.** The orchestrator detects this signal to begin processing — if it fires before outcomes are written, outcomes will be missed.

## FILE OWNERSHIP BOUNDARIES (HARD ENFORCED)

You may ONLY modify files matching these paths:
${agentConfig.ownedPaths.map(p => '- `' + p + '`').join('\n')}

**Any file outside these globs will be automatically reverted and you will lose a review cycle.**
If the reviewer asks you to modify a file outside your boundary, IGNORE that comment and note in your commit message: "Skipped comment N — file outside boundary."

## RULES:
- Do NOT create a new PR -- your existing PR will auto-update when you push
- Only modify files within your owned paths (see boundaries above)
- Do NOT just describe existing work -- you must EDIT FILES and COMMIT
- If you cannot fix something, explain why in the signal notes field
- Be thorough -- the Architect will review again

Begin now. Open the first file mentioned in the feedback and start editing.
`;
}

/**
 * Generate the architect review prompt.
 */
export function generateArchitectReviewPrompt(opts: {
  agentKey: string;
  specName: string;
  description: string;
  prNumber: number;
  reviewCycle: number;
  maxCycles: number;
  specContent: string;
  prBody: string;
  diff: string;
  projectName: string;
  architectReviewHints?: string;
}): string {
  const { agentKey, description, prNumber, reviewCycle, maxCycles, specContent, prBody, diff, projectName, architectReviewHints } = opts;

  const consistencyLine = architectReviewHints
    ? `5. Check consistency with ${projectName} architecture (${architectReviewHints})`
    : '5. Check consistency with project architecture and conventions';

  return `You are the Lead Architect for the ${projectName} project, reviewing a co-agent's PR.

## Context
- Agent: ${agentKey}
- Spec: "${description}"
- PR: #${prNumber}
- Review cycle: ${reviewCycle} (max ${maxCycles})

## The Spec (acceptance criteria are here)
${specContent}

## PR Information
${prBody}

## PR Diff
\`\`\`diff
${diff}
\`\`\`

## Review Instructions

1. Check every acceptance criterion in the spec — is it met by the diff?
2. Check code quality: TypeScript best practices, error handling, no debug artifacts
3. Check for boundary violations: files outside the agent's owned paths
4. Check for security: no PII in logs, proper auth checks
${consistencyLine}
6. Check for these common defect patterns:
   - **Idempotency**: Functions called in retry/polling loops must produce the same result on repeat calls. Look for state mutations before fallible operations, or missing guards against duplicate transitions.
   - **Pagination**: Any GitHub API list endpoint (comments, reviews, checks) must paginate. Look for missing \`--paginate\` flags or unpaginated REST calls that silently truncate at 30 items.
   - **Error handling gaps**: State recorded as successful before the operation completes (e.g., setting a cache/ID before the API call confirms success).
   - **Stale docstrings**: Comments that describe behaviour from an earlier iteration but no longer match the code.
   - **Dead code**: Unused functions, interfaces, or imports left behind after refactoring.
   - **Docs/code drift**: README, templates, and inline comments must all describe the same behaviour. Check that feature flags, status values, emoji meanings, and config options are consistent across all locations.
   - **Sibling consistency**: When one handler is fixed (race condition, error handling, ARIA), verify all sibling handlers in the same component are fixed too. Flag if only one instance was corrected while others have the same vulnerability.
   - **Edge-case coverage**: When edge cases are handled for one state combination, verify all combinations are covered. Flag partial matrices (e.g., handles \`spent > budget\` but not \`budget === 0\`).
   - **Optimistic response snapshots**: If a mutation handler builds its response by spreading old state with new values (\`{ ...oldItem, field: newValue }\`) instead of using \`ReturnValues: 'ALL_NEW'\` or re-reading from the database, flag it as major — optimistic responses hide concurrent writes from other users.
   - **Duplicated logic across files**: If the same 5+ line code block (auth check, phase guard, error handling) appears in multiple files in the diff, flag it as minor with a suggestion to extract a shared utility. Copy-paste across handlers is a maintenance hazard.
   - **Untyped data store access**: If DynamoDB items are accessed via \`item['fieldName'] as Type\` casts instead of through a typed interface, flag it as major — field renames or type changes won't be caught at compile time.

## CRITICAL: Output Format

After your analysis, you MUST output EXACTLY ONE JSON block as the LAST thing in your response.
Fence it with triple backticks and the json language tag. Nothing may follow it.

\`\`\`json
{
  "verdict": "APPROVE",
  "summary": "One-paragraph summary of your review",
  "issues": []
}
\`\`\`

OR if changes are needed:

\`\`\`json
{
  "verdict": "CHANGES_REQUESTED",
  "summary": "One-paragraph summary of problems found",
  "issues": [
    {
      "severity": "critical",
      "file": "path/to/file.ts",
      "description": "What needs to change and why"
    }
  ]
}
\`\`\`

Severity levels:
- **critical**: Breaks functionality, security issue, or violates architecture. Must fix.
- **major**: Significant quality issue or missed acceptance criterion. Must fix.
- **minor**: Style nit, minor improvement. Can ship as-is.

Rules:
- Use "APPROVE" if the PR meets all acceptance criteria, even if there are minor nits.
- Use "CHANGES_REQUESTED" only for critical or major issues.
- Be specific in issue descriptions — the co-agent needs actionable feedback.
- Reference specific files and line ranges where possible.
`;
}

/**
 * Generate the review/fix prompt for the batch PR.
 * Unlike co-agent review prompts, this targets the main project workspace
 * and pushes directly to the batch branch (no sub-branch or signal file).
 */
export function generateBatchReviewPrompt(opts: {
  batchName: string;
  batchBranch: string;
  prNumber: number;
  prUrl: string;
  cycle: number;
  maxCycles: number;
  feedbackText: string;
  projectName: string;
}): string {
  const { batchName, batchBranch, prNumber, prUrl, cycle, maxCycles, feedbackText, projectName } = opts;

  return `You are reviewing and fixing feedback on a batch pull request for the ${projectName} project.

Batch: ${batchName}
Branch: ${batchBranch}
PR: #${prNumber} (${prUrl})
Review cycle: ${cycle} of ${maxCycles}

Copilot left the following review comments. Address each one:

${feedbackText}

## YOUR TASK:

1. Read the review feedback above — understand every issue raised
2. Open the specific files mentioned in the feedback
3. Address EVERY comment — do not skip any
4. For each comment, either:
   a. Fix the code as described, OR
   b. If the comment is a style nit you disagree with, leave it and note why in your commit message
5. Self-review: run \`npx tsc --noEmit\` and \`npm test\` before committing
6. Commit with conventional format:
   fix: address batch PR review feedback (cycle ${cycle})

   Comment 1: <what you did>
   Comment 2: <what you did>
   ... (one line per comment)
7. Push: git push origin ${batchBranch}

## RULES:
- You are working directly on the batch branch
- Do NOT create a new PR — push to the existing branch
- Be thorough — Copilot will review again after your fixes
- If you cannot fix something, explain why in your commit message

Begin now. Open the first file mentioned in the feedback and start editing.
`;
}

export function generateValidationFixPrompt(opts: {
  batchName: string;
  batchBranch: string;
  step: string;
  cycle: number;
  maxCycles: number;
  failureOutput: string;
  projectName: string;
}): string {
  const { batchName, batchBranch, step, cycle, maxCycles, failureOutput, projectName } = opts;

  return `You are fixing a local validation failure on a batch branch for the ${projectName} project.

Batch: ${batchName}
Branch: ${batchBranch}
Failed step: ${step}
Fix attempt: ${cycle} of ${maxCycles}

The \`${step}\` step failed with the following output:

\`\`\`
${failureOutput}
\`\`\`

## YOUR TASK:

1. Read the failure output above — understand every error
2. Open the files mentioned in the errors
3. Fix EVERY error — do not leave any unresolved
4. Self-validate: run \`npm run ${step}\` to confirm your fixes work
5. If \`${step}\` is "lint", also run \`npx tsc --noEmit\` to ensure no type errors
6. Commit with conventional format:
   fix: resolve ${step} failures on batch branch (attempt ${cycle})

   Error 1: <what you fixed>
   Error 2: <what you fixed>
   ... (one line per error)
7. Push: git push origin ${batchBranch}

## RULES:
- You are working directly on the batch branch
- Do NOT create a new PR — push to the existing branch
- Only fix the specific errors shown above — do not refactor unrelated code
- If an error is in a test file, fix the test; if in source, fix the source
- If you cannot fix something, explain why in your commit message

Begin now. Open the first file mentioned in the errors and start fixing.
`;
}

/**
 * Generate the consolidator prompt.
 * The consolidator runs on the batch branch after all sub-PRs merge.
 * Narrow scope: extract shared utilities from duplicated code blocks only.
 */
export function generateConsolidatorPrompt(opts: {
  batchName: string;
  batchBranch: string;
  projectName: string;
  changedFiles: string[];
  duplicateReport: string;
  projectRules?: string;
}): string {
  const { batchName, batchBranch, projectName, changedFiles, duplicateReport, projectRules } = opts;

  const projectRulesSection = projectRules
    ? `\n## Project Rules\n\nThese are the project's coding standards. Follow them when extracting utilities.\n\n${projectRules}\n`
    : '';

  return `You are the Consolidator for the ${projectName} project. You are reviewing the combined output of multiple agents on batch branch \`${batchBranch}\`.

## Your Scope — STRICTLY LIMITED

You may ONLY extract shared utilities from duplicated code blocks. Specifically:

1. **Find code blocks duplicated across 3+ files** — the pre-check already identified candidates (see below)
2. **Extract each into a shared utility function** in the appropriate shared location
3. **Update all call sites** to use the new utility
4. **Add tests for the new utility** if the extracted logic has branching (e.g., throws on bad input)

## You MUST NOT:

- Add features or change business logic
- Change response building patterns (optimistic vs authoritative)
- Add or modify TypeScript interfaces
- Split large files into smaller ones
- Refactor code that is not duplicated
- Change error messages, log messages, or variable names
- Touch files that were NOT changed in this batch

## Pre-Check: Duplicated Code Blocks Found

The following duplicated patterns were detected across batch files:

${duplicateReport}

Focus on these specific patterns. If a pattern appears in fewer than 3 files, leave it alone.

## Files Changed in This Batch

${changedFiles.map(f => '- `' + f + '`').join('\n')}
${projectRulesSection}
## Workflow

1. Read the duplicated code blocks identified above
2. For each, determine the right shared location (e.g., \`amplify/shared/lib/\` for backend, \`src/lib/\` for frontend)
3. Extract into a well-named utility function
4. Update all call sites to use the utility
5. Run \`npx tsc --noEmit\` — zero errors
6. Run \`npm test\` — zero failures
7. Commit:
   chore: extract shared utilities from batch ${batchName}

   - Extracted: <utility name> (from N files)
   - Extracted: <utility name> (from N files)
8. Push: git push origin ${batchBranch}

## RULES:
- You are working directly on the batch branch — do NOT create a new PR
- Validation (lint, typecheck, tests) runs immediately after you finish — if you break anything, it will be caught and a fix agent will be dispatched
- If you cannot safely extract a pattern (e.g., the call sites have subtle differences), leave it alone and note why in your commit message
- Prefer small, focused utilities over large abstractions

Begin now. Read the first duplicated pattern and extract it.
`;
}

/**
 * Render the planner.agent.md template for scaffolding into a project workspace.
 */
export function renderPlannerAgentMd(opts: {
  config: OrchestratorConfig;
  projectDir: string;
  specOutputDir?: string;
}): string {
  const { config, projectDir, specOutputDir = 'docs/specs' } = opts;

  const templatePath = join(getTemplatesDir(), 'planner.agent.md.template');
  if (!existsSync(templatePath)) {
    throw new Error(`planner.agent.md template not found at ${templatePath}`);
  }
  const template = readUtf8(templatePath);

  const boundariesBlock = buildAgentBoundariesBlock(config);

  return template
    .replace(/\{PROJECT_NAME\}/g, () => config.project.name)
    .replace(/\{AI_TEAM_PROJECT_DIR\}/g, () => projectDir)
    .replace(/\{SPEC_OUTPUT_DIR\}/g, () => specOutputDir)
    .replace('{AGENT_BOUNDARIES_BLOCK}', () => boundariesBlock);
}

/**
 * Render the plan.claude-command.md template for scaffolding as a Claude Code slash command.
 */
export function renderPlanClaudeCommand(opts: {
  config: OrchestratorConfig;
  projectDir: string;
  specOutputDir?: string;
}): string {
  const { config, projectDir, specOutputDir = 'docs/specs' } = opts;

  const templatePath = join(getTemplatesDir(), 'plan.claude-command.md.template');
  if (!existsSync(templatePath)) {
    throw new Error(`plan.claude-command.md template not found at ${templatePath}`);
  }
  const template = readUtf8(templatePath);

  const boundariesBlock = buildAgentBoundariesBlock(config);

  return template
    .replace(/\{PROJECT_NAME\}/g, () => config.project.name)
    .replace(/\{AI_TEAM_PROJECT_DIR\}/g, () => projectDir)
    .replace(/\{SPEC_OUTPUT_DIR\}/g, () => specOutputDir)
    .replace('{AGENT_BOUNDARIES_BLOCK}', () => boundariesBlock);
}

// ── Context forwarding ──────────────────────────────────────

const MAX_FILES_PER_AGENT = 15;

/**
 * Get PR title and changed file paths via `gh pr view`.
 * Returns null on failure (e.g. PR not found, no gh CLI).
 */
function getPRSummary(prNumber: number): { title: string; files: string[] } | null {
  try {
    const { code, stdout } = execFileSafe('gh', [
      'pr', 'view', String(prNumber), '--json', 'title,files',
    ]);
    if (code !== 0) return null;
    const data = JSON.parse(stdout) as { title: string; files: Array<{ path: string }> };
    return { title: data.title, files: data.files.map(f => f.path) };
  } catch {
    return null;
  }
}

/**
 * Generate a context summary for a single completed round.
 * Pulls PR metadata and signal notes for each agent in the round.
 */
export function generateRoundSummary(opts: {
  orchState: OrchState;
  batch: BatchConfig;
  round: number;
  /** Read a signal file and return its notes. Injected for testability. */
  readSignalNotes?: (agentKey: string, spec: string) => string;
}): string {
  const { orchState, batch, round } = opts;

  // Filter assignments in this round
  const roundAssignments = batch.assignments.filter(a => a.round === round);
  if (roundAssignments.length === 0) return '';

  const lines: string[] = [`### Round ${round}`];

  for (const assignment of roundAssignments) {
    const agentKey = assignment.agent;
    const agentState = orchState.agents[`${agentKey}/${assignment.spec}`] ?? orchState.agents[agentKey];
    if (!agentState) continue;

    // Get PR info
    let title = assignment.description;
    let files: string[] = [];
    if (agentState.prNumber) {
      const prInfo = getPRSummary(agentState.prNumber);
      if (prInfo) {
        title = prInfo.title;
        files = prInfo.files;
      }
    }

    // Get signal notes
    let notes = '';
    if (opts.readSignalNotes) {
      notes = opts.readSignalNotes(agentKey, assignment.spec);
    }

    lines.push('');
    lines.push(`**${assignment.agent}** — ${title}`);
    lines.push(`- PR: #${agentState.prNumber ?? '?'} (${agentState.status})`);

    if (files.length > 0) {
      const shown = files.slice(0, MAX_FILES_PER_AGENT);
      const fileList = shown.map(f => `\`${f}\``).join(', ');
      const overflow = files.length > MAX_FILES_PER_AGENT ? ` (+${files.length - MAX_FILES_PER_AGENT} more)` : '';
      lines.push(`- Changed: ${fileList}${overflow}`);
    }

    if (notes) {
      lines.push(`- Notes: ${notes}`);
    }
  }

  return lines.join('\n');
}

/**
 * Build cumulative context from all completed round summaries.
 * Returns empty string if no summaries exist (round 1 agents).
 */
export function buildCumulativeContext(orchState: OrchState): string {
  if (!orchState.roundSummaries || Object.keys(orchState.roundSummaries).length === 0) {
    return '';
  }

  const rounds = Object.keys(orchState.roundSummaries)
    .map(Number)
    .sort((a, b) => a - b);

  const summaries = rounds
    .map(r => orchState.roundSummaries![r])
    .filter(Boolean)
    .join('\n\n');

  if (!summaries) return '';

  return `---

## Context from Previous Rounds

The following agents completed work in earlier rounds. Their changes are already merged into your branch. Be aware of new APIs, types, and patterns they introduced.

${summaries}`;
}
