/**
 * Central type definitions for the AI Team CLI.
 * Mirrors the structure in ai-team/scripts/config.json and batch files.
 */

// ── Config types ─────────────────────────────────────────────

export interface ProjectConfig {
  name: string;
  repoUrl: string;
  mainBranch: string;
  /** Domain for agent git email addresses (default: '{name}.local') */
  emailDomain?: string;
}

export interface AgentConfig {
  displayName: string;
  agentId: string;
  /** Absolute path to the agent's workspace clone.
   *  Optional — if omitted, derived from settings.workingDirBase + agent key. */
  workingDir: string;
  briefPath: string;
  globalRulesPath: string;
  chatmodeFile: string;
  ownedPaths: string[];
  branchPrefix: string;
  /** Per-agent override for max review cycles (falls back to settings.maxReviewCycles) */
  maxReviewCycles?: number;
  /** Per-agent model override. Takes priority over models.coAgent/architect.
   *  Batch assignment model overrides this if also set. */
  model?: string;
}

export interface ModelsConfig {
  architect: string;
  coAgent: string;
  fallback: string;
}

export interface NotificationsConfig {
  enabled: boolean;
}

export type ReviewMode = 'copilot' | 'architect' | 'none';

export interface SettingsConfig {
  /** Review mode: 'copilot' (default) adds GitHub Copilot as reviewer,
   *  'architect' uses Claude API for review, 'none' skips review entirely */
  reviewMode: ReviewMode;
  /** How often to poll for Copilot review completion (seconds) */
  copilotReviewPollIntervalSeconds: number;
  /** Max time to wait for Copilot review before giving up (minutes) */
  copilotReviewTimeoutMinutes: number;
  maxReviewCycles: number;
  monitorPollIntervalSeconds: number;
  claudeCliCommand?: string;
  maxRetries: number;
  retryBaseDelaySeconds: number;
  launchStaggerSeconds: number;
  maxBudgetUsd: number;
  /** Per-batch budget cap. Orchestrator stops dispatching new review cycles
   *  once the cumulative batch cost exceeds this.  Default: 50.00. */
  maxBatchBudgetUsd?: number;
  /** Lower budget cap for review fix runs (default: 2.00) */
  reviewMaxBudgetUsd?: number;
  /** Max turns for review fix runs (default: 30) */
  reviewMaxTurns?: number;
  /** Cycle threshold after which COMMENTED reviews with few remaining comments
   *  are soft-approved instead of escalated. 0 = disabled (always escalate).
   *  Default: 3 (cycles 0-2 are strict, cycle 3+ uses soft-approve logic). */
  softApproveAfterCycle?: number;
  /** Max new (non-duplicate) inline comments allowed for a soft-approve.
   *  If the non-duplicate comment count exceeds this, the review is still
   *  escalated even in late cycles.  Default: 3. */
  softApproveMaxComments?: number;
  /** Cycle threshold after which old-code nit comments are auto-skipped.
   *  Comments on unchanged files classified as NIT by Haiku are marked ☑️
   *  and excluded from the agent's feedback. 0 = disabled. Default: 3. */
  filterOldCodeAfterCycle?: number;
  /** Base directory for agent workspace clones.
   *  Can be absolute or relative to the project root.
   *  Agent workingDir is derived as: resolve(projectRoot, workingDirBase, '{projectName}-{agentKey}')
   *  Default: '../' (sibling directories to the project) */
  workingDirBase?: string;
  /** Idle timeout (minutes): orchestrator exits after this long with no activity.
   *  Resets whenever agent progress is detected (signals, state transitions, reviews).
   *  Default: 90. Set to 0 to disable. Override per-run with --timeout flag. */
  maxOrchestratorMinutes?: number;
  /** Project-specific hints for architect reviews (e.g. "DynamoDB single-table, GraphQL schema").
   *  Injected into the architect review prompt. Omit to use no project-specific hints. */
  architectReviewHints?: string;
  /** Path (relative to project root) to a markdown file containing project-specific rules,
   *  checklists, and reminders that should be injected into every agent's CLAUDE.md.
   *  Example: ".ai-team/project-rules.md". Omit to skip project-rules injection. */
  projectRulesFile?: string;
  /** Enable the consolidator agent that runs after sub-PR merges to extract shared
   *  utilities from duplicated code blocks. Default: true. Set to false to skip. */
  consolidatorEnabled?: boolean;
  /** Budget cap for the consolidator agent in USD. Default: 3.00. */
  consolidatorMaxBudgetUsd?: number;
  /** Max turns for the consolidator agent. Default: 40. */
  consolidatorMaxTurns?: number;
  /** Minimum number of files sharing a duplicated code block before the consolidator
   *  triggers. Default: 3 (i.e., same block in 3+ files). */
  consolidatorDuplicateThreshold?: number;
  /** Enable context forwarding between rounds. When true, round N+1 agents receive a
   *  summary of what round N agents accomplished (PR title, changed files, notes).
   *  Default: true. */
  contextForwardingEnabled?: boolean;
  notifications: NotificationsConfig;
}

export interface OrchestratorConfig {
  project: ProjectConfig;
  agents: Record<string, AgentConfig>;
  models: ModelsConfig;
  settings: SettingsConfig;
}

// ── Batch types ──────────────────────────────────────────────

export interface BatchAssignment {
  agent: string;
  spec: string;
  specPath: string;
  description: string;
  /** Execution round (default: 1). Assignments in the same round launch in
   *  parallel; higher rounds wait for all previous rounds to complete.
   *  Two assignments sharing a workspace MUST NOT be in the same round. */
  round?: number;
  /** Per-assignment model override. Highest priority — overrides both
   *  agent-level and global model settings. */
  model?: string;
}

export interface BatchConfig {
  name: string;
  /** Branch to create the batch branch from. Defaults to mainBranch (usually 'main'). */
  baseBranch?: string;
  description: string;
  assignments: BatchAssignment[];
}

// ── Signal types ─────────────────────────────────────────────

export interface AgentSignal {
  agent: string;
  spec: string;
  status: 'completed' | 'failed';
  branch: string;
  prUrl: string;
  timestamp: string;
  reviewCycle?: number;
  /** Unique nonce for signal dedup — orchestrator tracks which IDs it has processed */
  signalId?: string;
  notes: string;
}

// ── Orchestrator state ───────────────────────────────────────

export interface ReviewHistoryEntry {
  cycle: number;
  verdict: string;
  summary: string;
  timestamp: string;
  /** Cost of the review run in USD (architect review or agent fix run) */
  costUsd?: number;
  /** Duration of the review run in milliseconds */
  durationMs?: number;
  /** Inline comment bodies from this review cycle (for dedup across cycles) */
  commentBodies?: string[];
}

export interface OrchAgentState {
  status: 'pending' | 'launched' | 'completed' | 'reviewing' | 'awaiting-copilot' | 'approved' | 'soft-approved' | 'merged' | 'changes-requested' | 'failed' | 'max-cycles';
  lastReviewedCycle: number;
  prNumber: number | null;
  prUrl: string | null;
  reviewHistory: ReviewHistoryEntry[];
  inconclusiveRetries?: number;
  copilotReviewRequestedAt?: string;
  /** Cost of the initial agent launch in USD */
  launchCostUsd?: number;
  /** Duration of the initial agent launch in milliseconds */
  launchDurationMs?: number;
  /** Total cost across all runs (launch + reviews) in USD */
  totalCostUsd?: number;
  /** Signal IDs already processed — prevents double-processing from timestamp drift */
  processedSignalIds?: string[];
  /** PID of the currently-running review-fix agent (guards against duplicate dispatch) */
  reviewAgentPid?: number | null;
  /** Number of auto-revert retries for boundary violations (max 1 before hard fail) */
  boundaryRetries?: number;
  /** Number of automatic relaunches after the agent process died unexpectedly */
  deathRetries?: number;
  /** Emoji status tracking state for review comments on this agent's PR */
  commentReactions?: CommentReactionState[];
}

export type BatchPhase =
  | 'polling-merges'
  | 'consolidating'
  | 'validating'
  | 'validation-fixing'
  | 'validation-failed'
  | 'creating-pr'
  | 'awaiting-batch-review'
  | 'batch-review-fixing'
  | 'awaiting-ci'
  | 'complete'
  | 'awaiting-merge'
  | 'merged'
  | 'closed';

export interface OrchState {
  batchName: string;
  startedAt: string;
  agents: Record<string, OrchAgentState>;
  /** Aggregate cost for the entire batch in USD */
  totalCostUsd?: number;
  /** Per-run cost entries for this batch (replaces shared cost-ledger.jsonl) */
  costLedger?: CostLedgerEntry[];
  /** Tracks progress through the batch-finalize phase */
  batchPhase?: BatchPhase;
  /** PR number of the final batch PR (batch → main) */
  batchPRNumber?: number;
  /** URL of the final batch PR */
  batchPRUrl?: string;
  /** Current Copilot review cycle for the batch PR (Phase 3g) */
  batchReviewCycle?: number;
  /** Review history for the batch PR Copilot review loop */
  batchReviewHistory?: ReviewHistoryEntry[];
  /** Timestamp when Copilot review was last requested on the batch PR */
  batchCopilotReviewRequestedAt?: string;
  /** Current validation-fix cycle (Phase 3c auto-fix loop) */
  validationFixCycle?: number;
  /** Cumulative context summaries keyed by round number.
   *  roundSummaries[N] describes what round N agents accomplished. */
  roundSummaries?: Record<number, string>;
}

export interface ValidationResult {
  step: string;
  passed: boolean;
  output: string;
  durationMs: number;
}

// ── Batch launch state ───────────────────────────────────────

export interface LaunchStateEntry {
  agent: string;
  spec: string;
  description: string;
  branch: string;
  pid: number | null;
  logFile: string;
  signalFile: string;
  runnerPath: string;
  promptFile: string;
  claudeMdPath: string;
  startedAt: string;
  status: 'running' | 'dry-run';
}

export interface BatchState {
  batchName: string;
  batchBranch: string;
  batchFile: string;
  startedAt: string;
  agents: LaunchStateEntry[];
}

// ── Comment status tracking ──────────────────────────────────

export type CommentStatus = 'seen' | 'reviewed' | 'will-fix' | 'wont-fix' | 'fixed' | 'skipped';

export interface CommentReactionState {
  /** ID of the original review comment being tracked */
  originalCommentId: number;
  /** ID of our threaded reply comment (set after first reply is posted) */
  replyCommentId: number | null;
  /** Current status in the emoji pipeline */
  currentStatus: CommentStatus;
  /** Full history of status transitions */
  statusHistory: Array<{ status: CommentStatus; timestamp: string }>;
  /** Reason provided for wont-fix or skipped outcomes */
  reason?: string;
}

export interface CommentOutcome {
  commentId: number;
  status: 'fixed' | 'skipped' | 'wont-fix';
  reason?: string;
}

// ── Review types ─────────────────────────────────────────────

export interface ReviewIssue {
  severity: 'critical' | 'major' | 'minor';
  file: string;
  description: string;
}

export interface ArchitectVerdict {
  verdict: 'APPROVE' | 'CHANGES_REQUESTED';
  summary: string;
  issues: ReviewIssue[];
}

export interface ReviewStateEntry {
  cycle: number;
  timestamp: string;
  feedback: string;
}

export interface ReviewState {
  count: number;
  history: ReviewStateEntry[];
}

// ── Cost ledger ──────────────────────────────────────────────

export interface CostLedgerEntry {
  /** ISO timestamp of the run */
  timestamp: string;
  /** Batch this run belongs to */
  batchName: string;
  /** Agent key (e.g. 'backend', 'frontend') */
  agent: string;
  /** Spec name */
  spec: string;
  /** Type of run */
  runType: 'launch' | 'review-fix' | 'architect-review' | 'validation-fix' | 'consolidator';
  /** Review cycle number (0 for initial launch) */
  cycle: number;
  /** Cost in USD */
  costUsd: number;
  /** Duration in milliseconds */
  durationMs: number;
  /** Number of turns (for agent SDK runs) */
  numTurns?: number;
  /** Model used */
  model?: string;
}

/**
 * @deprecated The CostLedger wrapper type is no longer stored on disk.
 * The ledger is now append-only JSONL (one CostLedgerEntry per line).
 * readCostLedger() returns this shape for backward compat with query code.
 */
export interface CostLedger {
  entries: CostLedgerEntry[];
  /** Computed total of all entries */
  totalCostUsd: number;
}

// ── Log levels ───────────────────────────────────────────────

export type LogLevel = 'INFO' | 'OK' | 'WARN' | 'ERROR';
