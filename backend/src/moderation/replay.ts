import { createHash } from 'crypto';

export interface ModerationCase {
  caseId: string;
  userId: string;
  content: string;
  policyVersion: string;
  decision: ModerationDecision;
}

export type ModerationDecision = 'allow' | 'flag' | 'remove';

export interface PolicyEvaluator {
  version: string;
  evaluate(input: { content: string }): ModerationDecision;
}

export interface RedactedCase {
  caseId: string;
  userRef: string;
  contentRef: string;
  contentLength: number;
  previousDecision: ModerationDecision;
  replayedDecision: ModerationDecision;
  changed: boolean;
}

export interface ReplayDiffReport {
  targetPolicyVersion: string;
  totalCases: number;
  changedCount: number;
  unchangedCount: number;
  transitionCounts: Record<string, number>;
  cases: RedactedCase[];
}

export class ReplayAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayAuthorizationError';
  }
}

export class ReplayPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayPolicyError';
  }
}

export interface ReplayOptions {
  /** Caller must hold the moderation-replay capability. */
  authorized: boolean;
  /** Selected cases to replay. Never mutated. */
  cases: readonly ModerationCase[];
  /** Evaluator for the new policy version. */
  evaluator: PolicyEvaluator;
}

function redactIdentifier(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

/**
 * Replays moderation decisions against a new policy version in isolation.
 *
 * Guarantees:
 * - Input cases are treated as read-only; nothing is mutated.
 * - No notifications are dispatched and no production decision records are written.
 * - Identifiers and content are redacted in the emitted report.
 */
export function replayModerationDecisions(options: ReplayOptions): ReplayDiffReport {
  const { authorized, cases, evaluator } = options;

  if (!authorized) {
    throw new ReplayAuthorizationError(
      'Replay requires explicit moderation-replay authorization',
    );
  }

  if (!evaluator || typeof evaluator.evaluate !== 'function') {
    throw new ReplayPolicyError('A policy evaluator is required for replay');
  }

  const targetPolicyVersion = evaluator.version;
  if (!targetPolicyVersion) {
    throw new ReplayPolicyError('Policy evaluator must declare a version');
  }

  const redactedCases: RedactedCase[] = [];
  const transitionCounts: Record<string, number> = {};
  let changedCount = 0;

  for (const moderationCase of cases) {
    const replayedDecision = evaluator.evaluate({ content: moderationCase.content });
    const changed = replayedDecision !== moderationCase.decision;

    if (changed) {
      changedCount += 1;
      const key = `${moderationCase.decision}->${replayedDecision}`;
      transitionCounts[key] = (transitionCounts[key] ?? 0) + 1;
    }

    redactedCases.push({
      caseId: redactIdentifier(moderationCase.caseId),
      userRef: redactIdentifier(moderationCase.userId),
      contentRef: redactIdentifier(moderationCase.content),
      contentLength: moderationCase.content.length,
      previousDecision: moderationCase.decision,
      replayedDecision,
      changed,
    });
  }

  return {
    targetPolicyVersion,
    totalCases: redactedCases.length,
    changedCount,
    unchangedCount: redactedCases.length - changedCount,
    transitionCounts,
    cases: redactedCases,
  };
}
