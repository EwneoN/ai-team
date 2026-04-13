/**
 * archive-logs command — moves completed batch logs to archived subdirectories.
 *
 * Prevents unbounded log growth by archiving logs for completed batches into
 * ai-team/logs/archived/{batchName}/
 */

import { readdirSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { getLogsDir, getBatchesDir } from '../config.js';

interface ArchiveLogsOptions {
  batch?: string;
  dryRun?: boolean;
  all?: boolean;
}

/**
 * Detect batch names from the batch JSON files in ai-team/batches/.
 * Only returns batches that have matching log files.
 */
function detectBatchNames(logFiles: string[]): string[] {
  const batchesDir = getBatchesDir();
  const batchFiles = readdirSync(batchesDir)
    .filter(f => f.endsWith('.json') && f !== 'example.json');

  const batchNames = batchFiles.map(f => basename(f, '.json'));

  // Only return batches that have at least one matching log file
  return batchNames
    .filter(name => logFiles.some(f => f.startsWith(name + '-')))
    .sort();
}

/**
 * Get log files belonging to a specific batch, excluding files that match
 * a more specific (longer) batch name prefix.
 * E.g., "phase3-commissioner-final-..." should NOT match "phase3-commissioner".
 */
function getFilesForBatch(batchName: string, logFiles: string[], allBatchNames: string[]): string[] {
  // Find batch names that are more specific (longer) extensions of this batch
  const longerBatches = allBatchNames.filter(
    b => b !== batchName && b.startsWith(batchName + '-')
  );

  return logFiles.filter(f => {
    if (!f.startsWith(batchName + '-')) return false;
    // Exclude files that belong to a more specific batch
    return !longerBatches.some(lb => f.startsWith(lb + '-'));
  });
}

export function archiveLogs(options: ArchiveLogsOptions): void {
  const logsDir = getLogsDir();
  const archivedDir = join(logsDir, 'archived');

  if (!existsSync(logsDir)) {
    console.log('No logs directory found.');
    return;
  }

  // Get all files in logs/ (exclude directories and .gitkeep)
  const allFiles = readdirSync(logsDir, { withFileTypes: true })
    .filter(d => d.isFile() && d.name !== '.gitkeep')
    .map(d => d.name);

  if (allFiles.length === 0) {
    console.log('No log files to archive.');
    return;
  }

  // If no batch specified and not --all, list detected batches
  if (!options.batch && !options.all) {
    const batches = detectBatchNames(allFiles);
    console.log(`Found ${allFiles.length} log files across ${batches.length} batch(es):\n`);
    for (const batch of batches) {
      const count = getFilesForBatch(batch, allFiles, batches).length;
      console.log(`  ${batch}  (${count} files)`);
    }
    console.log('');
    console.log('Usage:');
    console.log('  archive-logs -b <batchName>   Archive logs for a specific batch');
    console.log('  archive-logs --all            Archive all detected batches');
    console.log('  archive-logs --all --dry-run  Preview what would be archived');
    return;
  }

  // Determine which batches to archive
  const allBatchNames = detectBatchNames(allFiles);
  let batchesToArchive: string[];
  if (options.batch) {
    batchesToArchive = [options.batch];
  } else {
    batchesToArchive = allBatchNames;
  }

  let totalMoved = 0;

  for (const batchName of batchesToArchive) {
    const matchingFiles = getFilesForBatch(batchName, allFiles, allBatchNames);

    if (matchingFiles.length === 0) {
      console.log(`No log files found for batch "${batchName}".`);
      continue;
    }

    const destDir = join(archivedDir, batchName);

    if (options.dryRun) {
      console.log(`[dry-run] Would archive ${matchingFiles.length} files → archived/${batchName}/`);
      for (const file of matchingFiles) {
        console.log(`  ${file}`);
      }
    } else {
      mkdirSync(destDir, { recursive: true });
      for (const file of matchingFiles) {
        renameSync(join(logsDir, file), join(destDir, file));
      }
      console.log(`Archived ${matchingFiles.length} files → archived/${batchName}/`);
    }

    totalMoved += matchingFiles.length;
  }

  if (!options.dryRun && totalMoved > 0) {
    console.log(`\nTotal: ${totalMoved} files archived.`);
  } else if (options.dryRun) {
    console.log(`\n[dry-run] Total: ${totalMoved} files would be archived.`);
  }
}
