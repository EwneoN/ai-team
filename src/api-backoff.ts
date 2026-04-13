/**
 * Tracks consecutive GitHub API failures per operation and computes
 * exponential backoff delays. Prevents the orchestrator from burning
 * poll cycles when GitHub is down or rate-limited.
 */

import { agentLog } from './logger.js';

interface OperationState {
  consecutiveFailures: number;
  lastFailureAt: number;
}

const WARN_THRESHOLD = 3;
const MAX_BACKOFF_MS = 5 * 60_000; // 5 minutes
const BASE_BACKOFF_MS = 5_000;     // 5 seconds

export class ApiBackoff {
  private ops = new Map<string, OperationState>();

  recordFailure(operation: string): void {
    const state = this.ops.get(operation) ?? { consecutiveFailures: 0, lastFailureAt: 0 };
    state.consecutiveFailures++;
    state.lastFailureAt = Date.now();
    this.ops.set(operation, state);

    if (state.consecutiveFailures === WARN_THRESHOLD) {
      agentLog('orchestrator', `GitHub API degradation detected: ${operation} failed ${state.consecutiveFailures} consecutive times`, 'WARN');
    } else if (state.consecutiveFailures > WARN_THRESHOLD && state.consecutiveFailures % 5 === 0) {
      agentLog('orchestrator', `GitHub API still degraded: ${operation} failed ${state.consecutiveFailures} consecutive times`, 'WARN');
    }
  }

  recordSuccess(operation: string): void {
    const state = this.ops.get(operation);
    if (state && state.consecutiveFailures > 0) {
      if (state.consecutiveFailures >= WARN_THRESHOLD) {
        agentLog('orchestrator', `GitHub API recovered: ${operation} (was failing for ${state.consecutiveFailures} consecutive calls)`, 'INFO');
      }
      state.consecutiveFailures = 0;
      this.ops.set(operation, state);
    }
  }

  /** Recommended extra backoff delay (ms) based on the most-degraded operation. */
  getBackoffMs(): number {
    let maxDelay = 0;
    for (const [, state] of this.ops) {
      if (state.consecutiveFailures >= WARN_THRESHOLD) {
        const delay = Math.min(
          BASE_BACKOFF_MS * Math.pow(2, state.consecutiveFailures - WARN_THRESHOLD),
          MAX_BACKOFF_MS,
        );
        maxDelay = Math.max(maxDelay, delay);
      }
    }
    return maxDelay;
  }

  /** Whether any operation has hit the degradation threshold. */
  isDegraded(): boolean {
    for (const [, state] of this.ops) {
      if (state.consecutiveFailures >= WARN_THRESHOLD) return true;
    }
    return false;
  }

  /** Summary of degraded operations for log messages. */
  getDegradedSummary(): string {
    const degraded: string[] = [];
    for (const [op, state] of this.ops) {
      if (state.consecutiveFailures >= WARN_THRESHOLD) {
        degraded.push(`${op}: ${state.consecutiveFailures} failures`);
      }
    }
    return degraded.join(', ');
  }
}
