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
