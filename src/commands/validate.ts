/**
 * validate command — pre-flight validation for batch files and specs.
 *
 * Checks:
 *   1. Batch schema   — required fields, agent keys exist in config, spec files exist
 *   2. Workspace collision — no two assignments in the same round share a workspace
 *   3. Boundary check — each spec's "Files to Modify" matches agent's ownedPaths
 *   4. Cross-file conflicts — warns if multiple specs modify the same file
 *   5. Cross-spec identifiers — warns if similar identifiers differ across specs
 *   6. Config sync — warns if agent-boundaries.json differs from config.json
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { loadConfig, loadBatch, getProjectRoot } from '../config.js';
import { checkBoundaryViolations } from '../boundary-check.js';
import { parseSpec } from '../spec-parser.js';
import { header, agentLog, step } from '../logger.js';
import type { OrchestratorConfig, BatchConfig } from '../types.js';

export interface ValidateOptions {
  batchFile: string;
  /** If true, print warnings but don't fail on boundary violations */
  warnOnly?: boolean;
}

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

/**
 * Run all pre-flight validation checks for a batch.
 * Returns the result with errors and warnings (does NOT throw).
 */
export function validateBatch(opts: ValidateOptions): ValidationResult {
  const result: ValidationResult = { errors: [], warnings: [] };

  // ── Load config ──────────────────────────────────────────
  let config: OrchestratorConfig;
  try {
    config = loadConfig();
  } catch (err) {
    result.errors.push(`Config load failed: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }

  // ── Load batch ───────────────────────────────────────────
  let batch: BatchConfig;
  try {
    batch = loadBatch(opts.batchFile);
  } catch (err) {
    result.errors.push(`Batch load failed: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }

  // ── 1. Batch schema validation ───────────────────────────
  validateBatchSchema(batch, config, result);

  // ── 2. Workspace collision detection ─────────────────────
  validateWorkspaceCollisions(batch, config, result);

  // ── 3. Spec boundary validation ──────────────────────────
  validateSpecBoundaries(batch, config, result);

  // ── 4. Cross-file conflict detection ─────────────────────
  detectCrossFileConflicts(batch, config, result);

  // ── 5. Cross-spec identifier consistency ──────────────────
  validateCrossSpecIdentifiers(batch, result);

  // ── 6. Config sync check ─────────────────────────────────
  checkConfigSync(config, result);

  return result;
}

/**
 * Run validation and print results. Returns true if no errors.
 */
export function validate(opts: ValidateOptions): boolean {
  header('Pre-flight Validation');

  const result = validateBatch(opts);

  // Print warnings
  for (const w of result.warnings) {
    console.log(`  ⚠ ${w}`);
  }

  // Print errors
  for (const e of result.errors) {
    console.log(`  ✗ ${e}`);
  }

  if (result.errors.length === 0 && result.warnings.length === 0) {
    console.log('  ✅ All checks passed.');
  } else if (result.errors.length === 0) {
    console.log();
    console.log(`  ✅ Passed with ${result.warnings.length} warning(s).`);
  } else {
    console.log();
    console.log(`  ❌ Validation failed: ${result.errors.length} error(s), ${result.warnings.length} warning(s).`);
    if (!opts.warnOnly) {
      console.log('     Fix specs/batch and retry. Use --skip-validation to override.');
    }
  }
  console.log();

  return opts.warnOnly || result.errors.length === 0;
}

// ── Check implementations ────────────────────────────────────

function validateBatchSchema(
  batch: BatchConfig,
  config: OrchestratorConfig,
  result: ValidationResult,
): void {
  step(1, 'Batch schema...');

  if (!batch.name) {
    result.errors.push('Batch is missing "name"');
  }
  if (!batch.assignments || batch.assignments.length === 0) {
    result.errors.push('Batch has no assignments');
    return;
  }

  const projectRoot = getProjectRoot();
  const specNames = new Set<string>();
  const rounds = new Set<number>();

  for (const a of batch.assignments) {
    // Required fields
    if (!a.agent) result.errors.push(`Assignment missing "agent" (spec: ${a.spec || '?'})`);
    if (!a.spec) result.errors.push(`Assignment missing "spec" (agent: ${a.agent || '?'})`);
    if (!a.specPath) result.errors.push(`Assignment "${a.spec}" missing "specPath"`);

    // Agent key exists in config
    if (a.agent && !config.agents[a.agent]) {
      const valid = Object.keys(config.agents).join(', ');
      result.errors.push(`Assignment "${a.spec}": unknown agent "${a.agent}" (valid: ${valid})`);
    }

    // Spec file exists on disk
    if (a.specPath) {
      const specAbsPath = resolve(projectRoot, a.specPath);
      if (!existsSync(specAbsPath)) {
        result.errors.push(`Assignment "${a.spec}": spec file not found at ${a.specPath}`);
      }
    }

    // Unique spec names
    if (a.spec) {
      if (specNames.has(a.spec)) {
        result.errors.push(`Duplicate spec name "${a.spec}" in batch`);
      }
      specNames.add(a.spec);
    }

    // Valid round numbers
    const round = a.round ?? 1;
    if (round < 1 || !Number.isInteger(round)) {
      result.errors.push(`Assignment "${a.spec}": invalid round ${round} (must be positive integer)`);
    }
    rounds.add(round);
  }

  // Check for round gaps
  if (rounds.size > 0) {
    const maxRound = Math.max(...rounds);
    for (let r = 1; r <= maxRound; r++) {
      if (!rounds.has(r)) {
        result.warnings.push(`Round gap: round ${r} has no assignments (rounds jump from ${r - 1} to ${r + 1}+)`);
      }
    }
  }

  const errorCount = result.errors.length;
  if (errorCount === 0) {
    agentLog('validate', `Valid (${batch.assignments.length} assignments, rounds 1-${Math.max(...rounds)})`, 'OK');
  }
}

function validateWorkspaceCollisions(
  batch: BatchConfig,
  config: OrchestratorConfig,
  result: ValidationResult,
): void {
  step(2, 'Workspace collisions...');

  const roundMap = new Map<number, typeof batch.assignments>();
  for (const a of batch.assignments) {
    const r = a.round ?? 1;
    if (!roundMap.has(r)) roundMap.set(r, []);
    roundMap.get(r)!.push(a);
  }

  let collisions = 0;
  for (const [round, group] of roundMap) {
    const workspaceSeen = new Map<string, string>();
    for (const a of group) {
      if (!config.agents[a.agent]) continue; // Already flagged in schema check
      const dir = config.agents[a.agent].workingDir;
      const prev = workspaceSeen.get(dir);
      if (prev) {
        result.errors.push(
          `Workspace collision in round ${round}: "${prev}" and "${a.spec}" both target workspace "${a.agent}". Move one to a different round.`,
        );
        collisions++;
      }
      workspaceSeen.set(dir, a.spec);
    }
  }

  if (collisions === 0) {
    agentLog('validate', 'No workspace collisions', 'OK');
  }
}

function validateSpecBoundaries(
  batch: BatchConfig,
  config: OrchestratorConfig,
  result: ValidationResult,
): void {
  step(3, 'Spec boundary check...');

  const projectRoot = getProjectRoot();
  let violationCount = 0;

  for (const a of batch.assignments) {
    if (!a.specPath || !config.agents[a.agent]) continue;

    const specAbsPath = resolve(projectRoot, a.specPath);
    if (!existsSync(specAbsPath)) continue; // Already flagged in schema check

    const parsed = parseSpec(specAbsPath);
    const agentConfig = config.agents[a.agent];

    // Report parser warnings
    for (const w of parsed.warnings) {
      result.warnings.push(`${a.spec}: ${w}`);
    }

    // Verify target agent matches batch assignment
    if (parsed.targetAgent && parsed.targetAgent !== a.agent) {
      result.warnings.push(
        `${a.spec}: spec says target agent is "${parsed.targetAgent}" but batch assigns to "${a.agent}"`,
      );
    }

    // Skip boundary check if no files were extracted
    if (parsed.filesToModify.length === 0) continue;

    // Check each file against agent's ownedPaths
    const violations = checkBoundaryViolations(parsed.filesToModify, agentConfig.ownedPaths);

    if (violations.length > 0) {
      violationCount += violations.length;

      // Find which agent owns each violating file
      const suggestions = violations.map(f => {
        const owner = findOwner(f, config);
        return owner
          ? `    ✗ ${f} → owned by ${owner}`
          : `    ✗ ${f} → no matching owner found`;
      });

      result.errors.push(
        `${a.spec} (agent: ${a.agent}):\n` +
        suggestions.join('\n') + '\n' +
        `    ${a.agent} owns: ${agentConfig.ownedPaths.join(', ')}`,
      );
    } else {
      agentLog(a.agent, `${a.spec} — all ${parsed.filesToModify.length} files within boundary`, 'OK');
    }
  }

  if (violationCount === 0) {
    agentLog('validate', 'No boundary violations', 'OK');
  }
}

function detectCrossFileConflicts(
  batch: BatchConfig,
  _config: OrchestratorConfig,
  result: ValidationResult,
): void {
  step(4, 'Cross-file conflicts...');

  const projectRoot = getProjectRoot();
  // Map: file -> list of { spec, round }
  const fileToSpecs = new Map<string, { spec: string; round: number }[]>();

  for (const a of batch.assignments) {
    if (!a.specPath) continue;

    const specAbsPath = resolve(projectRoot, a.specPath);
    if (!existsSync(specAbsPath)) continue;

    const parsed = parseSpec(specAbsPath);
    const round = a.round ?? 1;

    for (const f of parsed.filesToModify) {
      if (!fileToSpecs.has(f)) fileToSpecs.set(f, []);
      fileToSpecs.get(f)!.push({ spec: a.spec, round });
    }
  }

  let conflicts = 0;
  for (const [file, entries] of fileToSpecs) {
    if (entries.length <= 1) continue;

    // Group by round to check for same-round conflicts
    const roundGroups = new Map<number, string[]>();
    for (const e of entries) {
      if (!roundGroups.has(e.round)) roundGroups.set(e.round, []);
      roundGroups.get(e.round)!.push(e.spec);
    }

    const sameRoundConflicts = [...roundGroups.entries()].filter(([, specs]) => specs.length > 1);
    const allSpecs = entries.map(e => e.spec).join(', ');

    if (sameRoundConflicts.length > 0) {
      // Real conflict: multiple specs in the same round touch the same file
      for (const [round, specs] of sameRoundConflicts) {
        result.warnings.push(
          `File "${file}" is modified by ${specs.length} specs in round ${round}: ${specs.join(', ')} — merge conflict risk`,
        );
      }
      conflicts++;
    } else if (entries.length > 1) {
      // Sequential rounds touching same file — warn about merge conflict potential
      result.warnings.push(
        `File "${file}" is modified by specs in different rounds (${allSpecs}) — merge conflict risk if later rounds don't rebase`,
      );
    }
  }

  if (conflicts === 0) {
    agentLog('validate', 'No cross-file conflicts', 'OK');
  }
}

/**
 * Cross-spec identifier consistency — detects when multiple specs reference
 * the same concept (e.g. a mutation name) but use different spellings.
 *
 * Strategy: extract all backtick-wrapped identifiers from each spec, find
 * identifiers that are "suspiciously similar" (same base word, different
 * prefix/suffix like init vs initiate) across specs, and warn about mismatches.
 */
function validateCrossSpecIdentifiers(
  batch: BatchConfig,
  result: ValidationResult,
): void {
  step(5, 'Cross-spec identifier consistency...');

  const projectRoot = getProjectRoot();

  // Collect identifiers per spec: Map<identifier, spec[]>
  const idToSpecs = new Map<string, string[]>();

  for (const a of batch.assignments) {
    if (!a.specPath) continue;

    const specAbsPath = resolve(projectRoot, a.specPath);
    if (!existsSync(specAbsPath)) continue;

    const parsed = parseSpec(specAbsPath);

    for (const id of parsed.identifiers) {
      if (!idToSpecs.has(id)) idToSpecs.set(id, []);
      idToSpecs.get(id)!.push(a.spec);
    }
  }

  // Find near-duplicates: identifiers that share a long common suffix/prefix
  // but differ slightly (e.g. initMatchSetup vs initiateMatchSetup)
  const allIds = [...idToSpecs.keys()];
  const flagged = new Set<string>();
  let issueCount = 0;

  for (let i = 0; i < allIds.length; i++) {
    for (let j = i + 1; j < allIds.length; j++) {
      const a = allIds[i];
      const b = allIds[j];

      // Skip if both appear in exactly the same set of specs (consistent usage)
      const specsA = idToSpecs.get(a)!;
      const specsB = idToSpecs.get(b)!;
      const specsASet = new Set(specsA);
      const specsBSet = new Set(specsB);
      const sameSpecSet =
        specsASet.size === specsBSet.size &&
        [...specsASet].every(s => specsBSet.has(s));

      // Only skip when usage is identical across specs; partial overlap should still be flagged
      if (sameSpecSet) continue;

      if (areSuspiciouslySimilar(a, b)) {
        const pairKey = [a, b].sort().join('|');
        if (flagged.has(pairKey)) continue;
        flagged.add(pairKey);

        result.warnings.push(
          `Possible identifier mismatch across specs: \`${a}\` (in ${specsA.join(', ')}) vs \`${b}\` (in ${specsB.join(', ')}). ` +
          'Verify these refer to the same thing and use a consistent name.',
        );
        issueCount++;
      }
    }
  }

  if (issueCount === 0) {
    agentLog('validate', 'No cross-spec identifier mismatches detected', 'OK');
  }
}

/**
 * Check if two identifiers are "suspiciously similar" — likely the same concept
 * with a typo or naming inconsistency.
 *
 * Heuristics:
 * 1. One is a substring of the other with a short difference (e.g. init vs initiate)
 * 2. Same camelCase tail after splitting (e.g. getMatchSetup vs fetchMatchSetup)
 * 3. Same words in different order (e.g. SetupMatchInput vs MatchSetupInput)
 */
function areSuspiciouslySimilar(a: string, b: string): boolean {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();

  // Exact match after lowercasing (shouldn't happen, but defensive)
  if (la === lb) return true;

  // One contains the other as a substring and they're close in length
  if (la.includes(lb) || lb.includes(la)) {
    const lenDiff = Math.abs(a.length - b.length);
    const maxLen = Math.max(a.length, b.length);
    // e.g. "initMatchSetup" (14) vs "initiateMatchSetup" (18) — diff is 4, max is 18
    if (lenDiff <= 6 && lenDiff / maxLen < 0.35) return true;
  }

  // Same camelCase tail after splitting on capital letters
  // e.g. getMatchSetup vs fetchMatchSetup → both end in MatchSetup
  const tailA = extractCamelTail(a);
  const tailB = extractCamelTail(b);
  if (tailA && tailB && tailA === tailB && a !== b) {
    return true;
  }

  // Same words in different order (PascalCase types)
  // e.g. SetupMatchInput vs MatchSetupInput → same words {Setup, Match, Input}
  const wordsA = extractCamelWords(a);
  const wordsB = extractCamelWords(b);
  if (wordsA.length >= 2 && wordsA.length === wordsB.length) {
    const sortedA = [...wordsA].sort().join('|');
    const sortedB = [...wordsB].sort().join('|');
    if (sortedA === sortedB) return true;
  }

  return false;
}

/**
 * Extract the "tail" of a camelCase identifier (everything after the first word).
 * e.g. "getMatchSetup" → "MatchSetup", "initiateMatchSetup" → "MatchSetup"
 */
function extractCamelTail(id: string): string | null {
  // Split on first lowercase→uppercase boundary
  const match = id.match(/^[a-z]+([A-Z].+)/);
  return match ? match[1] : null;
}

/**
 * Split a camelCase/PascalCase identifier into lowercase words.
 * e.g. "SetupMatchInput" → ["setup", "match", "input"]
 */
function extractCamelWords(id: string): string[] {
  const words = id.match(/[A-Z][a-z]+|[a-z]+/g);
  return words ? words.map(w => w.toLowerCase()) : [];
}

function checkConfigSync(
  config: OrchestratorConfig,
  result: ValidationResult,
): void {
  step(6, 'Config sync...');

  const projectRoot = getProjectRoot();
  const boundariesPath = join(projectRoot, '.github', 'agent-boundaries.json');

  if (!existsSync(boundariesPath)) {
    agentLog('validate', 'No agent-boundaries.json found (using config.json as single source)', 'OK');
    return;
  }

  try {
    const raw = readFileSync(boundariesPath, 'utf-8');
    const boundaries = JSON.parse(raw) as Record<string, { paths: string[] }>;

    let drifts = 0;
    for (const [agentKey, agentConfig] of Object.entries(config.agents)) {
      const boundaryEntry = boundaries[agentKey];
      if (!boundaryEntry) {
        result.warnings.push(`Config sync: agent "${agentKey}" exists in config.json but not in agent-boundaries.json`);
        drifts++;
        continue;
      }

      const configPaths = [...agentConfig.ownedPaths].sort();
      const boundaryPaths = [...(boundaryEntry.paths || [])].sort();

      if (JSON.stringify(configPaths) !== JSON.stringify(boundaryPaths)) {
        result.warnings.push(
          `Config sync: agent "${agentKey}" ownedPaths differ between config.json and agent-boundaries.json`,
        );
        drifts++;
      }
    }

    // Check for agents in boundaries but not in config
    for (const agentKey of Object.keys(boundaries)) {
      if (!config.agents[agentKey]) {
        result.warnings.push(`Config sync: agent "${agentKey}" exists in agent-boundaries.json but not in config.json`);
        drifts++;
      }
    }

    if (drifts === 0) {
      agentLog('validate', 'config.json and agent-boundaries.json are in sync', 'OK');
    } else {
      result.warnings.push('Consider deprecating agent-boundaries.json in favor of config.json as single source of truth');
    }
  } catch {
    result.warnings.push('Could not parse agent-boundaries.json for sync check');
  }
}

/**
 * Find which agent owns a given file path, based on config ownedPaths.
 */
function findOwner(filePath: string, config: OrchestratorConfig): string | null {
  for (const [agentKey, agentConfig] of Object.entries(config.agents)) {
    const violations = checkBoundaryViolations([filePath], agentConfig.ownedPaths);
    if (violations.length === 0) return agentKey;
  }
  return null;
}
