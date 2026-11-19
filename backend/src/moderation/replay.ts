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

/**
 * Confession correction workflow.
 *
 * Lets the author of a published confession submit a correction while:
 * - keeping the corrected text clearly distinguished from the original
 *   published text (the original is never overwritten),
 * - recording a privacy-safe audit entry (only redacted identifiers and
 *   content hashes/lengths, never raw author data or raw text),
 * - defining explicit success, authorization/validation, and failure/retry
 *   semantics for invalid or failed correction operations.
 */
export interface PublishedConfession {
  confessionId: string;
  authorId: string;
  /** The original published text. Immutable once published. */
  originalText: string;
  /** The current corrected text, if a correction has been applied. */
  correctedText?: string;
  /** Monotonic revision counter; 0 means no correction applied yet. */
  revision: number;
}

export interface CorrectionAuditEntry {
  confessionId: string;
  authorRef: string;
  originalContentRef: string;
  correctedContentRef: string;
  originalLength: number;
  correctedLength: number;
  revision: number;
  /** ISO timestamp of when the correction was recorded. */
  recordedAt: string;
}

export interface CorrectionResult {
  status: 'applied';
  confession: PublishedConfession;
  audit: CorrectionAuditEntry;
}

export class CorrectionAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorrectionAuthorizationError';
  }
}

export class CorrectionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorrectionValidationError';
  }
}

export class CorrectionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorrectionConflictError';
  }
}

export interface CorrectionStore {
  /** Persists the corrected confession and its audit entry atomically. */
  saveCorrection(
    confession: PublishedConfession,
    audit: CorrectionAuditEntry,
  ): Promise<void>;
}

export interface SubmitCorrectionOptions {
  /** Caller must be the author of the confession. */
  requesterId: string;
  /** The confession being corrected. Never mutated. */
  confession: PublishedConfession;
  /** The proposed corrected text. */
  correctedText: string;
  /** Revision the caller last observed; guards against lost updates. */
  expectedRevision: number;
  /** Persistence boundary for the correction + audit record. */
  store: CorrectionStore;
  /** Injectable clock for deterministic audit timestamps. */
  now?: () => Date;
}

const MAX_CORRECTION_LENGTH = 10_000;

/**
 * Submits an author correction to a published confession.
 *
 * Success: returns the updated confession (with `correctedText` set and
 * `revision` incremented) plus a privacy-safe audit entry.
 *
 * Authorization: only the confession author may submit a correction.
 *
 * Validation: the corrected text must be non-empty, within the length limit,
 * and actually differ from the currently published text.
 *
 * Failure/retry: a stale `expectedRevision` raises a conflict so the caller
 * can re-read and retry; a persistence failure propagates so the caller can
 * retry the whole operation idempotently (the original text is untouched).
 */
export async function submitConfessionCorrection(
  options: SubmitCorrectionOptions,
): Promise<CorrectionResult> {
  const { requesterId, confession, correctedText, expectedRevision, store, now } = options;

  if (!requesterId || requesterId !== confession.authorId) {
    throw new CorrectionAuthorizationError(
      'Only the confession author may submit a correction',
    );
  }

  if (!store || typeof store.saveCorrection !== 'function') {
    throw new CorrectionValidationError('A correction store is required');
  }

  if (typeof correctedText !== 'string' || correctedText.trim().length === 0) {
    throw new CorrectionValidationError('Corrected text must not be empty');
  }

  if (correctedText.length > MAX_CORRECTION_LENGTH) {
    throw new CorrectionValidationError(
      `Corrected text must be at most ${MAX_CORRECTION_LENGTH} characters`,
    );
  }

  if (expectedRevision !== confession.revision) {
    throw new CorrectionConflictError(
      'Confession was modified since it was read; re-read and retry',
    );
  }

  const currentText = confession.correctedText ?? confession.originalText;
  if (correctedText === currentText) {
    throw new CorrectionValidationError(
      'Corrected text must differ from the currently published text',
    );
  }

  const revision = confession.revision + 1;
  const updatedConfession: PublishedConfession = {
    ...confession,
    correctedText,
    revision,
  };

  const recordedAt = (now ? now() : new Date()).toISOString();
  const audit: CorrectionAuditEntry = {
    confessionId: redactIdentifier(confession.confessionId),
    authorRef: redactIdentifier(confession.authorId),
    originalContentRef: redactIdentifier(confession.originalText),
    correctedContentRef: redactIdentifier(correctedText),
    originalLength: confession.originalText.length,
    correctedLength: correctedText.length,
    revision,
    recordedAt,
  };

  await store.saveCorrection(updatedConfession, audit);

  return { status: 'applied', confession: updatedConfession, audit };
}
