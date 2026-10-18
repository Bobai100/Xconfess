/**
 * Typing and presence signal management.
 *
 * Design goals (issue #254):
 * - Opt-in visibility: users must explicitly enable sharing of typing/presence.
 * - Coarse timing: activity events are bucketed to avoid fine-grained behavioral
 *   pattern exposure.
 * - Server-side expiry: presence and typing state expire automatically.
 * - Reconnect cleanup: stale state is removed on disconnect/reconnect.
 * - No durable message content is ever attached to these signals.
 */

export interface TypingSignalOptions {
  /** How long a typing signal remains valid before server-side expiry (ms). */
  typingTtlMs?: number;
  /** How long a presence signal remains valid before server-side expiry (ms). */
  presenceTtlMs?: number;
  /** Bucket size used to coarsen activity timestamps (ms). */
  coarseBucketMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

/** Coarse-grained presence state. Never carries message content. */
export interface PresenceState {
  userId: string;
  /** Coarsened timestamp (bucketed) of last activity. */
  lastSeenAt: number;
  /** Absolute expiry after which the state must be discarded. */
  expiresAt: number;
}

/** Coarse-grained typing state. Never carries message content. */
export interface TypingState {
  userId: string;
  /** Conversation/channel the user is typing in. */
  conversationId: string;
  /** Coarsened timestamp (bucketed) of last typing activity. */
  lastTypingAt: number;
  /** Absolute expiry after which the state must be discarded. */
  expiresAt: number;
}

const DEFAULT_TYPING_TTL_MS = 5_000;
const DEFAULT_PRESENCE_TTL_MS = 30_000;
const DEFAULT_COARSE_BUCKET_MS = 5_000;

/**
 * Manages opt-in, coarse-grained, expiring typing and presence signals.
 *
 * All mutating operations require the user to have opted in; otherwise they
 * are rejected with an explicit error so callers can surface failure semantics.
 */
export class TypingPresenceManager {
  private readonly typingTtlMs: number;
  private readonly presenceTtlMs: number;
  private readonly coarseBucketMs: number;
  private readonly now: () => number;

  /** Users who have explicitly opted in to sharing signals. */
  private readonly optedIn = new Set<string>();
  private readonly presence = new Map<string, PresenceState>();
  /** Keyed by `${userId}:${conversationId}`. */
  private readonly typing = new Map<string, TypingState>();

  constructor(options: TypingSignalOptions = {}) {
    this.typingTtlMs = options.typingTtlMs ?? DEFAULT_TYPING_TTL_MS;
    this.presenceTtlMs = options.presenceTtlMs ?? DEFAULT_PRESENCE_TTL_MS;
    this.coarseBucketMs = options.coarseBucketMs ?? DEFAULT_COARSE_BUCKET_MS;
    this.now = options.now ?? Date.now;
  }

  /** Explicitly enable sharing of typing/presence signals for a user. */
  optIn(userId: string): void {
    this.optedIn.add(userId);
  }

  /** Disable sharing and immediately purge any stored state for the user. */
  optOut(userId: string): void {
    this.optedIn.delete(userId);
    this.clearUser(userId);
  }

  isOptedIn(userId: string): boolean {
    return this.optedIn.has(userId);
  }

  /** Coarsen a raw timestamp into a bucket to avoid fine-grained exposure. */
  private coarsen(timestamp: number): number {
    return Math.floor(timestamp / this.coarseBucketMs) * this.coarseBucketMs;
  }

  private assertOptedIn(userId: string): void {
    if (!this.optedIn.has(userId)) {
      throw new Error(
        `User ${userId} has not opted in to sharing typing/presence signals`,
      );
    }
  }

  /** Record a presence heartbeat. Rejects if the user has not opted in. */
  recordPresence(userId: string): PresenceState {
    this.assertOptedIn(userId);
    const now = this.now();
    const state: PresenceState = {
      userId,
      lastSeenAt: this.coarsen(now),
      expiresAt: now + this.presenceTtlMs,
    };
    this.presence.set(userId, state);
    return state;
  }

  /** Record a typing signal. Rejects if the user has not opted in. */
  recordTyping(userId: string, conversationId: string): TypingState {
    this.assertOptedIn(userId);
    const now = this.now();
    const state: TypingState = {
      userId,
      conversationId,
      lastTypingAt: this.coarsen(now),
      expiresAt: now + this.typingTtlMs,
    };
    this.typing.set(this.typingKey(userId, conversationId), state);
    return state;
  }

  /** Get live presence for a user, or null if absent/expired/not opted in. */
  getPresence(userId: string): PresenceState | null {
    if (!this.optedIn.has(userId)) return null;
    const state = this.presence.get(userId);
    if (!state) return null;
    if (state.expiresAt <= this.now()) {
      this.presence.delete(userId);
      return null;
    }
    return state;
  }

  /** Get live typing state for a user in a conversation, or null. */
  getTyping(userId: string, conversationId: string): TypingState | null {
    if (!this.optedIn.has(userId)) return null;
    const key = this.typingKey(userId, conversationId);
    const state = this.typing.get(key);
    if (!state) return null;
    if (state.expiresAt <= this.now()) {
      this.typing.delete(key);
      return null;
    }
    return state;
  }

  /**
   * Remove all expired presence and typing state. Intended to be called
   * periodically by the server so stale signals never linger.
   */
  sweepExpired(): void {
    const now = this.now();
    for (const [userId, state] of this.presence) {
      if (state.expiresAt <= now) this.presence.delete(userId);
    }
    for (const [key, state] of this.typing) {
      if (state.expiresAt <= now) this.typing.delete(key);
    }
  }

  /**
   * Clean up all state for a user on disconnect/reconnect so stale presence
   * and typing signals are not retained across connections.
   */
  handleDisconnect(userId: string): void {
    this.clearUser(userId);
  }

  private clearUser(userId: string): void {
    this.presence.delete(userId);
    const prefix = `${userId}:`;
    for (const key of this.typing.keys()) {
      if (key.startsWith(prefix)) this.typing.delete(key);
    }
  }

  private typingKey(userId: string, conversationId: string): string {
    return `${userId}:${conversationId}`;
  }
}
