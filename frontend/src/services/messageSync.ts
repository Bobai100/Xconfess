export interface MessageTombstone {
  messageId: string;
  conversationId: string;
  version: number;
  deletedAt: string;
  actorId: string;
}

export interface DeletionEvent {
  messageId: string;
  conversationId: string;
  version: number;
  deletedAt: string;
  actorId: string;
}

export interface SyncState {
  conversationId: string;
  version: number;
}

export interface FetchTombstonesResult {
  tombstones: MessageTombstone[];
  version: number;
}

export type FetchTombstones = (
  conversationId: string,
  sinceVersion: number,
) => Promise<FetchTombstonesResult>;

export interface MessageSyncOptions {
  fetchTombstones: FetchTombstones;
  onTombstonesApplied?: (tombstones: MessageTombstone[]) => void;
}

/**
 * Tracks per-conversation deletion versions and reconciles stale clients on
 * reconnect by fetching tombstones published since the last known version.
 *
 * Tombstones carry only minimal metadata (id, version, deletedAt, actor) and
 * never retain message bodies.
 */
export class MessageSync {
  private readonly fetchTombstones: FetchTombstones;
  private readonly onTombstonesApplied?: (tombstones: MessageTombstone[]) => void;
  private readonly versions = new Map<string, number>();
  private readonly tombstones = new Map<string, Map<string, MessageTombstone>>();

  constructor(options: MessageSyncOptions) {
    this.fetchTombstones = options.fetchTombstones;
    this.onTombstonesApplied = options.onTombstonesApplied;
  }

  getVersion(conversationId: string): number {
    return this.versions.get(conversationId) ?? 0;
  }

  isDeleted(conversationId: string, messageId: string): boolean {
    return this.tombstones.get(conversationId)?.has(messageId) ?? false;
  }

  getTombstone(conversationId: string, messageId: string): MessageTombstone | undefined {
    return this.tombstones.get(conversationId)?.get(messageId);
  }

  /**
   * Apply a versioned deletion event received live (e.g. via websocket).
   * Events with a version at or below the known version are ignored so that
   * out-of-order or duplicate deliveries are idempotent.
   */
  applyDeletionEvent(event: DeletionEvent): boolean {
    const current = this.getVersion(event.conversationId);
    if (event.version <= current) {
      return false;
    }

    const tombstone: MessageTombstone = {
      messageId: event.messageId,
      conversationId: event.conversationId,
      version: event.version,
      deletedAt: event.deletedAt,
      actorId: event.actorId,
    };

    this.storeTombstone(tombstone);
    this.versions.set(event.conversationId, event.version);
    return true;
  }

  /**
   * Reconcile a stale client on reconnect by fetching tombstones published
   * since the last known version for the conversation.
   */
  async reconcile(conversationId: string): Promise<MessageTombstone[]> {
    const sinceVersion = this.getVersion(conversationId);
    const result = await this.fetchTombstones(conversationId, sinceVersion);

    const applied: MessageTombstone[] = [];
    for (const tombstone of result.tombstones) {
      if (tombstone.version <= this.getVersion(conversationId)) {
        continue;
      }
      this.storeTombstone(tombstone);
      this.versions.set(conversationId, tombstone.version);
      applied.push(tombstone);
    }

    if (result.version > this.getVersion(conversationId)) {
      this.versions.set(conversationId, result.version);
    }

    if (applied.length > 0) {
      this.onTombstonesApplied?.(applied);
    }

    return applied;
  }

  private storeTombstone(tombstone: MessageTombstone): void {
    let conversationTombstones = this.tombstones.get(tombstone.conversationId);
    if (!conversationTombstones) {
      conversationTombstones = new Map();
      this.tombstones.set(tombstone.conversationId, conversationTombstones);
    }
    conversationTombstones.set(tombstone.messageId, tombstone);
  }
}
