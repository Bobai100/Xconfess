export type ModerationDecision = "allow" | "flag" | "block";

export interface ModerationCase {
  id: string;
  userId: string;
  content: string;
  policyVersion: string;
  decision: ModerationDecision;
}

export interface PolicyVersion {
  version: string;
  evaluate: (input: { content: string }) => ModerationDecision;
}

export interface RedactedCase {
  id: string;
  userId: string;
  content: string;
  policyVersion: string;
  decision: ModerationDecision;
}

export interface ReplayCaseDelta {
  caseId: string;
  from: ModerationDecision;
  to: ModerationDecision;
  changed: boolean;
}

export interface ReplayDiffReport {
  fromPolicyVersion: string;
  toPolicyVersion: string;
  total: number;
  changed: number;
  unchanged: number;
  deltas: ReplayCaseDelta[];
}

export interface ReplayOptions {
  cases: ModerationCase[];
  targetPolicy: PolicyVersion;
  authorize: (action: "replay") => boolean;
}

export interface ConfessionCorrectionInput {
  confessionId: string;
  authorId: string;
  originalText: string;
  correctedText: string;
  reason?: string;
}

export interface ConfessionCorrectionRecord {
  confessionId: string;
  authorId: string;
  originalText: string;
  correctedText: string;
  reason: string | null;
  correctedAt: string;
}

export interface ConfessionCorrectionAudit {
  confessionId: string;
  authorId: string;
  originalTextHash: string;
  correctedTextHash: string;
  reason: string | null;
  correctedAt: string;
}

export interface ConfessionCorrectionResult {
  record: ConfessionCorrectionRecord;
  audit: ConfessionCorrectionAudit;
}

export interface ConfessionCorrectionOptions {
  input: ConfessionCorrectionInput;
  authorize: (action: "correct", confessionId: string, authorId: string) => boolean;
  now?: () => Date;
}

const REDACTED = "[redacted]";

function redactId(value: string): string {
  if (!value) return REDACTED;
  return `${value.slice(0, 2)}***`;
}

/**
 * Redact identifiers and content from a moderation case so replay inputs and
 * outputs never expose live user data.
 */
export function redactCase(moderationCase: ModerationCase): RedactedCase {
  return {
    id: redactId(moderationCase.id),
    userId: redactId(moderationCase.userId),
    content: REDACTED,
    policyVersion: moderationCase.policyVersion,
    decision: moderationCase.decision,
  };
}

/**
 * Replay moderation decisions against a new policy version in isolation.
 *
 * This function is pure: it never mutates the supplied cases, never writes to
 * production decision records, and never triggers notifications. It only
 * returns a redacted diff report. Callers must be explicitly authorized.
 */
export function replayModerationDecisions(options: ReplayOptions): ReplayDiffReport {
  const { cases, targetPolicy, authorize } = options;

  if (!authorize("replay")) {
    throw new Error("Unauthorized: replay requires explicit authorization");
  }

  if (!targetPolicy || typeof targetPolicy.evaluate !== "function") {
    throw new Error("Invalid target policy: evaluate() is required");
  }

  const deltas: ReplayCaseDelta[] = [];
  let changed = 0;

  for (const moderationCase of cases) {
    const redacted = redactCase(moderationCase);
    const nextDecision = targetPolicy.evaluate({ content: moderationCase.content });
    const isChanged = nextDecision !== redacted.decision;
    if (isChanged) changed += 1;
    deltas.push({
      caseId: redacted.id,
      from: redacted.decision,
      to: nextDecision,
      changed: isChanged,
    });
  }

  const fromPolicyVersion = cases.length > 0 ? cases[0].policyVersion : "unknown";

  return {
    fromPolicyVersion,
    toPolicyVersion: targetPolicy.version,
    total: cases.length,
    changed,
    unchanged: cases.length - changed,
    deltas,
  };
}

/**
 * Deterministic, non-reversible hash of correction text for the audit trail.
 * The audit record stores only hashes so it never duplicates confession
 * content beyond the correction record itself.
 */
function hashText(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Submit an explicit correction to a published confession.
 *
 * The corrected text is kept distinct from the original publication: the
 * returned record carries both `originalText` and `correctedText`, and the
 * audit entry stores only hashes plus the author id already associated with
 * the confession. Callers must be explicitly authorized for the confession.
 *
 * Throws on unauthorized access or invalid input so callers can surface an
 * explicit failure and retry with a corrected payload.
 */
export function submitConfessionCorrection(
  options: ConfessionCorrectionOptions,
): ConfessionCorrectionResult {
  const { input, authorize, now } = options;

  if (!input || !input.confessionId || !input.authorId) {
    throw new Error("Invalid correction: confessionId and authorId are required");
  }

  if (!authorize("correct", input.confessionId, input.authorId)) {
    throw new Error("Unauthorized: correction requires explicit authorization");
  }

  const originalText = typeof input.originalText === "string" ? input.originalText : "";
  const correctedText = typeof input.correctedText === "string" ? input.correctedText.trim() : "";

  if (!correctedText) {
    throw new Error("Invalid correction: correctedText must not be empty");
  }

  if (correctedText === originalText.trim()) {
    throw new Error("Invalid correction: correctedText must differ from the original");
  }

  const correctedAt = (now ? now() : new Date()).toISOString();
  const reason = input.reason && input.reason.trim() ? input.reason.trim() : null;

  return {
    record: {
      confessionId: input.confessionId,
      authorId: input.authorId,
      originalText,
      correctedText,
      reason,
      correctedAt,
    },
    audit: {
      confessionId: input.confessionId,
      authorId: input.authorId,
      originalTextHash: hashText(originalText),
      correctedTextHash: hashText(correctedText),
      reason,
      correctedAt,
    },
  };
}
