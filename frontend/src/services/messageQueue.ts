/**
 * Durable offline message submission queue with duplicate prevention.
 *
 * Each submission attempt is tracked by a client-generated idempotency key so
 * that retries after connectivity loss reconcile against the server
 * acknowledgment instead of sending the same message twice. Encrypted drafts
 * are persisted locally so unsent messages survive app restarts.
 */

export interface QueuedSubmission {
  /** Client-generated idempotency key, stable across retries. */
  clientId: string;
  conversationId: string;
  /** Encrypted payload as produced by the client crypto layer. */
  ciphertext: string;
  /** Monotonic attempt counter for observability and backoff. */
  attempts: number;
  createdAt: number;
  updatedAt: number;
  /** Server acknowledgment, set once reconciled. */
  ack?: SubmissionAck;
}

export interface SubmissionAck {
  clientId: string;
  serverMessageId: string;
  /** Hash of the accepted payload, used to detect conflicting retries. */
  payloadHash: string;
  acknowledgedAt: number;
}

export type SubmitResult =
  | { status: 'acknowledged'; ack: SubmissionAck }
  | { status: 'duplicate'; ack: SubmissionAck }
  | { status: 'conflict'; reason: string }
  | { status: 'retry'; reason: string };

export interface SubmissionTransport {
  /**
   * Send a submission to the server. Implementations must be idempotent on
   * `clientId`: a repeated key with the same payload returns the existing ack,
   * a repeated key with a different payload is rejected as a conflict.
   */
  submit(submission: QueuedSubmission): Promise<SubmissionAck>;
}

export interface QueueStorage {
  load(): Promise<QueuedSubmission[]>;
  save(submissions: QueuedSubmission[]): Promise<void>;
}

const STORAGE_KEY = 'handsoff.messageQueue.v1';

/** Default storage backed by localStorage; falls back to memory when absent. */
export function createDefaultStorage(): QueueStorage {
  const memory: QueuedSubmission[] = [];
  const hasLocalStorage =
    typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function';

  return {
    async load() {
      if (!hasLocalStorage) return [...memory];
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as QueuedSubmission[]) : [];
      } catch {
        return [];
      }
    },
    async save(submissions) {
      if (!hasLocalStorage) {
        memory.length = 0;
        memory.push(...submissions);
        return;
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(submissions));
    },
  };
}

/** Stable, deterministic hash of the encrypted payload for conflict checks. */
export function hashPayload(ciphertext: string): string {
  let hash = 5381;
  for (let i = 0; i < ciphertext.length; i += 1) {
    hash = ((hash << 5) + hash + ciphertext.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}

function generateClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `sub-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export class MessageQueue {
  private submissions: QueuedSubmission[] = [];
  private loaded = false;

  constructor(
    private readonly transport: SubmissionTransport,
    private readonly storage: QueueStorage = createDefaultStorage(),
  ) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.submissions = await this.storage.load();
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await this.storage.save(this.submissions);
  }

  /**
   * Enqueue an encrypted draft and attempt submission. The client id is
   * generated once and reused on every retry so the server can deduplicate.
   */
  async enqueue(input: {
    conversationId: string;
    ciphertext: string;
    clientId?: string;
  }): Promise<SubmitResult> {
    await this.ensureLoaded();

    const existing = input.clientId
      ? this.submissions.find((s) => s.clientId === input.clientId)
      : undefined;

    if (existing) {
      if (existing.ciphertext !== input.ciphertext) {
        return {
          status: 'conflict',
          reason: 'clientId reused with a different payload',
        };
      }
      if (existing.ack) {
        return { status: 'duplicate', ack: existing.ack };
      }
      return this.attempt(existing);
    }

    const now = Date.now();
    const submission: QueuedSubmission = {
      clientId: input.clientId ?? generateClientId(),
      conversationId: input.conversationId,
      ciphertext: input.ciphertext,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.submissions.push(submission);
    await this.persist();
    return this.attempt(submission);
  }

  /** Retry all pending (unacknowledged) submissions, e.g. on reconnect. */
  async flush(): Promise<SubmitResult[]> {
    await this.ensureLoaded();
    const pending = this.submissions.filter((s) => !s.ack);
    const results: SubmitResult[] = [];
    for (const submission of pending) {
      results.push(await this.attempt(submission));
    }
    return results;
  }

  /** Pending submissions, useful for rendering unsent drafts after restart. */
  async pending(): Promise<QueuedSubmission[]> {
    await this.ensureLoaded();
    return this.submissions.filter((s) => !s.ack);
  }

  private async attempt(submission: QueuedSubmission): Promise<SubmitResult> {
    submission.attempts += 1;
    submission.updatedAt = Date.now();
    await this.persist();

    try {
      const ack = await this.transport.submit(submission);
      if (ack.payloadHash !== hashPayload(submission.ciphertext)) {
        return {
          status: 'conflict',
          reason: 'server ack payload hash does not match local draft',
        };
      }
      submission.ack = ack;
      submission.updatedAt = Date.now();
      await this.persist();
      return { status: 'acknowledged', ack };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'submission failed';
      await this.persist();
      return { status: 'retry', reason };
    }
  }
}
