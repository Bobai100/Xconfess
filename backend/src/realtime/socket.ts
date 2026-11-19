import type { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { verifyToken } from '../auth/jwt';
import { logger } from '../utils/logger';

// Opt-in presence/typing sharing. Users must explicitly enable sharing before
// any presence or typing signal is broadcast on their behalf.
const presenceOptIn = new Map<string, boolean>();

// Coarse timing: activity signals are throttled to a coarse bucket so that
// fine-grained behavioral patterns cannot be inferred from event timing.
const COARSE_BUCKET_MS = 15_000;
const lastSignalAt = new Map<string, number>();

// Server-side expiry: presence and typing state are dropped if not refreshed.
const PRESENCE_TTL_MS = 60_000;
const TYPING_TTL_MS = 10_000;
const presenceExpiry = new Map<string, NodeJS.Timeout>();
const typingExpiry = new Map<string, NodeJS.Timeout>();

// User-controlled safety filters for sensitive content categories. These are
// display preferences only: they never affect moderation enforcement, which is
// applied independently at the owning boundary. Each category is explicitly
// opt-in (hidden by default) or opt-out (shown by default).
const SENSITIVE_CATEGORIES = ['violence', 'nudity', 'profanity', 'self-harm'] as const;
type SensitiveCategory = (typeof SENSITIVE_CATEGORIES)[number];
type SafetyFilterMode = 'opt-in' | 'opt-out';

const SAFETY_FILTER_MODES: Record<SensitiveCategory, SafetyFilterMode> = {
  violence: 'opt-out',
  nudity: 'opt-out',
  profanity: 'opt-out',
  'self-harm': 'opt-in',
};

// Per-user explicit preferences. Absent entries fall back to the category mode.
const safetyFilters = new Map<string, Partial<Record<SensitiveCategory, boolean>>>();

function isSensitiveCategory(value: unknown): value is SensitiveCategory {
  return typeof value === 'string' && (SENSITIVE_CATEGORIES as readonly string[]).includes(value);
}

function resolveSafetyFilters(userId: string): Record<SensitiveCategory, boolean> {
  const prefs = safetyFilters.get(userId) ?? {};
  const resolved = {} as Record<SensitiveCategory, boolean>;
  for (const category of SENSITIVE_CATEGORIES) {
    const explicit = prefs[category];
    if (typeof explicit === 'boolean') {
      resolved[category] = explicit;
    } else {
      // opt-in categories are hidden unless explicitly enabled; opt-out shown.
      resolved[category] = SAFETY_FILTER_MODES[category] === 'opt-out';
    }
  }
  return resolved;
}

// Consent-based polls on confession threads. Options are bounded, each poll has
// an explicit close time, and votes are one-per-user. Voter identity is never
// exposed: only aggregate counts and the caller's own choice are returned.
const MAX_POLL_OPTIONS = 6;
const MIN_POLL_OPTIONS = 2;
const MAX_POLL_OPTION_LENGTH = 120;
const MAX_POLL_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_POLL_DURATION_MS = 60 * 1000;

interface Poll {
  id: string;
  threadId: string;
  authorId: string;
  options: string[];
  closesAt: number;
  // userId -> option index. Kept private; never serialized to other clients.
  votes: Map<string, number>;
}

const polls = new Map<string, Poll>();
let pollSeq = 0;

function isOpen(poll: Poll): boolean {
  return Date.now() < poll.closesAt;
}

// Aggregate results without leaking voter identity. Only counts and the
// requesting user's own selection are included.
function pollResults(poll: Poll, viewerId: string) {
  const counts = poll.options.map(() => 0);
  for (const index of poll.votes.values()) {
    if (index >= 0 && index < counts.length) counts[index] += 1;
  }
  const myVote = poll.votes.has(viewerId) ? poll.votes.get(viewerId)! : null;
  return {
    id: poll.id,
    threadId: poll.threadId,
    options: poll.options.map((label, index) => ({ index, label, count: counts[index] })),
    totalVotes: poll.votes.size,
    closesAt: poll.closesAt,
    closed: !isOpen(poll),
    myVote,
  };
}

function clearTimers(userId: string): void {
  const p = presenceExpiry.get(userId);
  if (p) clearTimeout(p);
  presenceExpiry.delete(userId);
  const t = typingExpiry.get(userId);
  if (t) clearTimeout(t);
  typingExpiry.delete(userId);
}

function cleanupUser(io: Server, userId: string): void {
  clearTimers(userId);
  presenceOptIn.delete(userId);
  lastSignalAt.delete(userId);
  io.emit('presence:update', { userId, status: 'offline' });
  io.emit('typing:update', { userId, isTyping: false });
}

function withinCoarseBucket(userId: string): boolean {
  const now = Date.now();
  const last = lastSignalAt.get(userId) ?? 0;
  if (now - last < COARSE_BUCKET_MS) return false;
  lastSignalAt.set(userId, now);
  return true;
}

export function attachRealtime(server: HttpServer): Server {
  const io = new Server(server, {
    cors: { origin: process.env.CORS_ORIGIN ?? '*', credentials: true },
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error('unauthorized'));
    try {
      const payload = verifyToken(token);
      (socket.data as { userId?: string }).userId = payload.sub;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const userId = (socket.data as { userId?: string }).userId;
    if (!userId) {
      socket.disconnect(true);
      return;
    }

    // Explicit opt-in required before any presence/typing signal is shared.
    socket.on('presence:opt-in', (enabled: boolean) => {
      presenceOptIn.set(userId, enabled === true);
      if (enabled !== true) {
        clearTimers(userId);
        io.emit('presence:update', { userId, status: 'offline' });
        io.emit('typing:update', { userId, isTyping: false });
      }
    });

    socket.on('presence:heartbeat', () => {
      if (presenceOptIn.get(userId) !== true) return;
      if (!withinCoarseBucket(userId)) return;
      io.emit('presence:update', { userId, status: 'online' });
      const existing = presenceExpiry.get(userId);
      if (existing) clearTimeout(existing);
      presenceExpiry.set(
        userId,
        setTimeout(() => {
          presenceExpiry.delete(userId);
          io.emit('presence:update', { userId, status: 'offline' });
        }, PRESENCE_TTL_MS),
      );
    });

    socket.on('typing:start', () => {
      if (presenceOptIn.get(userId) !== true) return;
      if (!withinCoarseBucket(userId)) return;
      io.emit('typing:update', { userId, isTyping: true });
      const existing = typingExpiry.get(userId);
      if (existing) clearTimeout(existing);
      typingExpiry.set(
        userId,
        setTimeout(() => {
          typingExpiry.delete(userId);
          io.emit('typing:update', { userId, isTyping: false });
        }, TYPING_TTL_MS),
      );
    });

    socket.on('typing:stop', () => {
      if (presenceOptIn.get(userId) !== true) return;
      const existing = typingExpiry.get(userId);
      if (existing) clearTimeout(existing);
      typingExpiry.delete(userId);
      io.emit('typing:update', { userId, isTyping: false });
    });

    // User-controlled safety filters. The authenticated user may only change
    // their own preferences; the resolved set is echoed back so feed and search
    // consumers apply the same display rules consistently.
    socket.on('safety:filters:get', () => {
      socket.emit('safety:filters:update', resolveSafetyFilters(userId));
    });

    socket.on(
      'safety:filters:set',
      (payload: { category?: unknown; enabled?: unknown } | undefined) => {
        const category = payload?.category;
        const enabled = payload?.enabled;
        if (!isSensitiveCategory(category) || typeof enabled !== 'boolean') {
          socket.emit('safety:filters:error', {
            code: 'invalid_filter',
            message: 'Unknown category or non-boolean enabled value',
          });
          return;
        }
        const prefs = safetyFilters.get(userId) ?? {};
        prefs[category] = enabled;
        safetyFilters.set(userId, prefs);
        socket.emit('safety:filters:update', resolveSafetyFilters(userId));
      },
    );

    // Create a consent-based poll on a confession thread. The author controls
    // the bounded option set and an explicit close time.
    socket.on(
      'poll:create',
      (
        payload:
          | { threadId?: unknown; options?: unknown; durationMs?: unknown }
          | undefined,
      ) => {
        const threadId = payload?.threadId;
        const rawOptions = payload?.options;
        const durationMs = payload?.durationMs;
        if (typeof threadId !== 'string' || threadId.length === 0) {
          socket.emit('poll:error', { code: 'invalid_thread', message: 'threadId is required' });
          return;
        }
        if (!Array.isArray(rawOptions)) {
          socket.emit('poll:error', { code: 'invalid_options', message: 'options must be an array' });
          return;
        }
        const options = rawOptions.map((o) => (typeof o === 'string' ? o.trim() : ''));
        if (
          options.length < MIN_POLL_OPTIONS ||
          options.length > MAX_POLL_OPTIONS ||
          options.some((o) => o.length === 0 || o.length > MAX_POLL_OPTION_LENGTH) ||
          new Set(options).size !== options.length
        ) {
          socket.emit('poll:error', {
            code: 'invalid_options',
            message: `Provide ${MIN_POLL_OPTIONS}-${MAX_POLL_OPTIONS} unique non-empty options`,
          });
          return;
        }
        if (
          typeof durationMs !== 'number' ||
          !Number.isFinite(durationMs) ||
          durationMs < MIN_POLL_DURATION_MS ||
          durationMs > MAX_POLL_DURATION_MS
        ) {
          socket.emit('poll:error', {
            code: 'invalid_duration',
            message: 'durationMs must be within the allowed range',
          });
          return;
        }
        pollSeq += 1;
        const poll: Poll = {
          id: `poll_${pollSeq}`,
          threadId,
          authorId: userId,
          options,
          closesAt: Date.now() + durationMs,
          votes: new Map(),
        };
        polls.set(poll.id, poll);
        io.emit('poll:created', pollResults(poll, userId));
      },
    );

    // Cast a single vote. Re-voting is rejected to preserve one-vote semantics.
    socket.on(
      'poll:vote',
      (payload: { pollId?: unknown; optionIndex?: unknown } | undefined) => {
        const pollId = payload?.pollId;
        const optionIndex = payload?.optionIndex;
        const poll = typeof pollId === 'string' ? polls.get(pollId) : undefined;
        if (!poll) {
          socket.emit('poll:error', { code: 'not_found', message: 'Poll not found' });
          return;
        }
        if (!isOpen(poll)) {
          socket.emit('poll:error', { code: 'closed', message: 'Poll is closed' });
          return;
        }
        if (
          typeof optionIndex !== 'number' ||
          !Number.isInteger(optionIndex) ||
          optionIndex < 0 ||
          optionIndex >= poll.options.length
        ) {
          socket.emit('poll:error', { code: 'invalid_option', message: 'Invalid option index' });
          return;
        }
        if (poll.votes.has(userId)) {
          socket.emit('poll:error', { code: 'already_voted', message: 'You have already voted' });
          return;
        }
        poll.votes.set(userId, optionIndex);
        // Broadcast aggregate results only; voter identity stays private.
        io.emit('poll:results', pollResults(poll, userId));
      },
    );

    socket.on('poll:results', (payload: { pollId?: unknown } | undefined) => {
      const pollId = payload?.pollId;
      const poll = typeof pollId === 'string' ? polls.get(pollId) : undefined;
      if (!poll) {
        socket.emit('poll:error', { code: 'not_found', message: 'Poll not found' });
        return;
      }
      socket.emit('poll:results', pollResults(poll, userId));
    });

    // Reconnect cleanup: remove stale presence/typing state on disconnect.
    socket.on('disconnect', () => {
      logger.debug({ userId }, 'realtime disconnect');
      cleanupUser(io, userId);
    });
  });

  return io;
}
