import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AccountSequenceCoordinatorService } from './account-sequence-coordinator.service';

describe('AccountSequenceCoordinatorService', () => {
  let service: AccountSequenceCoordinatorService;

  const accountId = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountSequenceCoordinatorService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: unknown) => {
              if (key === 'STELLAR_SEQUENCE_LEASE_TTL_MS') {
                return 200;
              }
              if (key === 'STELLAR_SEQUENCE_LEASE_RETRY_MS') {
                return 25;
              }
              return defaultValue;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<AccountSequenceCoordinatorService>(
      AccountSequenceCoordinatorService,
    );
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  describe('concurrent allocation across multiple workers', () => {
    it('allocates distinct sequences to concurrent workers', async () => {
      const workerCount = 10;
      const startSequence = '100';

      const results = await Promise.all(
        Array.from({ length: workerCount }, (_, workerIndex) =>
          service.allocateSequence({
            accountId,
            workerId: `worker-${workerIndex}`,
            currentSequence: startSequence,
          }),
        ),
      );

      const sequences = results.map((r) => r.sequence);
      const uniqueSequences = new Set(sequences);

      expect(results).toHaveLength(workerCount);
      expect(uniqueSequences.size).toBe(workerCount);

      const numericSequences = sequences.map((s) => BigInt(s));
      const sorted = [...numericSequences].sort((a, b) =>
        a < b ? -1 : a > b ? 1 : 0,
      );

      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i]).toBeGreaterThan(sorted[i - 1]);
      }

      expect(sorted[0]).toBeGreaterThan(BigInt(startSequence));
    });

    it('serializes allocation so no two workers share a sequence', async () => {
      const workerCount = 25;
      const startSequence = '5000';

      const results = await Promise.all(
        Array.from({ length: workerCount }, (_, workerIndex) =>
          service.allocateSequence({
            accountId,
            workerId: `worker-${workerIndex}`,
            currentSequence: startSequence,
          }),
        ),
      );

      const sequences = results.map((r) => r.sequence);
      expect(new Set(sequences).size).toBe(workerCount);
    });

    it('allocates independent sequences for different accounts', async () => {
      const otherAccount =
        'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

      const [first, second] = await Promise.all([
        service.allocateSequence({
          accountId,
          workerId: 'worker-a',
          currentSequence: '10',
        }),
        service.allocateSequence({
          accountId: otherAccount,
          workerId: 'worker-b',
          currentSequence: '10',
        }),
      ]);

      expect(first.sequence).toBeDefined();
      expect(second.sequence).toBeDefined();
      expect(first.accountId).toBe(accountId);
      expect(second.accountId).toBe(otherAccount);
    });
  });

  describe('lease expiry recovery after simulated process failure', () => {
    it('recovers the lease when the holding worker fails to release it', async () => {
      const lease = await service.acquireLease({
        accountId,
        workerId: 'failing-worker',
      });

      expect(lease).toBeDefined();
      expect(lease.workerId).toBe('failing-worker');

      // Simulate process failure: the worker never releases the lease.
      // Wait for the lease TTL to elapse.
      await new Promise((resolve) => setTimeout(resolve, 250));

      const recovered = await service.acquireLease({
        accountId,
        workerId: 'recovery-worker',
      });

      expect(recovered).toBeDefined();
      expect(recovered.workerId).toBe('recovery-worker');
      expect(recovered.leaseId).not.toBe(lease.leaseId);
    });

    it('allows allocation after a failed worker lease expires', async () => {
      await service.acquireLease({
        accountId,
        workerId: 'failing-worker',
      });

      await new Promise((resolve) => setTimeout(resolve, 250));

      const result = await service.allocateSequence({
        accountId,
        workerId: 'recovery-worker',
        currentSequence: '42',
      });

      expect(result).toBeDefined();
      expect(BigInt(result.sequence)).toBeGreaterThan(BigInt('42'));
    });

    it('reports lease state as expired after TTL elapses', async () => {
      await service.acquireLease({
        accountId,
        workerId: 'failing-worker',
      });

      await new Promise((resolve) => setTimeout(resolve, 250));

      const state = service.getLeaseState(accountId);
      expect(state).toBeDefined();
      expect(state?.expired).toBe(true);
    });
  });

  describe('rejection when lease cannot be acquired', () => {
    it('rejects a second worker while the lease is actively held', async () => {
      await service.acquireLease({
        accountId,
        workerId: 'holder-worker',
      });

      await expect(
        service.acquireLease({
          accountId,
          workerId: 'contender-worker',
        }),
      ).rejects.toThrow();
    });

    it('rejects allocation when another worker holds the lease', async () => {
      await service.acquireLease({
        accountId,
        workerId: 'holder-worker',
      });

      await expect(
        service.allocateSequence({
          accountId,
          workerId: 'contender-worker',
          currentSequence: '100',
        }),
      ).rejects.toThrow();
    });

    it('rejects re-acquisition by the same worker while lease is held', async () => {
      await service.acquireLease({
        accountId,
        workerId: 'holder-worker',
      });

      await expect(
        service.acquireLease({
          accountId,
          workerId: 'holder-worker',
        }),
      ).rejects.toThrow();
    });

    it('allows re-acquisition after the holder releases the lease', async () => {
      const lease = await service.acquireLease({
        accountId,
        workerId: 'holder-worker',
      });

      await service.releaseLease({
        accountId,
        workerId: 'holder-worker',
        leaseId: lease.leaseId,
      });

      const next = await service.acquireLease({
        accountId,
        workerId: 'next-worker',
      });

      expect(next.workerId).toBe('next-worker');
    });

    it('rejects release from a worker that does not own the lease', async () => {
      const lease = await service.acquireLease({
        accountId,
        workerId: 'holder-worker',
      });

      await expect(
        service.releaseLease({
          accountId,
          workerId: 'intruder-worker',
          leaseId: lease.leaseId,
        }),
      ).rejects.toThrow();
    });
  });
});