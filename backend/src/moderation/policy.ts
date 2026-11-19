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

export type TopicStatus = "pending" | "approved" | "rejected" | "archived";

export interface Topic {
  id: string;
  slug: string;
  label: string;
  aliases: string[];
  status: TopicStatus;
  createdAt: string;
  updatedAt: string;
}

export interface TopicDirectoryEntry {
  id: string;
  slug: string;
  label: string;
  aliases: string[];
}

export interface CreateTopicInput {
  slug: string;
  label: string;
  aliases?: string[];
  now?: Date;
}

export interface TransitionTopicInput {
  topic: Topic;
  to: TopicStatus;
  authorize: (action: "moderate") => boolean;
  now?: Date;
}

export type TopicErrorCode =
  | "invalid_slug"
  | "invalid_label"
  | "invalid_alias"
  | "duplicate_topic"
  | "unknown_topic"
  | "unauthorized"
  | "invalid_transition";

export class TopicError extends Error {
  readonly code: TopicErrorCode;

  constructor(code: TopicErrorCode, message: string) {
    super(message);
    this.name = "TopicError";
    this.code = code;
  }
}

const TOPIC_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TOPIC_MAX_SLUG_LENGTH = 64;
const TOPIC_MAX_LABEL_LENGTH = 80;
const TOPIC_MAX_ALIASES = 10;

const TOPIC_TRANSITIONS: Record<TopicStatus, TopicStatus[]> = {
  pending: ["approved", "rejected"],
  approved: ["archived"],
  rejected: ["pending"],
  archived: ["pending"],
};

function normalizeTopicSlug(slug: string): string {
  if (typeof slug !== "string") {
    throw new TopicError("invalid_slug", "Topic slug must be a string");
  }
  const normalized = slug.trim().toLowerCase();
  if (!normalized || normalized.length > TOPIC_MAX_SLUG_LENGTH) {
    throw new TopicError("invalid_slug", "Topic slug is empty or too long");
  }
  if (!TOPIC_SLUG_PATTERN.test(normalized)) {
    throw new TopicError("invalid_slug", "Topic slug must be lowercase kebab-case");
  }
  return normalized;
}

function normalizeTopicAliases(aliases: string[] | undefined): string[] {
  if (aliases === undefined) return [];
  if (!Array.isArray(aliases)) {
    throw new TopicError("invalid_alias", "Topic aliases must be an array");
  }
  if (aliases.length > TOPIC_MAX_ALIASES) {
    throw new TopicError("invalid_alias", `Topic allows at most ${TOPIC_MAX_ALIASES} aliases`);
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const alias of aliases) {
    const normalized = typeof alias === "string" ? alias.trim().toLowerCase() : "";
    if (!normalized) {
      throw new TopicError("invalid_alias", "Topic aliases must not be empty");
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

/**
 * Create a topic in the pending moderation state with a stable slug identifier
 * and normalized aliases. Rejects duplicate slugs/aliases against existing
 * topics so identifiers stay stable and unambiguous.
 */
export function createTopic(input: CreateTopicInput, existing: Topic[] = []): Topic {
  const now = input.now ?? new Date();
  const slug = normalizeTopicSlug(input.slug);
  const label = typeof input.label === "string" ? input.label.trim() : "";
  if (!label || label.length > TOPIC_MAX_LABEL_LENGTH) {
    throw new TopicError("invalid_label", "Topic label is empty or too long");
  }
  const aliases = normalizeTopicAliases(input.aliases);

  const taken = new Set<string>();
  for (const topic of existing) {
    taken.add(topic.slug);
    for (const alias of topic.aliases) taken.add(alias);
  }
  if (taken.has(slug) || aliases.some((alias) => taken.has(alias))) {
    throw new TopicError("duplicate_topic", "Topic slug or alias is already in use");
  }

  return {
    id: `topic_${slug}`,
    slug,
    label,
    aliases,
    status: "pending",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

/**
 * Apply a moderation lifecycle transition. Requires explicit authorization and
 * only permits transitions defined by the lifecycle graph.
 */
export function transitionTopic(input: TransitionTopicInput): Topic {
  const { topic, to, authorize } = input;
  const now = input.now ?? new Date();

  if (!authorize("moderate")) {
    throw new TopicError("unauthorized", "Unauthorized: topic moderation requires authorization");
  }
  if (!topic || !TOPIC_TRANSITIONS[topic.status]) {
    throw new TopicError("unknown_topic", "Topic does not exist");
  }
  if (!TOPIC_TRANSITIONS[topic.status].includes(to)) {
    throw new TopicError(
      "invalid_transition",
      `Cannot transition topic from ${topic.status} to ${to}`,
    );
  }

  return { ...topic, status: to, updatedAt: now.toISOString() };
}

/**
 * Build the public topic directory. Only approved topics are exposed; pending,
 * rejected, and archived topics are never surfaced to public browse clients.
 */
export function listPublicTopics(topics: Topic[]): TopicDirectoryEntry[] {
  return topics
    .filter((topic) => topic.status === "approved")
    .map((topic) => ({
      id: topic.id,
      slug: topic.slug,
      label: topic.label,
      aliases: [...topic.aliases],
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Resolve a topic by its stable slug or any alias, restricted to public
 * (approved) topics so private or deleted content is never reachable.
 */
export function resolvePublicTopic(topics: Topic[], identifier: string): TopicDirectoryEntry | null {
  const key = typeof identifier === "string" ? identifier.trim().toLowerCase() : "";
  if (!key) return null;
  const match = topics.find(
    (topic) =>
      topic.status === "approved" && (topic.slug === key || topic.aliases.includes(key)),
  );
  if (!match) return null;
  return { id: match.id, slug: match.slug, label: match.label, aliases: [...match.aliases] };
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
  const closed = now.getTime() >= new Date(poll.closesAt).getTime();

  return {
    pollId: poll.id,
    totalVotes,
    closed,
    options: poll.options.map((option) => {
      const votes = counts.get(option.id) ?? 0;
      return {
        optionId: option.id,
        label: option.label,
        votes,
        percentage: totalVotes === 0 ? 0 : Math.round((votes / totalVotes) * 100),
      };
    }),
  };
}
