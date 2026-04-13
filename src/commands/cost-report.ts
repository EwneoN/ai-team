/**
 * cost-report command — display cost summary from the cost ledger.
 *
 * Usage:
 *   npx tsx ai-team/cli/src/index.ts cost-report
 *   npx tsx ai-team/cli/src/index.ts cost-report --batch <batchName>
 *   npx tsx ai-team/cli/src/index.ts cost-report --json
 */

import { getCostSummary, formatCostReport, aggregateCostFromOrchFiles } from '../cost-ledger.js';
import { header } from '../logger.js';

export interface CostReportOptions {
  batch?: string;
  json?: boolean;
}

export function costReport(opts: CostReportOptions): void {
  if (opts.json) {
    const entries = aggregateCostFromOrchFiles(opts.batch);
    const totalCostUsd = entries.reduce((s, e) => s + e.costUsd, 0);
    console.log(JSON.stringify({ entries, totalCostUsd }, null, 2));
    return;
  }

  const summary = getCostSummary(opts.batch);

  header(opts.batch ? `Cost Report — ${opts.batch}` : 'Cost Report — All Batches');
  console.log();

  if (summary.totalRuns === 0) {
    console.log('  No cost data recorded yet.');
    console.log();
    return;
  }

  // Indent each line
  const report = formatCostReport(summary);
  for (const line of report.split('\n')) {
    console.log(`  ${line}`);
  }
}
