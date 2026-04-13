# Contributing to AI Team

## Setup

```bash
git clone https://github.com/EwneoN/ai-team.git
cd ai-team
npm install          # also runs build via prepare script
npm test             # 177 tests via Vitest
npm run typecheck    # tsc --noEmit
npm run dev -- orchestrate -b ...  # Run from source via tsx
```

## Project Structure

```
src/
├── index.ts                 # CLI entry point (commander setup)
├── commands/                # One file per CLI command
│   ├── orchestrate.ts
│   ├── plan.ts
│   ├── plan-prompt.ts
│   ├── init.ts
│   └── ...
├── boundary-hook.ts         # Standalone post-commit boundary check
├── boundary-check.ts        # checkBoundaryViolations() shared logic
├── helpers.ts               # Hook installation, path resolution
├── state.ts                 # Agent state machine
├── types.ts                 # Shared TypeScript types
└── __tests__/               # Vitest test suites
templates/
├── CLAUDE.md.template       # Agent prompt template
├── CLAUDE.md.review.template # Review-fix cycle prompt
├── PLANNER.md.template      # Planner agent instructions
└── planner.agent.md.template # VS Code agent mode for interactive planning
```

## Test Suites

| Test Suite | Tests | Covers |
|------------|-------|--------|
| state-transitions | 9 | Agent state machine (incl. merged status) |
| validate-config | 11 | Config schema validation |
| estimate-cost | 9 | Token cost calculation |
| parse-architect-verdict | 11 | Review verdict parsing |
| extract-pr-number | 11 | PR URL/number extraction |
| comment-dedup | 27 | Review comment deduplication |
| comment-status | 25 | Emoji status reply formatting and state tracking |
| resolve-model | 7 | Model resolution priority chain |
| validate | 14 | Batch validation (boundaries, collisions, conflicts) |
| boundary-hook | 20 | Post-commit hook generation, boundary enforcement integration |
| plan | 16 | Planner prompt rendering, batch generation, slug derivation |
| init | 12 | Project scaffolding, template rendering, --force overwrite |
| signal-reprocessing-guard | 5 | Signal dedup and reprocessing prevention |

## Dependencies

| Package | Purpose |
|---------|---------|
| [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) | Agent sessions via Claude Code |
| [`@anthropic-ai/sdk`](https://www.npmjs.com/package/@anthropic-ai/sdk) | Messages API for architect reviews |
| [`chalk`](https://www.npmjs.com/package/chalk) | Terminal colours |
| [`commander`](https://www.npmjs.com/package/commander) | CLI framework |
| [`minimatch`](https://www.npmjs.com/package/minimatch) | Glob matching for boundary checks |
