/**
 * init command — scaffold project customization files from ai-team templates.
 *
 * Currently scaffolds:
 * - .github/agents/planner.agent.md — VS Code agent mode for interactive planning
 * - .claude/commands/plan.md — Claude Code slash command for interactive planning
 *
 * Idempotent: skips files that already exist unless --force is set.
 */

import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { loadConfig, getProjectRoot, getProjectDir } from '../config.js';
import { ensureDir, writeUtf8 } from '../helpers.js';
import { header, step } from '../logger.js';
import { renderPlannerAgentMd, renderPlanClaudeCommand } from '../templates.js';

export interface InitOptions {
  force?: boolean;
}

export function init(opts: InitOptions): void {
  const config = loadConfig();
  const projectRoot = getProjectRoot();
  const projectDir = getProjectDir();

  header('Init — Scaffold Project Files');

  // Compute relative project dir path for the agent template
  // e.g., if projectDir is /foo/bar/.ai-team and projectRoot is /foo/bar,
  // the relative path is ".ai-team"
  const relativeProjectDir = relative(projectRoot, projectDir).replace(/\\/g, '/') || '.ai-team';

  const scaffoldFiles = [
    {
      name: 'planner.agent.md',
      targetPath: join(projectRoot, '.github', 'agents', 'planner.agent.md'),
      render: () => renderPlannerAgentMd({
        config,
        projectDir: relativeProjectDir,
      }),
    },
    {
      name: 'plan.md (Claude Code)',
      targetPath: join(projectRoot, '.claude', 'commands', 'plan.md'),
      render: () => renderPlanClaudeCommand({
        config,
        projectDir: relativeProjectDir,
      }),
    },
  ];

  let created = 0;
  let skipped = 0;

  for (let i = 0; i < scaffoldFiles.length; i++) {
    const file = scaffoldFiles[i];
    step(i + 1, file.name);

    if (existsSync(file.targetPath) && !opts.force) {
      console.log(`    Exists — skipped (use --force to overwrite)`);
      skipped++;
      continue;
    }

    ensureDir(dirname(file.targetPath));
    const content = file.render();
    writeUtf8(file.targetPath, content);
    console.log(`    ✓ Written to ${file.targetPath}`);
    created++;
  }

  console.log();
  console.log(`  ${created} file(s) created, ${skipped} skipped.`);
  console.log();
}
