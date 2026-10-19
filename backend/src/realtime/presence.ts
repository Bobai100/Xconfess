import type { Server as SocketIOServer, Socket } from 'socket.io';

/**
 * Presence and typing signals.
 *
 * Privacy posture (issue #254):
 * - Opt-in: a socket only broadcasts presence/typing after the client
 *   explicitly enables sharing via `presence:enable`.
 * - Coarse timing: activity timestamps are bucketed to a coarse window so
 *   fine-grained behavioral patterns are not exposed.
 * - Server-side expiry: presence and typing state expire automatically.
 * - Reconnect cleanup: state is cleared on disconnect.
 * - No durable message content is ever attached to these signals.
 */

const PRESENCE_TTL_MS = 60_000;
const TYPING_TTL_MS = 5_000;
const COARSE_WINDOW_MS = 30_000;

interface PresenceEntry {
  userId: string;
  lastSeen: number;
  expiresAt: number;
}

interface TypingEntry {
  userId: string;
  roomId: string;
  expiresAt: number;
}

const presence = new Map<string, PresenceEntry>();
const typing = new Map<string, TypingEntry>();
const optedIn = new Set<string>();

function coarse(now: number): number {
  return Math.floor(now / COARSE_WINDOW_MS) * COARSE_WINDOW_MS;
}

function sweep(): void {
  const now = Date.now();
  for (const [socketId, entry] of presence) {
    if (entry.expiresAt <= now) presence.delete(socketId);
  }
  for (const [key, entry] of typing) {
    if (entry.expiresAt <= now) typing.delete(key);
  }
}

function typingKey(socketId: string, roomId: string): string {
  return `${socketId}:${roomId}`;
}

function clearSocket(socketId: string): void {
  presence.delete(socketId);
  for (const key of typing.keys()) {
    if (key.startsWith(`${socketId}:`)) typing.delete(key);
  }
  optedIn.delete(socketId);
}

export function registerPresence(io: SocketIOServer): void {
  const sweepTimer = setInterval(sweep, 15_000);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

  io.on('connection', (socket: Socket) => {
    socket.on('presence:enable', () => {
      optedIn.add(socket.id);
      const now = Date.now();
      presence.set(socket.id, {
        userId: String(socket.data?.userId ?? socket.id),
        lastSeen: coarse(now),
        expiresAt: now + PRESENCE_TTL_MS,
      });
    });

    socket.on('presence:disable', () => {
      clearSocket(socket.id);
    });

    socket.on('typing:start', (payload: { roomId?: unknown }) => {
      if (!optedIn.has(socket.id)) return;
      const roomId = typeof payload?.roomId === 'string' ? payload.roomId : undefined;
      if (!roomId) return;
      const now = Date.now();
      typing.set(typingKey(socket.id, roomId), {
        userId: String(socket.data?.userId ?? socket.id),
        roomId,
        expiresAt: now + TYPING_TTL_MS,
      });
    });

    socket.on('typing:stop', (payload: { roomId?: unknown }) => {
      const roomId = typeof payload?.roomId === 'string' ? payload.roomId : undefined;
      if (!roomId) return;
      typing.delete(typingKey(socket.id, roomId));
    });

    socket.on('disconnect', () => {
      clearSocket(socket.id);
    });
  });
}
