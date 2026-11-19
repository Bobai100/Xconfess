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

export const COLLECTION_MAX_NAME_LENGTH = 80;
export const COLLECTION_MAX_ITEMS = 500;

export type CollectionVisibility = "private" | "public";

export interface BookmarkCollection {
  id: string;
  ownerId: string;
  name: string;
  visibility: CollectionVisibility;
  itemIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateCollectionInput {
  ownerId: string;
  name: string;
  visibility?: CollectionVisibility;
  now?: Date;
}

export interface AddCollectionItemInput {
  collection: BookmarkCollection;
  ownerId: string;
  itemId: string;
  now?: Date;
}

export type CollectionErrorCode =
  | "invalid_name"
  | "invalid_visibility"
  | "invalid_item"
  | "collection_full"
  | "unauthorized"
  | "duplicate_item";

export class CollectionError extends Error {
  readonly code: CollectionErrorCode;

  constructor(code: CollectionErrorCode, message: string) {
    super(message);
    this.name = "CollectionError";
    this.code = code;
  }
}

function normalizeCollectionName(name: string): string {
  const normalized = typeof name === "string" ? name.trim() : "";
  if (!normalized || normalized.length > COLLECTION_MAX_NAME_LENGTH) {
    throw new CollectionError("invalid_name", "Collection name is empty or too long");
  }
  return normalized;
}

function normalizeCollectionVisibility(
  visibility: CollectionVisibility | undefined,
): CollectionVisibility {
  if (visibility === undefined) return "private";
  if (visibility !== "private" && visibility !== "public") {
    throw new CollectionError("invalid_visibility", "Collection visibility is invalid");
  }
  return visibility;
}

/**
 * Create a bookmark collection owned by a single account. Collections default
 * to private so they are never exposed publicly without an explicit opt-in.
 */
export function createCollection(input: CreateCollectionInput): BookmarkCollection {
  const now = input.now ?? new Date();
  const name = normalizeCollectionName(input.name);
  const visibility = normalizeCollectionVisibility(input.visibility);
  return {
    id: `collection_${input.ownerId}_${now.getTime()}`,
    ownerId: input.ownerId,
    name,
    visibility,
    itemIds: [],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

/**
 * Add an item to a collection. Only the owning account may mutate the
 * collection; items are de-duplicated and the collection is size-capped.
 */
export function addCollectionItem(input: AddCollectionItemInput): BookmarkCollection {
  const { collection, ownerId, itemId } = input;
  const now = input.now ?? new Date();

  if (!collection || collection.ownerId !== ownerId) {
    throw new CollectionError("unauthorized", "Unauthorized: only the owner may modify a collection");
  }
  const normalizedItem = typeof itemId === "string" ? itemId.trim() : "";
  if (!normalizedItem) {
    throw new CollectionError("invalid_item", "Collection item id is empty");
  }
  if (collection.itemIds.includes(normalizedItem)) {
    throw new CollectionError("duplicate_item", "Item is already in the collection");
  }
  if (collection.itemIds.length >= COLLECTION_MAX_ITEMS) {
    throw new CollectionError("collection_full", "Collection has reached its item limit");
  }

  return {
    ...collection,
    itemIds: [...collection.itemIds, normalizedItem],
    updatedAt: now.toISOString(),
  };
}

export const ANNOTATION_MAX_LENGTH = 2000;

export interface ReaderAnnotation {
  id: string;
  ownerId: string;
  confessionId: string;
  ciphertext: string;
  createdAt: string;
  updatedAt: string;
}

export interface AnnotationCipher {
  encrypt: (plaintext: string) => string;
  decrypt: (ciphertext: string) => string;
}

export interface CreateAnnotationInput {
  ownerId: string;
  confessionId: string;
  note: string;
  cipher: AnnotationCipher;
  now?: Date;
}

export interface UpdateAnnotationInput {
  annotation: ReaderAnnotation;
  ownerId: string;
  note: string;
  cipher: AnnotationCipher;
  now?: Date;
}

export interface ReadAnnotationInput {
  annotation: ReaderAnnotation;
  ownerId: string;
  cipher: AnnotationCipher;
}

export interface DeleteAnnotationInput {
  annotation: ReaderAnnotation;
  ownerId: string;
}

export interface AnnotationExportOptions {
  includeAnnotations?: boolean;
}

export type AnnotationErrorCode =
  | "invalid_note"
  | "invalid_confession"
  | "unauthorized"
  | "encryption_failed"
  | "decryption_failed";

export class AnnotationError extends Error {
  readonly code: AnnotationErrorCode;

  constructor(code: AnnotationErrorCode, message: string) {
    super(message);
    this.name = "AnnotationError";
    this.code = code;
  }
}

function normalizeAnnotationNote(note: string): string {
  const normalized = typeof note === "string" ? note.trim() : "";
  if (!normalized || normalized.length > ANNOTATION_MAX_LENGTH) {
    throw new AnnotationError("invalid_note", "Annotation note is empty or too long");
  }
  return normalized;
}

function assertAnnotationOwner(annotation: ReaderAnnotation, ownerId: string): void {
  if (!annotation || annotation.ownerId !== ownerId) {
    throw new AnnotationError(
      "unauthorized",
      "Unauthorized: only the owning account may access this annotation",
    );
  }
}

/**
 * Create a private reader annotation attached to a saved confession. The note
 * is encrypted at rest and stored only on the owning account; it is never
 * written to public APIs, search indexes, analytics, notifications, or exports.
 */
export function createAnnotation(input: CreateAnnotationInput): ReaderAnnotation {
  const now = input.now ?? new Date();
  const confessionId = typeof input.confessionId === "string" ? input.confessionId.trim() : "";
  if (!confessionId) {
    throw new AnnotationError("invalid_confession", "Annotation must reference a saved confession");
  }
  const note = normalizeAnnotationNote(input.note);

  let ciphertext: string;
  try {
    ciphertext = input.cipher.encrypt(note);
  } catch {
    throw new AnnotationError("encryption_failed", "Failed to encrypt annotation note");
  }
  if (typeof ciphertext !== "string" || !ciphertext) {
    throw new AnnotationError("encryption_failed", "Failed to encrypt annotation note");
  }

  return {
    id: `annotation_${input.ownerId}_${now.getTime()}`,
    ownerId: input.ownerId,
    confessionId,
    ciphertext,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
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
