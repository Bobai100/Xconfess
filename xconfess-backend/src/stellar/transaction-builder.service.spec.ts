import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  TransactionBuilderService,
  SimulationEnvelope,
  SimulationFreshnessError,
} from './transaction-builder.service';

describe('TransactionBuilderService - simulation freshness enforcement', () => {
  let service: TransactionBuilderService;
  let configService: ConfigService;

  const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
  const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
  const OPERATION_HASH = 'a'.repeat(64);
  const FRESHNESS_WINDOW_MS = 30_000;

  const buildEnvelope = (
    overrides: Partial<SimulationEnvelope> = {},
  ): SimulationEnvelope => ({
    networkPassphrase: NETWORK_PASSPHRASE,
    contractId: CONTRACT_ID,
    operationHash: OPERATION_HASH,
    ledgerSequence: 1000,
    simulatedAt: Date.now(),
    xdr: 'AAAAAgAAAAA=',
    ...overrides,
  });

  const buildSubmission = (
    overrides: Partial<{
      networkPassphrase: string;
      contractId: string;
      operationHash: string;
      currentLedgerSequence: number;
    }> = {},
  ) => ({
    networkPassphrase: NETWORK_PASSPHRASE,
    contractId: CONTRACT_ID,
    operationHash: OPERATION_HASH,
    currentLedgerSequence: 1000,
    ...overrides,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionBuilderService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'stellar.simulationFreshnessWindowMs') {
                return FRESHNESS_WINDOW_MS;
              }
              if (key === 'stellar.networkPassphrase') {
                return NETWORK_PASSPHRASE;
              }
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<TransactionBuilderService>(TransactionBuilderService);
    configService = module.get<ConfigService>(ConfigService);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('expected path', () => {
    it('submits a fresh envelope bound to matching network, contract, and operation', () => {
      const envelope = buildEnvelope();
      const submission = buildSubmission();

      expect(() =>
        service.assertSimulationFresh(envelope, submission),
      ).not.toThrow();
    });

    it('accepts an envelope exactly at the freshness boundary', () => {
      const now = 1_700_000_000_000;
      jest.useFakeTimers().setSystemTime(now);

      const envelope = buildEnvelope({ simulatedAt: now - FRESHNESS_WINDOW_MS });
      const submission = buildSubmission();

      expect(() =>
        service.assertSimulationFresh(envelope, submission),
      ).not.toThrow();
    });

    it('accepts an envelope when ledger sequence is unchanged', () => {
      const envelope = buildEnvelope({ ledgerSequence: 5000 });
      const submission = buildSubmission({ currentLedgerSequence: 5000 });

      expect(() =>
        service.assertSimulationFresh(envelope, submission),
      ).not.toThrow();
    });
  });

  describe('rejection: aged envelope', () => {
    it('rejects an envelope whose timestamp is past the freshness window', () => {
      const now = 1_700_000_000_000;
      jest.useFakeTimers().setSystemTime(now);

      const envelope = buildEnvelope({
        simulatedAt: now - FRESHNESS_WINDOW_MS - 1,
      });
      const submission = buildSubmission();

      expect(() =>
        service.assertSimulationFresh(envelope, submission),
      ).toThrow(SimulationFreshnessError);
    });

    it('rejects an envelope simulated in the future beyond tolerance', () => {
      const now = 1_700_000_000_000;
      jest.useFakeTimers().setSystemTime(now);

      const envelope = buildEnvelope({
        simulatedAt: now + FRESHNESS_WINDOW_MS + 1,
      });
      const submission = buildSubmission();

      expect(() =>
        service.assertSimulationFresh(envelope, submission),
      ).toThrow(SimulationFreshnessError);
    });

    it('rejects an envelope with a missing simulatedAt timestamp', () => {
      const envelope = buildEnvelope({
        simulatedAt: undefined as unknown as number,
      });
      const submission = buildSubmission();

      expect(() =>
        service.assertSimulationFresh(envelope, submission),
      ).toThrow(SimulationFreshnessError);
    });
  });

  describe('rejection: mismatched binding', () => {
    it('rejects when network passphrase does not match', () => {
      const envelope = buildEnvelope();
      const submission = buildSubmission({
        networkPassphrase: 'Public Global Stellar Network ; September 2015',
      });

      expect(() =>
        service.assertSimulationFresh(envelope, submission),
      ).toThrow(SimulationFreshnessError);
    });

    it('rejects when contractId does not match', () => {
      const envelope = buildEnvelope();
      const submission = buildSubmission({
        contractId: 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      });

      expect(() =>
        service.assertSimulationFresh(envelope, submission),
      ).toThrow(SimulationFreshnessError);
    });

    it('rejects when operationHash does not match', () => {
      const envelope = buildEnvelope();
      const submission = buildSubmission({ operationHash: 'b'.repeat(64) });

      expect(() =>
        service.assertSimulationFresh(envelope, submission),
      ).toThrow(SimulationFreshnessError);
    });
  });

  describe('rejection: advanced ledger sequence', () => {
    it('rejects when the ledger sequence has advanced since simulation', () => {
      const envelope = buildEnvelope({ ledgerSequence: 1000 });
      const submission = buildSubmission({ currentLedgerSequence: 1001 });

      expect(() =>
        service.assertSimulationFresh(envelope, submission),
      ).toThrow(SimulationFreshnessError);
    });

    it('rejects when the ledger sequence has regressed', () => {
      const envelope = buildEnvelope({ ledgerSequence: 1000 });
      const submission = buildSubmission({ currentLedgerSequence: 999 });

      expect(() =>
        service.assertSimulationFresh(envelope, submission),
      ).toThrow(SimulationFreshnessError);
    });
  });

  describe('regression: stale simulation is never submitted', () => {
    it('does not invoke the submit callback when the envelope is stale', async () => {
      const now = 1_700_000_000_000;
      jest.useFakeTimers().setSystemTime(now);

      const submit = jest.fn().mockResolvedValue({ hash: 'deadbeef' });
      const envelope = buildEnvelope({
        simulatedAt: now - FRESHNESS_WINDOW_MS - 1,
      });
      const submission = buildSubmission();

      await expect(
        service.submitSimulatedTransaction(envelope, submission, submit),
      ).rejects.toBeInstanceOf(SimulationFreshnessError);

      expect(submit).not.toHaveBeenCalled();
    });

    it('does not invoke the submit callback when binding mismatches', async () => {
      const submit = jest.fn().mockResolvedValue({ hash: 'deadbeef' });
      const envelope = buildEnvelope();
      const submission = buildSubmission({ operationHash: 'c'.repeat(64) });

      await expect(
        service.submitSimulatedTransaction(envelope, submission, submit),
      ).rejects.toBeInstanceOf(SimulationFreshnessError);

      expect(submit).not.toHaveBeenCalled();
    });

    it('does not invoke the submit callback when the ledger advanced', async () => {
      const submit = jest.fn().mockResolvedValue({ hash: 'deadbeef' });
      const envelope = buildEnvelope({ ledgerSequence: 1000 });
      const submission = buildSubmission({ currentLedgerSequence: 1002 });

      await expect(
        service.submitSimulatedTransaction(envelope, submission, submit),
      ).rejects.toBeInstanceOf(SimulationFreshnessError);

      expect(submit).not.toHaveBeenCalled();
    });

    it('invokes the submit callback exactly once for a fresh envelope', async () => {
      const submit = jest.fn().mockResolvedValue({ hash: 'cafebabe' });
      const envelope = buildEnvelope();
      const submission = buildSubmission();

      const result = await service.submitSimulatedTransaction(
        envelope,
        submission,
        submit,
      );

      expect(submit).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ hash: 'cafebabe' });
    });
  });

  describe('configuration', () => {
    it('reads the freshness window from configuration', () => {
      expect(configService.get).toHaveBeenCalledWith(
        'stellar.simulationFreshnessWindowMs',
      );
    });
  });
});