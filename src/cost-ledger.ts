/**
 * Cost ledger — persistent tracking of every agent run's cost.
 *
 * Primary storage: per-batch costLedger[] inside each OrchState file.
 *   - In-process runs (validation-fix, batch-review, architect-review) call
 *     recordCostToOrchState() directly; the caller saves orchState.
 *   - Out-of-process runners write a sidecar JSON file; the orchestrator's
 *     poll loop ingests them via ingestSidecarCosts() → save → delete.
 *
 * Legacy fallback: cost-ledger.jsonl (append-only JSONL) is still read by
 * aggregateCostFromOrchFiles() for pre-migration batches that lack costLedger.
 * No new entries are written to JSONL.
 */

import { existsSync, appendFileSync, renameSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getSignalsDir } from './config.js';
import { readUtf8, ensureDir } from './helpers.js';
import type { CostLedgerEntry, OrchState } from './types.js';

// ── File paths ───────────────────────────────────────────────

export function getCostLedgerPath(): string {
  return join(getSignalsDir(), 'cost-ledger.jsonl');
}

function getLegacyLedgerPath(): string {
  return join(getSignalsDir(), 'cost-ledger.json');
}

// ── Migration from legacy JSON format ────────────────────────

/**
 * Migrate legacy cost-ledger.json → cost-ledger.jsonl.
 *
 * Handles two cases:
 *   1. JSONL does not exist yet — convert all JSON entries to JSONL.
 *   2. Both files exist — merge any JSON entries not already in JSONL
 *      (dedup by timestamp), then rename JSON → .bak.
 */
function migrateIfNeeded(): void {
  const jsonlPath = getCostLedgerPath();
  const jsonPath = getLegacyLedgerPath();

  if (!existsSync(jsonPath)) return;

  try {
    const raw = readUtf8(jsonPath);
    const legacy = JSON.parse(raw) as { entries: CostLedgerEntry[] };
    ensureDir(getSignalsDir());

    if (!existsSync(jsonlPath)) {
      // Case 1: fresh migration — write all entries
      const lines = legacy.entries.map((e) => JSON.stringify(e)).join('\n');
      if (lines.length > 0) {
        appendFileSync(jsonlPath, lines + '\n', 'utf-8');
      }
    } else {
      // Case 2: both exist — merge missing entries (dedup by timestamp)
      const existingTimestamps = new Set<string>();
      const existingLines = readUtf8(jsonlPath).split('\n');
      for (const line of existingLines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed) as CostLedgerEntry;
          existingTimestamps.add(entry.timestamp);
        } catch { /* skip malformed */ }
      }

      const newEntries = legacy.entries.filter((e) => !existingTimestamps.has(e.timestamp));
      if (newEntries.length > 0) {
        const lines = newEntries.map((e) => JSON.stringify(e)).join('\n');
        appendFileSync(jsonlPath, lines + '\n', 'utf-8');
      }
    }

    // Rename old file so migration doesn't run again
    renameSync(jsonPath, jsonPath + '.bak');
  } catch {
    // If migration fails, the old file stays — no data loss
  }
}

// ── Read ─────────────────────────────────────────────────────

/**
 * Read all entries from the JSONL ledger.
 * Each non-empty line is parsed as a CostLedgerEntry.
 * Malformed lines are silently skipped.
 */
export function readCostLedger(): { entries: CostLedgerEntry[]; totalCostUsd: number } {
  migrateIfNeeded();

  const file = getCostLedgerPath();
  if (!existsSync(file)) {
    return { entries: [], totalCostUsd: 0 };
  }

  const entries: CostLedgerEntry[] = [];
  let totalCostUsd = 0;

  const lines = readUtf8(file).split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as CostLedgerEntry;
      entries.push(entry);
      totalCostUsd += entry.costUsd;
    } catch {
      // Skip malformed lines
    }
  }

  return { entries, totalCostUsd };
}

// ── Orch-state cost tracking ────────────────────────────────

/**
 * Record a cost entry directly into the orchestrator state object.
 * The caller is responsible for calling saveOrchState() afterward.
 */
export function recordCostToOrchState(orchState: OrchState, entry: CostLedgerEntry): void {
  const cost = typeof entry.costUsd === 'number' && !isNaN(entry.costUsd) ? entry.costUsd : 0;
  if (!orchState.costLedger) orchState.costLedger = [];
  orchState.costLedger.push(entry);
  orchState.totalCostUsd = (orchState.totalCostUsd ?? 0) + cost;
}

// ── Sidecar cost files (for out-of-process runners) ─────────

const SIDECAR_SUFFIX = '-run-cost.json';

/**
 * Get the sidecar cost file path for a given agent run.
 * Includes runType and cycle to prevent filename collisions between
 * launch and review-fix runs of the same agent/spec.
 */
export function getSidecarCostPath(
  batchName: string, agentKey: string, specName: string,
  runType: string = 'launch', cycle: number = 0,
): string {
  return join(getSignalsDir(), `${batchName}-${agentKey}-${specName}-${runType}-c${cycle}${SIDECAR_SUFFIX}`);
}

/**
 * Ingest any pending sidecar cost files into the orch state.
 * Deletes each sidecar AFTER the caller saves orchState (call this, then saveOrchState,
 * then call deleteSidecarCostFiles).
 * Returns the list of sidecar file paths that were ingested (for later deletion).
 */
export function ingestSidecarCosts(orchState: OrchState): string[] {
  const signalsDir = getSignalsDir();
  if (!existsSync(signalsDir)) return [];

  const prefix = `${orchState.batchName}-`;
  const ingested: string[] = [];

  // Build a set of existing entry keys for dedup (prevents double-counting
  // if saveOrchState fails after ingest but before sidecar deletion)
  const existingKeys = new Set<string>();
  for (const e of orchState.costLedger ?? []) {
    existingKeys.add(`${e.agent}|${e.spec}|${e.runType}|${e.cycle}|${e.timestamp}`);
  }

  try {
    const files = readdirSync(signalsDir);
    for (const file of files) {
      if (!file.startsWith(prefix) || !file.endsWith(SIDECAR_SUFFIX)) continue;

      const filePath = join(signalsDir, file);
      try {
        const entry = JSON.parse(readUtf8(filePath)) as CostLedgerEntry;

        // Validate batch ownership (prevents prefix collisions like foo/foo-bar)
        if (entry.batchName !== orchState.batchName) continue;

        // Validate required fields (prevents NaN poisoning)
        if (typeof entry.costUsd !== 'number' || isNaN(entry.costUsd)) continue;

        // Dedup check
        const key = `${entry.agent}|${entry.spec}|${entry.runType}|${entry.cycle}|${entry.timestamp}`;
        if (existingKeys.has(key)) {
          ingested.push(filePath); // already ingested — mark for deletion
          continue;
        }

        recordCostToOrchState(orchState, entry);
        ingested.push(filePath);
      } catch {
        // Skip malformed sidecar files
      }
    }
  } catch {
    // Directory read error — skip
  }

  return ingested;
}

/**
 * Delete sidecar cost files after orchState has been saved.
 */
export function deleteSidecarCostFiles(paths: string[]): void {
  for (const p of paths) {
    try { unlinkSync(p); } catch { /* already gone */ }
  }
}

// ── Aggregate costs from orch files ─────────────────────────

/**
 * Read cost entries from all *-orchestrator.json files in the signals directory.
 * Falls back to the shared JSONL ledger for batches without costLedger.
 * Used by cost-report, status, and list-batches commands.
 */
export function aggregateCostFromOrchFiles(batchFilter?: string): CostLedgerEntry[] {
  const signalsDir = getSignalsDir();
  if (!existsSync(signalsDir)) return [];

  const entries: CostLedgerEntry[] = [];
  const batchesFromOrch = new Set<string>();

  try {
    const files = readdirSync(signalsDir);
    for (const file of files) {
      if (!file.endsWith('-orchestrator.json')) continue;

      const filePath = join(signalsDir, file);
      try {
        const orchState = JSON.parse(readUtf8(filePath)) as OrchState;
        if (batchFilter && orchState.batchName !== batchFilter) continue;

        batchesFromOrch.add(orchState.batchName);
        if (orchState.costLedger) {
          entries.push(...orchState.costLedger);
        }
      } catch {
        // Skip malformed orch files
      }
    }
  } catch {
    // Directory read error
  }

  // Fall back to JSONL for batches not covered by orch files
  const ledger = readCostLedger();
  for (const entry of ledger.entries) {
    if (batchFilter && entry.batchName !== batchFilter) continue;
    if (batchesFromOrch.has(entry.batchName)) continue; // already covered
    entries.push(entry);
  }

  return entries;
}

// ── Query helpers ────────────────────────────────────────────

export interface CostSummary {
  totalCostUsd: number;
  totalRuns: number;
  totalDurationMs: number;
  byBatch: Record<string, { costUsd: number; runs: number }>;
  byAgent: Record<string, { costUsd: number; runs: number }>;
  byRunType: Record<string, { costUsd: number; runs: number }>;
}

/**
 * Build a cost summary. When orchState is provided, reads directly from it
 * (batchFilter is ignored in this case).
 * Otherwise aggregates from all orch files (with JSONL fallback).
 */
export function getCostSummary(batchFilter?: string, orchState?: OrchState): CostSummary {
  let entries: CostLedgerEntry[];

  if (orchState) {
    entries = orchState.costLedger ?? [];
  } else {
    entries = aggregateCostFromOrchFiles(batchFilter);
  }

  const summary: CostSummary = {
    totalCostUsd: 0,
    totalRuns: entries.length,
    totalDurationMs: 0,
    byBatch: {},
    byAgent: {},
    byRunType: {},
  };

  for (const entry of entries) {
    const cost = entry.costUsd ?? 0;
    summary.totalCostUsd += cost;
    summary.totalDurationMs += entry.durationMs ?? 0;

    // By batch
    if (!summary.byBatch[entry.batchName]) {
      summary.byBatch[entry.batchName] = { costUsd: 0, runs: 0 };
    }
    summary.byBatch[entry.batchName].costUsd += cost;
    summary.byBatch[entry.batchName].runs++;

    // By agent
    const agentSpec = `${entry.agent}/${entry.spec}`;
    if (!summary.byAgent[agentSpec]) {
      summary.byAgent[agentSpec] = { costUsd: 0, runs: 0 };
    }
    summary.byAgent[agentSpec].costUsd += cost;
    summary.byAgent[agentSpec].runs++;

    // By run type
    if (!summary.byRunType[entry.runType]) {
      summary.byRunType[entry.runType] = { costUsd: 0, runs: 0 };
    }
    summary.byRunType[entry.runType].costUsd += cost;
    summary.byRunType[entry.runType].runs++;
  }

  return summary;
}

// ── Format helpers ───────────────────────────────────────────

export function formatCostReport(summary: CostSummary): string {
  const lines: string[] = [];

  lines.push(`Total Cost:     $${summary.totalCostUsd.toFixed(4)}`);
  lines.push(`Total Runs:     ${summary.totalRuns}`);
  lines.push(`Total Duration: ${formatDuration(summary.totalDurationMs)}`);
  lines.push('');

  // By batch
  const batchEntries = Object.entries(summary.byBatch).sort((a, b) => b[1].costUsd - a[1].costUsd);
  if (batchEntries.length > 0) {
    lines.push('By Batch:');
    for (const [batch, data] of batchEntries) {
      lines.push(`  ${batch.padEnd(45)} $${data.costUsd.toFixed(4)}  (${data.runs} runs)`);
    }
    lines.push('');
  }

  // By agent
  const agentEntries = Object.entries(summary.byAgent).sort((a, b) => b[1].costUsd - a[1].costUsd);
  if (agentEntries.length > 0) {
    lines.push('By Agent/Spec:');
    for (const [agent, data] of agentEntries) {
      lines.push(`  ${agent.padEnd(45)} $${data.costUsd.toFixed(4)}  (${data.runs} runs)`);
    }
    lines.push('');
  }

  // By run type
  const typeEntries = Object.entries(summary.byRunType).sort((a, b) => b[1].costUsd - a[1].costUsd);
  if (typeEntries.length > 0) {
    lines.push('By Run Type:');
    for (const [type, data] of typeEntries) {
      lines.push(`  ${type.padEnd(45)} $${data.costUsd.toFixed(4)}  (${data.runs} runs)`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}
