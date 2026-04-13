/**
 * Spec parser — extracts structured data from markdown spec files.
 *
 * Parses "Files to Modify", "Files NOT to Modify", and "Target Agent"
 * sections from spec markdown. Handles common format variations:
 *   - Bullet lists (- path, * path)
 *   - Backtick-wrapped paths (`path`)
 *   - Inline **File:** notations
 *   - Code blocks with file paths
 */

import { readFileSync, existsSync } from 'node:fs';

export interface ParsedSpec {
  /** Target agent key extracted from the spec (e.g. "backend") */
  targetAgent: string | null;
  /** File paths the spec says to modify */
  filesToModify: string[];
  /** File paths the spec says NOT to modify */
  filesToExclude: string[];
  /** Backtick-wrapped identifiers found in the spec (function names, types, queries, mutations) */
  identifiers: string[];
  /** Warnings encountered during parsing (non-fatal) */
  warnings: string[];
}

/**
 * Parse a spec markdown file and extract structured data.
 * Returns a ParsedSpec with best-effort extraction and warnings for
 * sections that couldn't be parsed. Never throws — logs warnings instead.
 */
export function parseSpec(specPath: string): ParsedSpec {
  const result: ParsedSpec = {
    targetAgent: null,
    filesToModify: [],
    filesToExclude: [],
    identifiers: [],
    warnings: [],
  };

  if (!existsSync(specPath)) {
    result.warnings.push(`Spec file not found: ${specPath}`);
    return result;
  }

  const content = readFileSync(specPath, 'utf-8');
  const lines = content.split('\n');

  result.targetAgent = extractTargetAgent(lines);
  result.filesToModify = extractFilePaths(lines, content, 'modify');
  result.filesToExclude = extractFilePaths(lines, content, 'exclude');
  result.identifiers = extractIdentifiers(content);

  if (!result.targetAgent) {
    result.warnings.push('Could not extract target agent from spec');
  }
  if (result.filesToModify.length === 0) {
    result.warnings.push('Could not extract any "Files to Modify" from spec — boundary check will be skipped for this spec');
  }

  return result;
}

/**
 * Extract the target agent key from a spec.
 * Looks for patterns like:
 *   ## Target Agent
 *   **backend** → Backend Engineer
 */
function extractTargetAgent(lines: string[]): string | null {
  let inTargetSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect "## Target Agent" heading
    if (/^#{1,3}\s+target\s+agent/i.test(trimmed)) {
      inTargetSection = true;
      continue;
    }

    // If we're in the target agent section, look for the agent key
    if (inTargetSection) {
      // **backend** → Backend Engineer
      const boldMatch = trimmed.match(/^\*\*(\w+)\*\*/);
      if (boldMatch) return boldMatch[1].toLowerCase();

      // `backend` — Backend Engineer
      const backtickMatch = trimmed.match(/^`(\w+)`/);
      if (backtickMatch) return backtickMatch[1].toLowerCase();

      // Plain word at start (backend, frontend, etc.)
      const plainMatch = trimmed.match(/^(architect|backend|frontend|infra|designer|qa|seo)\b/i);
      if (plainMatch) return plainMatch[1].toLowerCase();

      // If we hit another heading, stop looking
      if (/^#/.test(trimmed)) {
        inTargetSection = false;
      }
    }
  }

  // Fallback: check the spec title for agent key
  // # Spec: Backend — Feature Name
  for (const line of lines) {
    const titleMatch = line.match(/^#\s+spec:\s*(architect|backend|frontend|infra|designer|qa|seo)\b/i);
    if (titleMatch) return titleMatch[1].toLowerCase();
  }

  return null;
}

/**
 * Extract file paths from a spec's "Files to Modify" or "Files NOT to Modify" section.
 */
function extractFilePaths(lines: string[], _fullContent: string, mode: 'modify' | 'exclude'): string[] {
  const paths = new Set<string>();

  // Strategy 1: Find explicit section heading and extract bullet list
  const sectionPaths = extractFromSection(lines, mode);
  for (const p of sectionPaths) paths.add(p);

  // Strategy 2: Find inline **File:** notations (common in existing specs)
  if (mode === 'modify') {
    const inlinePaths = extractInlineFilePaths(lines);
    for (const p of inlinePaths) paths.add(p);
  }

  return [...paths].sort();
}

/**
 * Extract paths from a headed section like "### Files to Modify" or "### Files NOT to Modify".
 */
function extractFromSection(lines: string[], mode: 'modify' | 'exclude'): string[] {
  const paths: string[] = [];
  let inSection = false;

  const sectionPatterns = mode === 'modify'
    ? [/files\s+to\s+modify/i, /files\s+to\s+change/i, /files\s+to\s+create\s+or\s+modify/i, /files\s+to\s+create/i, /modified\s+files/i, /files\s+affected/i]
    : [/files\s+not\s+to\s+modify/i, /files\s+to\s+avoid/i, /do\s+not\s+modify/i, /off[\s-]limits/i];

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect section heading
    if (/^#{1,4}\s+/.test(trimmed)) {
      const headingText = trimmed.replace(/^#{1,4}\s+/, '');
      inSection = sectionPatterns.some(p => p.test(headingText));
      continue;
    }

    // Exit section on next heading
    if (inSection && /^#{1,4}\s+/.test(trimmed)) {
      inSection = false;
      continue;
    }

    if (!inSection) continue;

    // Extract path from bullet line: - path, * path, - `path`
    const bulletMatch = trimmed.match(/^[-*]\s+`?([^\s`(]+\.[a-zA-Z]{1,10})`?/);
    if (bulletMatch) {
      paths.push(normalizePath(bulletMatch[1]));
      continue;
    }

    // Extract path from bullet with explanation: - amplify/foo.ts (does something)
    const bulletWithDesc = trimmed.match(/^[-*]\s+`?([^\s`]+\/[^\s`(]+)`?\s/);
    if (bulletWithDesc && looksLikeFilePath(bulletWithDesc[1])) {
      paths.push(normalizePath(bulletWithDesc[1]));
    }
  }

  return paths;
}

/**
 * Extract file paths from inline **File:** or **File(s):** notations.
 * Example: **File:** `amplify/functions/resolvers/foo/handler.ts`
 */
function extractInlineFilePaths(lines: string[]): string[] {
  const paths: string[] = [];

  for (const line of lines) {
    // **File:** `path` or **File:** path
    const fileMatch = line.match(/\*\*Files?\s*:\*\*\s*`?([^\s`]+\.[a-zA-Z]{1,10})`?/);
    if (fileMatch && looksLikeFilePath(fileMatch[1])) {
      paths.push(normalizePath(fileMatch[1]));
    }

    // **New file:** `path` or **Create:** `path`
    const newFileMatch = line.match(/\*\*(?:New\s+file|Create)\s*:\*\*\s*`?([^\s`]+\.[a-zA-Z]{1,10})`?/i);
    if (newFileMatch && looksLikeFilePath(newFileMatch[1])) {
      paths.push(normalizePath(newFileMatch[1]));
    }
  }

  return paths;
}

/**
 * Check if a string looks like a file path (contains / or \ and has an extension).
 */
function looksLikeFilePath(s: string): boolean {
  return /[/\\]/.test(s) && /\.\w{1,10}$/.test(s);
}

/**
 * Normalize a file path: forward slashes, no leading ./
 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Extract backtick-wrapped identifiers that look like code references
 * (function names, type names, mutation/query names).
 *
 * Filters out:
 *   - File paths (contain / and have extensions — already captured by filesToModify)
 *   - CSS tokens (start with --)
 *   - Shell commands (contain spaces suggesting command invocations)
 *   - Short strings (< 3 chars) and common markdown noise
 */
export function extractIdentifiers(content: string): string[] {
  const ids = new Set<string>();

  // Match backtick-wrapped tokens: `someIdentifier`
  const backtickPattern = /`([^`\n]+)`/g;
  let match;

  while ((match = backtickPattern.exec(content)) !== null) {
    const token = match[1].trim();

    // Skip file paths (handled by filesToModify)
    if (/[/\\]/.test(token) && /\.\w{1,10}$/.test(token)) continue;

    // Skip CSS custom properties
    if (token.startsWith('--')) continue;

    // Skip shell commands / multi-word phrases (likely not identifiers)
    if (/\s/.test(token)) continue;

    // Skip very short tokens
    if (token.length < 3) continue;

    // Skip common markdown/formatting noise
    if (/^[#*_>|`~\-=+]+$/.test(token)) continue;

    // Skip numbers and version strings
    if (/^\d/.test(token)) continue;

    // Skip CSS class names (start with .)
    if (token.startsWith('.')) continue;

    // Keep identifiers that look like code: camelCase, PascalCase, UPPER_CASE,
    // or contain common code patterns (parentheses for function calls, etc.)
    if (/^[a-zA-Z_$]/.test(token)) {
      // Strip trailing parentheses/args for function-like references: `getMatchSetup(fixtureId)` → `getMatchSetup`
      const cleaned = token.replace(/\(.*\)$/, '');
      if (cleaned.length >= 3) {
        ids.add(cleaned);
      }
    }
  }

  return [...ids].sort();
}
