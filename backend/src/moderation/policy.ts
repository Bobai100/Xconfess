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

export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 6;
export const POLL_MAX_OPTION_LENGTH = 120;
export const POLL_MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

export interface PollOption {
  id: string;
  label: string;
}

export interface Poll {
  id: string;
  threadId: string;
  options: PollOption[];
  closesAt: string;
  createdAt: string;
}

export interface PollVote {
  pollId: string;
  userId: string;
  optionId: string;
  createdAt: string;
}

export interface PollResultOption {
  optionId: string;
  label: string;
  votes: number;
  percentage: number;
}

export interface PollResults {
  pollId: string;
  totalVotes: number;
  closed: boolean;
  options: PollResultOption[];
}

export interface CreatePollInput {
  threadId: string;
  options: string[];
  closesAt: string;
  now?: Date;
}

export interface CastVoteInput {
  poll: Poll;
  existingVotes: PollVote[];
  userId: string;
  optionId: string;
  now?: Date;
}

export type PollErrorCode =
  | "invalid_options"
  | "invalid_close_time"
  | "poll_closed"
  | "unknown_option"
  | "already_voted";

export class PollError extends Error {
  readonly code: PollErrorCode;

  constructor(code: PollErrorCode, message: string) {
    super(message);
    this.name = "PollError";
    this.code = code;
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
 * Validate and normalize poll options for a confession thread. Enforces a
 * bounded option count, non-empty unique labels, and a bounded label length.
 */
export function normalizePollOptions(options: string[]): PollOption[] {
  if (!Array.isArray(options)) {
    throw new PollError("invalid_options", "Poll options must be an array");
  }

  const trimmed = options.map((option) => (typeof option === "string" ? option.trim() : ""));

  if (trimmed.length < POLL_MIN_OPTIONS || trimmed.length > POLL_MAX_OPTIONS) {
    throw new PollError(
      "invalid_options",
      `Poll requires between ${POLL_MIN_OPTIONS} and ${POLL_MAX_OPTIONS} options`,
    );
  }

  const seen = new Set<string>();
  return trimmed.map((label, index) => {
    if (!label) {
      throw new PollError("invalid_options", "Poll options must not be empty");
    }
    if (label.length > POLL_MAX_OPTION_LENGTH) {
      throw new PollError(
        "invalid_options",
        `Poll options must be at most ${POLL_MAX_OPTION_LENGTH} characters`,
      );
    }
    const key = label.toLowerCase();
    if (seen.has(key)) {
      throw new PollError("invalid_options", "Poll options must be unique");
    }
    seen.add(key);
    return { id: `opt_${index + 1}`, label };
  });
}

/**
 * Create a poll for a confession thread with an explicit, bounded close time.
 * The close time must be in the future and within the maximum poll duration.
 */
export function createPoll(input: CreatePollInput): Poll {
  const now = input.now ?? new Date();
  const options = normalizePollOptions(input.options);
  const closesAt = new Date(input.closesAt);

  if (Number.isNaN(closesAt.getTime())) {
    throw new PollError("invalid_close_time", "Poll close time is invalid");
  }
  if (closesAt.getTime() <= now.getTime()) {
    throw new PollError("invalid_close_time", "Poll close time must be in the future");
  }
  if (closesAt.getTime() - now.getTime() > POLL_MAX_DURATION_MS) {
    throw new PollError("invalid_close_time", "Poll close time exceeds the maximum duration");
  }

  return {
    id: `poll_${input.threadId}`,
    threadId: input.threadId,
    options,
    closesAt: closesAt.toISOString(),
    createdAt: now.toISOString(),
  };
}

/**
 * Cast a vote with one-vote-per-user semantics. Rejects votes after the close
 * time, votes for unknown options, and repeat votes from the same user.
 */
export function castPollVote(input: CastVoteInput): PollVote {
  const now = input.now ?? new Date();
  const { poll, existingVotes, userId, optionId } = input;

  if (!userId) {
    throw new PollError("already_voted", "A user identity is required to vote");
  }
  if (now.getTime() >= new Date(poll.closesAt).getTime()) {
    throw new PollError("poll_closed", "Poll is closed");
  }
  if (!poll.options.some((option) => option.id === optionId)) {
    throw new PollError("unknown_option", "Selected poll option does not exist");
  }
  if (existingVotes.some((vote) => vote.pollId === poll.id && vote.userId === userId)) {
    throw new PollError("already_voted", "User has already voted in this poll");
  }

  return {
    pollId: poll.id,
    userId,
    optionId,
    createdAt: now.toISOString(),
  };
}

/**
 * Aggregate poll results without exposing voter identity. Only counts are
 * returned; individual votes are never surfaced.
 */
export function aggregatePollResults(
  poll: Poll,
  votes: PollVote[],
  now: Date = new Date(),
): PollResults {
  const pollVotes = votes.filter((vote) => vote.pollId === poll.id);
  const counts = new Map<string, number>();
  for (const option of poll.options) counts.set(option.id, 0);
  for (const vote of pollVotes) {
    if (counts.has(vote.optionId)) {
      counts.set(vote.optionId, (counts.get(vote.optionId) ?? 0) + 1);
    }
  }

  const totalVotes = pollVotes.length;
  return {
    pollId: poll.id,
    totalVotes,
    closed: now.getTime() >= new Date(poll.closesAt).getTime(),
    options: poll.options.map((option) => {
      const optionVotes = counts.get(option.id) ?? 0;
      return {
        optionId: option.id,
        label: option.label,
        votes: optionVotes,
        percentage: totalVotes === 0 ? 0 : Math.round((optionVotes / totalVotes) * 100),
      };
    }),
  };
}
