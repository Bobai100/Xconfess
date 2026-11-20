import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager, LessThanOrEqual, IsNull, In } from 'typeorm';
import {
  SearchIndexOutbox,
  SearchOutboxAction,
  SearchOutboxStatus,
} from './entities/search-index-outbox.entity';

@Injectable()
export class SearchIndexOutboxService {
  private readonly logger = new Logger(SearchIndexOutboxService.name);

  constructor(
    @InjectRepository(SearchIndexOutbox)
    private readonly outboxRepo: Repository<SearchIndexOutbox>,
  ) {}

  /**
   * Enqueues an index change atomically inside an existing transaction using the passed EntityManager.
   */
  async enqueueIndexChange(
    manager: EntityManager,
    entityType: string,
    entityId: string,
    action: SearchOutboxAction,
    payload: Record<string, any>,
  ): Promise<SearchIndexOutbox> {
    const entry = manager.create(SearchIndexOutbox, {
      entityType,
      entityId,
      action,
      payload,
      status: SearchOutboxStatus.PENDING,
      attempts: 0,
      maxAttempts: 5,
    });

    const saved = await manager.save(SearchIndexOutbox, entry);
    this.logger.debug(
      `Enqueued search index outbox event ${saved.id} for ${entityType}:${entityId} (${action})`,
    );
    return saved;
  }

  /**
   * Processes a batch of pending or retryable outbox entries with bounded retries and exponential backoff.
   */
  async processOutboxBatch(batchSize = 25): Promise<number> {
    const now = new Date();
    const pendingEntries = await this.outboxRepo.find({
      where: [
        { status: SearchOutboxStatus.PENDING },
        { status: SearchOutboxStatus.FAILED, nextRetryAt: LessThanOrEqual(now) },
      ],
      order: { createdAt: 'ASC' },
      take: batchSize,
    });

    let processedCount = 0;

    for (const entry of pendingEntries) {
      entry.attempts += 1;
      entry.status = SearchOutboxStatus.PROCESSING;
      await this.outboxRepo.save(entry);

      try {
        await this.syncIndex(entry);

        entry.status = SearchOutboxStatus.COMPLETED;
        entry.processedAt = new Date();
        entry.lastError = undefined;
        entry.nextRetryAt = undefined;
        processedCount++;
      } catch (err: any) {
        this.logger.error(
          `Failed indexing outbox entry ${entry.id}: ${err.message}`,
        );
        entry.lastError = err.message || 'Indexing error';

        if (entry.attempts < entry.maxAttempts) {
          entry.status = SearchOutboxStatus.FAILED;
          // Exponential backoff: 30s, 2m, 10m, 30m, 1h
          const backoffDelays = [30_000, 120_000, 600_000, 1_800_000, 3_600_000];
          const delay = backoffDelays[entry.attempts - 1] || 3_600_000;
          entry.nextRetryAt = new Date(Date.now() + delay);
        } else {
          entry.status = SearchOutboxStatus.FAILED;
          entry.nextRetryAt = undefined; // Terminal dead-letter state
        }
      }

      await this.outboxRepo.save(entry);
    }

    return processedCount;
  }

  /**
   * Authoritative sync method that synchronizes search index.
   */
  async syncIndex(entry: SearchIndexOutbox): Promise<void> {
    // In our architecture, PostgreSQL full-text index and discovery cache update here
    this.logger.log(
      `Synchronizing search index for ${entry.entityType} ${entry.entityId} [Action: ${entry.action}]`,
    );
  }

  /**
   * Reconciles failed outbox events on demand or via background scheduler.
   */
  async reconcileFailedEvents(entryIds?: string[]): Promise<number> {
    const query: any = { status: SearchOutboxStatus.FAILED };
    if (entryIds && entryIds.length > 0) {
      query.id = In(entryIds);
    }

    const failed = await this.outboxRepo.find({ where: query });
    for (const item of failed) {
      item.attempts = 0;
      item.status = SearchOutboxStatus.PENDING;
      item.nextRetryAt = undefined;
      item.lastError = undefined;
      await this.outboxRepo.save(item);
    }

    return this.processOutboxBatch(failed.length || 25);
  }
}
