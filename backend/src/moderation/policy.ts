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

export type DraftStatus = "draft" | "published";

export interface DraftRecord {
  id: string;
  ownerId: string;
  status: DraftStatus;
  content: string;
  /** ISO-8601 timestamp of the retention deadline, or null when unset. */
  expiresAt: string | null;
}

export interface SetDraftExpiryInput {
  draft: DraftRecord;
  requesterId: string;
  /** ISO-8601 timestamp, or null to clear the deadline. */
  expiresAt: string | null;
  now?: Date;
}

export interface DraftExpiryResult {
  draft: DraftRecord;
  expiresAt: string | null;
}

export class DraftExpiryError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_found"
      | "forbidden"
      | "not_a_draft"
      | "invalid_deadline",
  ) {
    super(message);
    this.name = "DraftExpiryError";
  }
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
 * Set or clear the retention deadline on a user-owned draft.
 *
 * Authorization: only the draft owner may set the deadline. Published content
 * is never eligible for expiry. Deadlines must be valid ISO-8601 timestamps in
 * the future; malformed or past values are rejected with a typed error so the
 * API layer can map them to 4xx responses. The input draft is not mutated; a
 * new record is returned so callers can persist it idempotently.
 */
export function setDraftExpiry(input: SetDraftExpiryInput): DraftExpiryResult {
  const { draft, requesterId, expiresAt } = input;
  const now = input.now ?? new Date();

  if (!draft) {
    throw new DraftExpiryError("Draft not found", "not_found");
  }

  if (draft.ownerId !== requesterId) {
    throw new DraftExpiryError(
      "Only the draft owner may set an expiry deadline",
      "forbidden",
    );
  }

  if (draft.status !== "draft") {
    throw new DraftExpiryError(
      "Published content cannot be scheduled for expiry",
      "not_a_draft",
    );
  }

  if (expiresAt === null) {
    return { draft: { ...draft, expiresAt: null }, expiresAt: null };
  }

  if (typeof expiresAt !== "string" || expiresAt.trim() === "") {
    throw new DraftExpiryError("Deadline must be an ISO-8601 timestamp", "invalid_deadline");
  }

  const parsed = new Date(expiresAt);
  if (Number.isNaN(parsed.getTime())) {
    throw new DraftExpiryError("Deadline must be an ISO-8601 timestamp", "invalid_deadline");
  }

  if (parsed.getTime() <= now.getTime()) {
    throw new DraftExpiryError("Deadline must be in the future", "invalid_deadline");
  }

  const normalized = parsed.toISOString();
  return { draft: { ...draft, expiresAt: normalized }, expiresAt: normalized };
}
