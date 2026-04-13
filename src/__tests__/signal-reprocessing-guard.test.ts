/**
 * Tests for the signal re-processing guard in processNewSignal().
 *
 * These tests verify that:
 *  1. A signalId is recorded BEFORE boundary checks run, so boundary-violation
 *     early-returns don't allow the same signal to be processed twice.
 *  2. The reviewAgentPid guard in handleAgent() prevents processNewSignal()
 *     from running while a review agent is still alive.
 *  3. reviewAgentPid is only cleared after boundary checks pass.
 *
 * Since processNewSignal/handleAgent are internal (not exported), these tests
 * read the source code and verify structural invariants. For behavioural
 * validation, a manual dry-run script is recommended.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Read the orchestrate source to structurally verify the fix ordering.
const orchestrateSrc = readFileSync(
  join(import.meta.dirname, '..', 'commands', 'orchestrate.ts'),
  'utf-8',
);

describe('processNewSignal — signalId registration order', () => {
  it('records signalId BEFORE the boundary check block', () => {
    // Find the positions of key markers in the source
    const alreadyProcessedGuard = orchestrateSrc.indexOf('if (alreadyProcessed)');
    const dedupFallback = orchestrateSrc.indexOf('return { activity: false }', alreadyProcessedGuard);
    const signalIdPush = orchestrateSrc.indexOf('processedSignalIds.push(signal.signalId)', alreadyProcessedGuard);
    const boundaryCheck = orchestrateSrc.indexOf('Post-execution boundary check', alreadyProcessedGuard);

    expect(alreadyProcessedGuard).toBeGreaterThan(-1);
    expect(dedupFallback).toBeGreaterThan(-1);
    expect(signalIdPush).toBeGreaterThan(-1);
    expect(boundaryCheck).toBeGreaterThan(-1);

    // signalId push must come AFTER the dedup guard block
    expect(signalIdPush).toBeGreaterThan(dedupFallback);
    // signalId push must come BEFORE the boundary check
    expect(signalIdPush).toBeLessThan(boundaryCheck);
  });

  it('persists state (saveOrchState) immediately after signalId push', () => {
    const signalIdPush = orchestrateSrc.indexOf('processedSignalIds.push(signal.signalId)');
    // Find the next saveOrchState call after the push
    const nextSave = orchestrateSrc.indexOf('saveOrchState(batchName, orchState)', signalIdPush);
    // Find the next substantive code marker — the boundary check
    const boundaryCheck = orchestrateSrc.indexOf('Post-execution boundary check', signalIdPush);

    expect(nextSave).toBeGreaterThan(signalIdPush);
    // saveOrchState must be between the push and the boundary check
    expect(nextSave).toBeLessThan(boundaryCheck);
  });

  it('does NOT have a second signalId push after the boundary check', () => {
    const boundaryCheck = orchestrateSrc.indexOf('Post-execution boundary check');
    const routeByReview = orchestrateSrc.indexOf('routeByReviewMode(ctx, prNumber, signalCycle)');

    // Search for any processedSignalIds.push between boundary check and routeByReviewMode
    const regionAfterBoundary = orchestrateSrc.slice(boundaryCheck, routeByReview);
    expect(regionAfterBoundary).not.toContain('processedSignalIds.push');
  });
});

describe('processNewSignal — reviewAgentPid clearing order', () => {
  it('clears reviewAgentPid AFTER the boundary check, not before', () => {
    const alreadyProcessedGuard = orchestrateSrc.indexOf('if (alreadyProcessed)');
    const pidClear = orchestrateSrc.indexOf('agentState.reviewAgentPid = null', alreadyProcessedGuard);
    const boundaryCheck = orchestrateSrc.indexOf('Post-execution boundary check', alreadyProcessedGuard);
    const routeByReview = orchestrateSrc.indexOf('routeByReviewMode(ctx, prNumber, signalCycle)');

    expect(pidClear).toBeGreaterThan(-1);
    expect(boundaryCheck).toBeGreaterThan(-1);
    expect(routeByReview).toBeGreaterThan(-1);

    // PID clear must come AFTER the boundary check block
    expect(pidClear).toBeGreaterThan(boundaryCheck);
    // PID clear must come BEFORE routeByReviewMode
    expect(pidClear).toBeLessThan(routeByReview);
  });
});

describe('handleAgent — reviewAgentPid guard on changes-requested', () => {
  it('checks reviewAgentPid before calling processNewSignal in changes-requested case', () => {
    // Find the changes-requested case in handleAgent
    const handleAgentStart = orchestrateSrc.indexOf('async function handleAgent(');
    const changesRequestedCase = orchestrateSrc.indexOf("case 'changes-requested':", handleAgentStart);
    // The next 'case' or 'default' after changes-requested tells us the boundary
    const nextCase = orchestrateSrc.indexOf('default:', changesRequestedCase);

    // Region for the changes-requested case
    const caseRegion = orchestrateSrc.slice(changesRequestedCase, nextCase);

    // Must contain reviewAgentPid check
    expect(caseRegion).toContain('reviewAgentPid');
    expect(caseRegion).toContain('isProcessRunning');

    // The PID check must come BEFORE processNewSignal
    const pidCheckPos = caseRegion.indexOf('reviewAgentPid');
    const processCallPos = caseRegion.indexOf('processNewSignal(ctx)');
    expect(pidCheckPos).toBeLessThan(processCallPos);
  });
});
