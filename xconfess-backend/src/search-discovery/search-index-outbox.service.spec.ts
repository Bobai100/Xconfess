import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SearchIndexOutboxService } from './search-index-outbox.service';
import {
  SearchIndexOutbox,
  SearchOutboxAction,
  SearchOutboxStatus,
} from './entities/search-index-outbox.entity';

describe('SearchIndexOutboxService', () => {
  let service: SearchIndexOutboxService;
  let outboxRepo: any;

  const mockEntry: SearchIndexOutbox = {
    id: 'outbox-uuid-1',
    entityType: 'CONFESSION',
    entityId: 'confession-uuid-1',
    action: SearchOutboxAction.TOPIC_SYNC,
    payload: { topics: ['tech', 'career'] },
    status: SearchOutboxStatus.PENDING,
    attempts: 0,
    maxAttempts: 5,
    createdAt: new Date(),
  };

  beforeEach(async () => {
    outboxRepo = {
      create: jest.fn().mockImplementation((d) => ({ ...d, id: 'outbox-uuid-1' })),
      save: jest.fn().mockImplementation((e) => Promise.resolve(e)),
      find: jest.fn().mockResolvedValue([mockEntry]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SearchIndexOutboxService,
        {
          provide: getRepositoryToken(SearchIndexOutbox),
          useValue: outboxRepo,
        },
      ],
    }).compile();

    service = module.get<SearchIndexOutboxService>(SearchIndexOutboxService);
  });

  it('should enqueue search index changes within an active transaction manager', async () => {
    const mockManager: any = {
      create: jest.fn().mockImplementation((entityClass, d) => ({ ...d, id: 'outbox-uuid-1' })),
      save: jest.fn().mockImplementation((entityClass, e) => Promise.resolve(e)),
    };

    const entry = await service.enqueueIndexChange(
      mockManager,
      'CONFESSION',
      'confession-uuid-1',
      SearchOutboxAction.TOPIC_SYNC,
      { topics: ['privacy', 'security'] },
    );

    expect(entry.status).toBe(SearchOutboxStatus.PENDING);
    expect(mockManager.save).toHaveBeenCalled();
  });

  it('should process pending outbox events and mark as COMPLETED', async () => {
    const syncSpy = jest.spyOn(service, 'syncIndex').mockResolvedValue(undefined);
    const count = await service.processOutboxBatch(10);

    expect(count).toBe(1);
    expect(syncSpy).toHaveBeenCalled();
    expect(outboxRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: SearchOutboxStatus.COMPLETED,
      }),
    );
  });

  it('should apply exponential backoff on retryable indexing failures', async () => {
    jest.spyOn(service, 'syncIndex').mockRejectedValue(new Error('Index cluster unreachable'));

    await service.processOutboxBatch(10);

    expect(outboxRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: SearchOutboxStatus.FAILED,
        attempts: 1,
        nextRetryAt: expect.any(Date),
      }),
    );
  });
});
