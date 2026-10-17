import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';

import {
  RpcEndpointPoolService,
  RpcEndpointHealth,
  RpcEndpointConfig,
  RpcOperationType,
  RpcEndpointPoolOptions,
} from './rpc-endpoint-pool.service';

/**
 * A controllable fake Stellar RPC client used to drive the pool through
 * healthy, slow, and failing endpoint scenarios.
 */
class FakeRpcClient {
  public callCount = 0;
  public submittedTxHashes: string[] = [];
  public behavior: 'healthy' | 'fail' | 'slow' | 'hang' = 'healthy';
  public latencyMs = 0;
  public failTimes = Infinity;

  constructor(public readonly url: string) {}

  private async simulate(): Promise<void> {
    this.callCount += 1;
    if (this.behavior === 'fail' && this.callCount <= this.failTimes) {
      throw new Error(`RPC failure at ${this.url}`);
    }
    if (this.behavior === 'hang') {
      await new Promise(() => {
        /* never resolves */
      });
    }
    if (this.behavior === 'slow' || this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }
  }

  async getHealth(): Promise<{ status: string }> {
    await this.simulate();
    return { status: 'healthy' };
  }

  async getLatestLedger(): Promise<{ sequence: number }> {
    await this.simulate();
    return { sequence: 12345 };
  }

  async getAccount(accountId: string): Promise<{ accountId: string }> {
    await this.simulate();
    return { accountId };
  }

  async submitTransaction(txHash: string): Promise<{ hash: string }> {
    await this.simulate();
    this.submittedTxHashes.push(txHash);
    return { hash: txHash };
  }
}

describe('RpcEndpointPoolService', () => {
  let service: RpcEndpointPoolService;
  let configService: ConfigService;
  let clients: Map<string, FakeRpcClient>;

  const endpointUrls = [
    'https://rpc-primary.example.com',
    'https://rpc-secondary.example.com',
    'https://rpc-tertiary.example.com',
  ];

  const baseOptions: RpcEndpointPoolOptions = {
    failureThreshold: 2,
    cooldownMs: 5000,
    requestTimeoutMs: 200,
    maxRetries: 2,
    healthCheckIntervalMs: 1000,
  };

  const buildConfig = (overrides: Record<string, unknown> = {}): ConfigService =>
    ({
      get: jest.fn((key: string, defaultValue?: unknown) => {
        const values: Record<string, unknown> = {
          STELLAR_RPC_URLS: endpointUrls.join(','),
          STELLAR_RPC_FAILURE_THRESHOLD: baseOptions.failureThreshold,
          STELLAR_RPC_COOLDOWN_MS: baseOptions.cooldownMs,
          STELLAR_RPC_REQUEST_TIMEOUT_MS: baseOptions.requestTimeoutMs,
          STELLAR_RPC_MAX_RETRIES: baseOptions.maxRetries,
          STELLAR_RPC_HEALTH_CHECK_INTERVAL_MS: baseOptions.healthCheckIntervalMs,
          ...overrides,
        };
        return key in values ? values[key] : defaultValue;
      }),
    } as unknown as ConfigService);

  const createService = async (config: ConfigService): Promise<RpcEndpointPoolService> => {
    clients = new Map();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RpcEndpointPoolService,
        { provide: ConfigService, useValue: config },
      ],
    })
      .setLogger(new Logger())
      .compile();

    service = module.get(RpcEndpointPoolService);
    // Inject a deterministic client factory so tests control endpoint behavior.
    (service as unknown as {
      clientFactory: (url: string) => FakeRpcClient;
    }).clientFactory = (url: string) => {
      const client = new FakeRpcClient(url);
      clients.set(url, client);
      return client;
    };
    await service.onModuleInit();
    return service;
  };

  afterEach(async () => {
    if (service) {
      await service.onModuleDestroy();
    }
    jest.useRealTimers();
  });

  describe('configuration', () => {
    it('parses configured endpoints and initializes them as healthy', async () => {
      await createService(buildConfig());
      const statuses = service.getEndpointStatuses();
      expect(statuses).toHaveLength(endpointUrls.length);
      expect(statuses.map((s) => s.url)).toEqual(endpointUrls);
      expect(statuses.every((s) => s.health === RpcEndpointHealth.HEALTHY)).toBe(true);
    });

    it('rejects configuration with no endpoints', async () => {
      await expect(createService(buildConfig({ STELLAR_RPC_URLS: '' }))).rejects.toThrow(
        /at least one/i,
      );
    });

    it('deduplicates repeated endpoint URLs', async () => {
      await createService(
        buildConfig({
          STELLAR_RPC_URLS: [endpointUrls[0], endpointUrls[0], endpointUrls[1]].join(','),
        }),
      );
      const statuses = service.getEndpointStatuses();
      expect(statuses).toHaveLength(2);
    });
  });

  describe('healthy failover', () => {
    it('fails over to a healthy endpoint when the primary fails', async () => {
      await createService(buildConfig());
      clients.get(endpointUrls[0])!.behavior = 'fail';

      const result = await service.execute(RpcOperationType.READ, (client) =>
        client.getLatestLedger(),
      );

      expect(result.sequence).toBe(12345);
      expect(clients.get(endpointUrls[0])!.callCount).toBeGreaterThan(0);
      expect(clients.get(endpointUrls[1])!.callCount).toBeGreaterThan(0);
    });

    it('prefers the primary endpoint while it is healthy', async () => {
      await createService(buildConfig());

      await service.execute(RpcOperationType.READ, (client) => client.getLatestLedger());

      expect(clients.get(endpointUrls[0])!.callCount).toBe(1);
      expect(clients.get(endpointUrls[1])!.callCount).toBe(0);
    });

    it('times out a hanging endpoint and fails over', async () => {
      await createService(buildConfig({ STELLAR_RPC_REQUEST_TIMEOUT_MS: 50 }));
      clients.get(endpointUrls[0])!.behavior = 'hang';

      const result = await service.execute(RpcOperationType.READ, (client) =>
        client.getLatestLedger(),
      );

      expect(result.sequence).toBe(12345);
      expect(clients.get(endpointUrls[1])!.callCount).toBeGreaterThan(0);
    });
  });

  describe('cooldown after failures', () => {
    it('marks an endpoint unhealthy after reaching the failure threshold', async () => {
      await createService(buildConfig({ STELLAR_RPC_FAILURE_THRESHOLD: 2 }));
      clients.get(endpointUrls[0])!.behavior = 'fail';

      await service.execute(RpcOperationType.READ, (client) => client.getLatestLedger());
      await service.execute(RpcOperationType.READ, (client) => client.getLatestLedger());

      const primary = service
        .getEndpointStatuses()
        .find((s) => s.url === endpointUrls[0])!;
      expect(primary.health).toBe(RpcEndpointHealth.UNHEALTHY);
      expect(primary.consecutiveFailures).toBeGreaterThanOrEqual(2);
    });

    it('skips endpoints in cooldown without contacting them', async () => {
      await createService(
        buildConfig({ STELLAR_RPC_FAILURE_THRESHOLD: 1, STELLAR_RPC_COOLDOWN_MS: 60000 }),
      );
      const primary = clients.get(endpointUrls[0])!;
      primary.behavior = 'fail';

      await service.execute(RpcOperationType.READ, (client) => client.getLatestLedger());
      const callsAfterTrip = primary.callCount;

      await service.execute(RpcOperationType.READ, (client) => client.getLatestLedger());

      expect(primary.callCount).toBe(callsAfterTrip);
    });

    it('restores an endpoint to healthy after cooldown and successful probe', async () => {
      jest.useFakeTimers();
      await createService(
        buildConfig({ STELLAR_RPC_FAILURE_THRESHOLD: 1, STELLAR_RPC_COOLDOWN_MS: 1000 }),
      );
      const primary = clients.get(endpointUrls[0])!;
      primary.behavior = 'fail';

      await service.execute(RpcOperationType.READ, (client) => client.getLatestLedger());
      expect(
        service.getEndpointStatuses().find((s) => s.url === endpointUrls[0])!.health,
      ).toBe(RpcEndpointHealth.UNHEALTHY);

      primary.behavior = 'healthy';
      jest.advanceTimersByTime(1500);
      await service.probeEndpoints();

      expect(
        service.getEndpointStatuses().find((s) => s.url === endpointUrls[0])!.health,
      ).toBe(RpcEndpointHealth.HEALTHY);
    });
  });

  describe('bounded retry exhaustion', () => {
    it('throws after exhausting all endpoints and retries', async () => {
      await createService(
        buildConfig({ STELLAR_RPC_MAX_RETRIES: 1, STELLAR_RPC_FAILURE_THRESHOLD: 1 }),
      );
      clients.forEach((client) => {
        client.behavior = 'fail';
      });

      await expect(
        service.execute(RpcOperationType.READ, (client) => client.getLatestLedger()),
      ).rejects.toThrow(/all rpc endpoints/i);
    });

    it('does not retry beyond the configured maximum', async () => {
      await createService(
        buildConfig({ STELLAR_RPC_MAX_RETRIES: 2, STELLAR_RPC_FAILURE_THRESHOLD: 1 }),
      );
      clients.forEach((client) => {
        client.behavior = 'fail';
      });

      await expect(
        service.execute(RpcOperationType.READ, (client) => client.getLatestLedger()),
      ).rejects.toThrow();

      const totalCalls = Array.from(clients.values()).reduce(
        (sum, c) => sum + c.callCount,
        0,
      );
      // maxRetries=2 => at most 3 attempts per endpoint across the pool.
      expect(totalCalls).toBeLessThanOrEqual(endpointUrls.length * 3);
    });
  });

  describe('read vs submit safety', () => {
    it('allows reads to fail over freely across endpoints', async () => {
      await createService(buildConfig());
      clients.get(endpointUrls[0])!.behavior = 'fail';

      const result = await service.execute(RpcOperationType.READ, (client) =>
        client.getAccount('GABC'),
      );

      expect(result.accountId).toBe('GABC');
    });

    it('submits transactions only once even when failing over', async () => {
      await createService(buildConfig());
      clients.get(endpointUrls[0])!.behavior = 'fail';

      const txHash = 'deadbeef';
      const result = await service.execute(RpcOperationType.SUBMIT, (client) =>
        client.submitTransaction(txHash),
      );

      expect(result.hash).toBe(txHash);
      const totalSubmissions = Array.from(clients.values()).reduce(
        (sum, c) => sum + c.submittedTxHashes.length,
        0,
      );
      expect(totalSubmissions).toBe(1);
    });

    it('does not resubmit a transaction that was already accepted', async () => {
      await createService(buildConfig());
      const txHash = 'cafebabe';

      await service.execute(RpcOperationType.SUBMIT, (client) =>
        client.submitTransaction(txHash),
      );

      // A second submit of the same hash must be rejected as a duplicate.
      await expect(
        service.execute(RpcOperationType.SUBMIT, (client) =>
          client.submitTransaction(txHash),
        ),
      ).rejects.toThrow(/duplicate/i);

      const totalSubmissions = Array.from(clients.values()).reduce(
        (sum, c) => sum + c.submittedTxHashes.length,
        0,
      );
      expect(totalSubmissions).toBe(1);
    });

    it('does not fail over a submit to a different endpoint after an ambiguous failure', async () => {
      await createService(buildConfig({ STELLAR_RPC_FAILURE_THRESHOLD: 1 }));
      const primary = clients.get(endpointUrls[0])!;
      primary.behavior = 'fail';

      await expect(
        service.execute(RpcOperationType.SUBMIT, (client) =>
          client.submitTransaction('ambiguous'),
        ),
      ).rejects.toThrow();

      // Submit must not silently retry on the secondary endpoint.
      expect(clients.get(endpointUrls[1])!.submittedTxHashes).toHaveLength(0);
    });
  });

  describe('duplicate-submission prevention during endpoint changes', () => {
    it('tracks in-flight submissions and rejects concurrent duplicates', async () => {
      await createService(buildConfig());
      const txHash = 'inflight';
      clients.get(endpointUrls[0])!.latencyMs = 50;

      const first = service.execute(RpcOperationType.SUBMIT, (client) =>
        client.submitTransaction(txHash),
      );
      const second = service.execute(RpcOperationType.SUBMIT, (client) =>
        client.submitTransaction(txHash),
      );

      await expect(second).rejects.toThrow(/duplicate|in-flight/i);
      await expect(first).resolves.toEqual({ hash: txHash });
    });

    it('releases the in-flight guard after a failed submission', async () => {
      await createService(buildConfig({ STELLAR_RPC_FAILURE_THRESHOLD: 1 }));
      const txHash = 'retryable';
      clients.get(endpointUrls[0])!.behavior = 'fail';

      await expect(
        service.execute(RpcOperationType.SUBMIT, (client) =>
          client.submitTransaction(txHash),
        ),
      ).rejects.toThrow();

      // After failure the guard is released so a deliberate retry can proceed.
      clients.get(endpointUrls[0])!.behavior = 'healthy';
      await expect(
        service.execute(RpcOperationType.SUBMIT, (client) =>
          client.submitTransaction(txHash),
        ),
      ).resolves.toEqual({ hash: txHash });
    });
  });

  describe('endpoint status reporting', () => {
    it('reports health, failure counts, and cooldown expiry', async () => {
      await createService(buildConfig({ STELLAR_RPC_FAILURE_THRESHOLD: 1 }));
      clients.get(endpointUrls[0])!.behavior = 'fail';

      await service.execute(RpcOperationType.READ, (client) => client.getLatestLedger());

      const status = service
        .getEndpointStatuses()
        .find((s) => s.url === endpointUrls[0])!;
      expect(status.health).toBe(RpcEndpointHealth.UNHEALTHY);
      expect(status.cooldownUntil).toBeInstanceOf(Date);
      expect(status.cooldownUntil!.getTime()).toBeGreaterThan(Date.now());
    });
  });
});