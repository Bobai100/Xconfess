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

    // Reconnect cleanup: remove stale presence/typing state on disconnect.
    socket.on('disconnect', () => {
      logger.debug({ userId }, 'realtime disconnect, cleaning presence/typing');
      cleanupUser(io, userId);
    });
  });

  return io;
}
