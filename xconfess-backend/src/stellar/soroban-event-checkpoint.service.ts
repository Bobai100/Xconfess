import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AnalyticsEventService } from '../analytics/analytics-event.service';
import { AnalyticsNetwork } from '../analytics/entities/analytics-event.entity';
import { SorobanEventCheckpoint } from './entities/soroban-event-checkpoint.entity';

export interface RecordSorobanEventInput {
  network: AnalyticsNetwork;
  contractId: string;
  ledger: number;
  cursor?: string | null;
  txHash?: string | null;
  eventTopic?: string | null;
  idempotencyKey?: string | null;
}

export interface RecordSorobanFailureInput {
  network: AnalyticsNetwork;
  contractId: string;
  errorCode: string;
}

export interface SorobanIndexerSummary {
  checkpoints: number;
  indexedEvents: number;
  failedEvents: number;
  lastIndexedAt: string | null;
  lastErrorAt: string | null;
}

const VALID_NETWORKS = new Set<AnalyticsNetwork>(['testnet', 'mainnet']);
const CONTRACT_ID_PATTERN = /^C[A-Z2-7]{55}$/;

/** Maximum number of ledgers a single verification range may span. */
export const MAX_VERIFICATION_RANGE_LEDGERS = 10_000;
/** Maximum number of checkpoints a single verification run may inspect. */
export const MAX_VERIFICATION_CHECKPOINTS = 100;
/** Maximum number of ledgers a bounded reprocessing run may re-fetch. */
export const MAX_REPROCESS_RANGE_LEDGERS = 1_000;

export interface SorobanLedgerEvent {
  ledger: number;
  contractId: string;
  cursor: string | null;
  txHash: string | null;
  eventTopic: string | null;
}

/**
 * Read-only source of ledger events used by the verifier. Implementations must
 * be side-effect free; the verifier never mutates ledger state.
 */
export interface SorobanLedgerEventSource {
  fetchEvents(params: {
    network: AnalyticsNetwork;
    contractId: string;
    fromLedger: number;
    toLedger: number;
  }): Promise<SorobanLedgerEvent[]>;
}

export interface SorobanRangeGap {
  network: AnalyticsNetwork;
  contractId: string;
  fromLedger: number;
  toLedger: number;
  /** Ledgers present on-chain but missing from the index. */
  missingLedgers: number[];
  /** Ledgers where the indexed cursor/topic differs from the ledger data. */
  mismatchedLedgers: number[];
  /** Events returned by the network but not present in the index. */
  missingEventCount: number;
  /** Events present in the index but not returned by the network. */
  extraEventCount: number;
}

export interface SorobanCheckpointVerification {
  network: AnalyticsNetwork;
  contractId: string;
  lastLedger: number;
  fromLedger: number;
  toLedger: number;
  ledgerEventCount: number;
  indexedEventCount: number;
  gaps: SorobanRangeGap[];
  ok: boolean;
}

export interface SorobanVerificationReport {
  generatedAt: string;
  checkpointsInspected: number;
  checkpointsWithGaps: number;
  results: SorobanCheckpointVerification[];
}

export interface VerifyRangesOptions {
  network?: AnalyticsNetwork;
  contractId?: string;
  /** Inclusive lower bound; defaults to the checkpoint's first indexed ledger. */
  fromLedger?: number;
  /** Inclusive upper bound; defaults to the checkpoint's last ledger. */
  toLedger?: number;
  /** Hard cap on checkpoints inspected in this run. */
  maxCheckpoints?: number;
}

export interface ReprocessRangeOptions {
  network: AnalyticsNetwork;
  contractId: string;
  fromLedger: number;
  toLedger: number;
  /** Explicit authorization token required to trigger reprocessing. */
  authorization: string;
  /** Caller identity recorded in the audit log. */
  requestedBy: string;
}

export interface ReprocessRangeResult {
  network: AnalyticsNetwork;
  contractId: string;
  fromLedger: number;
  toLedger: number;
  reprocessedEvents: number;
  auditId: string;
}

/** Authorization scope required to trigger bounded reprocessing. */
export const REPROCESS_AUTHORIZATION_SCOPE = 'soroban:reprocess';
=======

@Injectable()
export class SorobanEventCheckpointService {
  private readonly logger = new Logger(SorobanEventCheckpointService.name);

  constructor(
    @InjectRepository(SorobanEventCheckpoint)
    private readonly checkpointRepository: Repository<SorobanEventCheckpoint>,
    @Optional()
    private readonly analyticsEventService?: AnalyticsEventService,
    @Optional()
    private readonly ledgerEventSource?: SorobanLedgerEventSource,
  ) {}

  async recordIndexedEvent(input: RecordSorobanEventInput): Promise<void> {
    this.assertValidInput(input);

    await this.checkpointRepository.query(
      `
        INSERT INTO "soroban_event_checkpoints" (
          "network",
          "contract_id",
          "last_ledger",
          "last_cursor",
          "indexed_events",
          "failed_events",
          "last_error_code",
          "last_error_at",
          "last_indexed_at",
          "created_at",
          "updated_at"
        )
        VALUES ($1, $2, $3, $4, 1, 0, NULL, NULL, now(), now(), now())
        ON CONFLICT ("network", "contract_id")
        DO UPDATE SET
          "last_ledger" = GREATEST("soroban_event_checkpoints"."last_ledger", EXCLUDED."last_ledger"),
          "last_cursor" = CASE
            WHEN EXCLUDED."last_ledger" >= "soroban_event_checkpoints"."last_ledger"
            THEN EXCLUDED."last_cursor"
            ELSE "soroban_event_checkpoints"."last_cursor"
          END,
          "indexed_events" = "soroban_event_checkpoints"."indexed_events" + 1,
          "last_error_code" = NULL,
          "last_indexed_at" = now(),
          "updated_at" = now()
      `,
      [input.network, input.contractId, input.ledger, input.cursor ?? null],
    );

    await this.analyticsEventService
      ?.record({
        eventName: 'soroban_event_indexed',
        network: input.network,
        txHash: input.txHash ?? null,
        contractId: input.contractId,
        idempotencyKey:
          input.idempotencyKey ??
          `soroban_event_indexed:${input.contractId}:${input.ledger}:${input.cursor ?? 'no-cursor'}`,
        metadata: {
          source: 'soroban_event_checkpoint',
          state: 'indexed',
        },
      })
      .catch((err) =>
        this.logger.warn(
          `Failed to record Soroban index analytics: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
  }

  async recordFailure(input: RecordSorobanFailureInput): Promise<void> {
    this.assertValidNetwork(input.network);
    this.assertValidContractId(input.contractId);

    const errorCode = input.errorCode.replace(/[^A-Z0-9_]/gi, '_').slice(0, 64);
    if (!errorCode) {
      throw new BadRequestException('Soroban index failure requires errorCode');
    }

    await this.checkpointRepository.query(
      `
        INSERT INTO "soroban_event_checkpoints" (
          "network",
          "contract_id",
          "last_ledger",
          "last_cursor",
          "indexed_events",
          "failed_events",
          "last_error_code",
          "last_error_at",
          "last_indexed_at",
          "created_at",
          "updated_at"
        )
        VALUES ($1, $2, 0, NULL, 0, 1, $3, now(), NULL, now(), now())
        ON CONFLICT ("network", "contract_id")
        DO UPDATE SET
          "failed_events" = "soroban_event_checkpoints"."failed_events" + 1,
          "last_error_code" = EXCLUDED."last_error_code",
          "last_error_at" = now(),
          "updated_at" = now()
      `,
      [input.network, input.contractId, errorCode],
    );
  }

  async getCheckpoint(
    network: AnalyticsNetwork,
    contractId: string,
  ): Promise<SorobanEventCheckpoint | null> {
    this.assertValidNetwork(network);
    this.assertValidContractId(contractId);
    return this.checkpointRepository.findOne({ where: { network, contractId } });
  }

  /**
   * Read-only verification of indexed ranges against ledger data. Never mutates
   * checkpoints; reports gaps keyed by checkpoint.
   */
  async verifyRanges(
    options: VerifyRangesOptions = {},
  ): Promise<SorobanVerificationReport> {
    if (options.network !== undefined) {
      this.assertValidNetwork(options.network);
    }
    if (options.contractId !== undefined) {
      this.assertValidContractId(options.contractId);
    }
    this.assertValidLedgerBound(options.fromLedger, 'fromLedger');
    this.assertValidLedgerBound(options.toLedger, 'toLedger');
    if (
      options.fromLedger !== undefined &&
      options.toLedger !== undefined &&
      options.fromLedger > options.toLedger
    ) {
      throw new BadRequestException('fromLedger must not exceed toLedger');
    }

    const maxCheckpoints = options.maxCheckpoints ?? MAX_VERIFICATION_CHECKPOINTS;
    if (!Number.isSafeInteger(maxCheckpoints) || maxCheckpoints <= 0) {
      throw new BadRequestException('maxCheckpoints must be a positive integer');
    }
    if (maxCheckpoints > MAX_VERIFICATION_CHECKPOINTS) {
      throw new BadRequestException(
        `maxCheckpoints exceeds hard limit of ${MAX_VERIFICATION_CHECKPOINTS}`,
      );
    }

    const source = this.requireLedgerEventSource();

    const where: Record<string, unknown> = {};
    if (options.network !== undefined) {
      where.network = options.network;
    }
    if (options.contractId !== undefined) {
      where.contractId = options.contractId;
    }

    const checkpoints = await this.checkpointRepository.find({
      where,
      order: { network: 'ASC', contractId: 'ASC' },
      take: maxCheckpoints,
    });

    const results: SorobanCheckpointVerification[] = [];
    for (const checkpoint of checkpoints) {
      results.push(await this.verifyCheckpoint(checkpoint, source, options));
    }

    const report: SorobanVerificationReport = {
      generatedAt: new Date().toISOString(),
      checkpointsInspected: results.length,
      checkpointsWithGaps: results.filter((r) => !r.ok).length,
      results,
    };

    this.logger.log(
      `Soroban verification inspected=${report.checkpointsInspected} withGaps=${report.checkpointsWithGaps}`,
    );

    return report;
  }

  /**
   * Bounded, explicitly authorized reprocessing of a single range. Re-fetches
   * ledger events and records an audit entry. Does not rewrite checkpoints.
   */
  async reprocessRange(
    options: ReprocessRangeOptions,
  ): Promise<ReprocessRangeResult> {
    this.assertValidNetwork(options.network);
    this.assertValidContractId(options.contractId);
    this.assertValidLedgerBound(options.fromLedger, 'fromLedger');
    this.assertValidLedgerBound(options.toLedger, 'toLedger');

    if (options.fromLedger > options.toLedger) {
      throw new BadRequestException('fromLedger must not exceed toLedger');
    }

    const span = options.toLedger - options.fromLedger + 1;
    if (span > MAX_REPROCESS_RANGE_LEDGERS) {
      throw new BadRequestException(
        `Reprocess range exceeds hard limit of ${MAX_REPROCESS_RANGE_LEDGERS} ledgers`,
      );
    }

    if (
      typeof options.authorization !== 'string' ||
      options.authorization !== REPROCESS_AUTHORIZATION_SCOPE
    ) {
      throw new BadRequestException(
        `Reprocessing requires authorization scope "${REPROCESS_AUTHORIZATION_SCOPE}"`,
      );
    }

    if (
      typeof options.requestedBy !== 'string' ||
      options.requestedBy.trim().length === 0
    ) {
      throw new BadRequestException('Reprocessing requires requestedBy identity');
    }

    const source = this.requireLedgerEventSource();
    const events = await source.fetchEvents({
      network: options.network,
      contractId: options.contractId,
      fromLedger: options.fromLedger,
      toLedger: options.toLedger,
    });

    const auditId = `soroban_reprocess:${options.network}:${options.contractId}:${options.fromLedger}-${options.toLedger}:${Date.now()}`;

    this.logger.log(
      `Soroban bounded reprocess auditId=${auditId} requestedBy=${options.requestedBy} events=${events.length}`,
    );

    await this.analyticsEventService
      ?.record({
        eventName: 'soroban_range_reprocessed',
        network: options.network,
        txHash: null,
        contractId: options.contractId,
        idempotencyKey: auditId,
        metadata: {
          source: 'soroban_event_checkpoint',
          state: 'reprocessed',
          fromLedger: options.fromLedger,
          toLedger: options.toLedger,
          requestedBy: options.requestedBy,
          reprocessedEvents: events.length,
        },
      })
      .catch((err) =>
        this.logger.warn(
          `Failed to record Soroban reprocess analytics: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );

    return {
      network: options.network,
      contractId: options.contractId,
      fromLedger: options.fromLedger,
      toLedger: options.toLedger,
      reprocessedEvents: events.length,
      auditId,
    };
  }

  private async verifyCheckpoint(
    checkpoint: SorobanEventCheckpoint,
    source: SorobanLedgerEventSource,
    options: VerifyRangesOptions,
  ): Promise<SorobanCheckpointVerification> {
    const fromLedger = options.fromLedger ?? 0;
    const toLedger = options.toLedger ?? checkpoint.lastLedger;

    if (toLedger - fromLedger + 1 > MAX_VERIFICATION_RANGE_LEDGERS) {
      throw new BadRequestException(
        `Verification range exceeds hard limit of ${MAX_VERIFICATION_RANGE_LEDGERS} ledgers`,
      );
    }

    const ledgerEvents = await source.fetchEvents({
      network: checkpoint.network,
      contractId: checkpoint.contractId,
      fromLedger,
      toLedger,
    });

    const ledgerByKey = new Map<string, SorobanLedgerEvent>();
    for (const event of ledgerEvents) {
      ledgerByKey.set(this.eventKey(event), event);
    }

    const indexedEvents = await this.fetchIndexedEvents(
      checkpoint.network,
      checkpoint.contractId,
      fromLedger,
      toLedger,
    );
    const indexedByKey = new Map<string, SorobanLedgerEvent>();
    for (const event of indexedEvents) {
      indexedByKey.set(this.eventKey(event), event);
    }

    const missingLedgers = new Set<number>();
    const mismatchedLedgers = new Set<number>();
    let missingEventCount = 0;

    for (const [key, ledgerEvent] of ledgerByKey) {
      const indexed = indexedByKey.get(key);
      if (!indexed) {
        missingEventCount += 1;
        missingLedgers.add(ledgerEvent.ledger);
        continue;
      }
      if (
        (indexed.cursor ?? null) !== (ledgerEvent.cursor ?? null) ||
        (indexed.eventTopic ?? null) !== (ledgerEvent.eventTopic ?? null)
      ) {
        mismatchedLedgers.add(ledgerEvent.ledger);
      }
    }

    const extraLedgers = new Set<number>();
    let extraEventCount = 0;
    for (const [key, indexed] of indexedByKey) {
      if (!ledgerByKey.has(key)) {
        extraEventCount += 1;
        extraLedgers.add(indexed.ledger);
      }
    }

    const gaps: SorobanRangeGap[] = [];
    if (missingEventCount > 0 || mismatchedLedgers.size > 0 || extraEventCount > 0) {
      gaps.push({
        network: checkpoint.network,
        contractId: checkpoint.contractId,
        fromLedger,
        toLedger,
        missingLedgers: [...missingLedgers].sort((a, b) => a - b),
        mismatchedLedgers: [...mismatchedLedgers].sort((a, b) => a - b),
        missingEventCount,
        extraEventCount,
      });
    }

    return {
      network: checkpoint.network,
      contractId: checkpoint.contractId,
      lastLedger: checkpoint.lastLedger,
      fromLedger,
      toLedger,
      ledgerEventCount: ledgerEvents.length,
      indexedEventCount: indexedEvents.length,
      gaps,
      ok: gaps.length === 0,
    };
  }

  private async fetchIndexedEvents(
    network: AnalyticsNetwork,
    contractId: string,
    fromLedger: number,
    toLedger: number,
  ): Promise<SorobanLedgerEvent[]> {
    const rows: Array<{
      ledger: number | string;
      cursor: string | null;
      tx_hash: string | null;
      event_topic: string | null;
    }> = await this.checkpointRepository.query(
      `
        SELECT "ledger", "cursor", "tx_hash", "event_topic"
        FROM "soroban_indexed_events"
        WHERE "network" = $1
          AND "contract_id" = $2
          AND "ledger" BETWEEN $3 AND $4
        ORDER BY "ledger" ASC, "cursor" ASC
      `,
      [network, contractId, fromLedger, toLedger],
    );

    return rows.map((row) => ({
      ledger: Number(row.ledger),
      contractId,
      cursor: row.cursor ?? null,
      txHash: row.tx_hash ?? null,
      eventTopic: row.event_topic ?? null,
    }));
  }

  private eventKey(event: SorobanLedgerEvent): string {
    return `${event.ledger}:${event.cursor ?? ''}:${event.txHash ?? ''}`;
  }

  private requireLedgerEventSource(): SorobanLedgerEventSource {
    if (!this.ledgerEventSource) {
      throw new BadRequestException(
        'Soroban ledger event source is not configured for verification',
      );
    }
    return this.ledgerEventSource;
  }

  private assertValidLedgerBound(
    value: number | undefined,
    field: string,
  ): void {
    if (value === undefined) {
      return;
    }
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new BadRequestException(`${field} must be a non-negative safe integer`);
    }
  }

  async getSummary(): Promise<SorobanIndexerSummary> {
    const checkpoints = await this.checkpointRepository.find({
      select: {
        indexedEvents: true,
        failedEvents: true,
        lastIndexedAt: true,
        lastErrorAt: true,
      },
    });

    return checkpoints.reduce<SorobanIndexerSummary>(
      (summary, checkpoint) => ({
        checkpoints: summary.checkpoints + 1,
        indexedEvents: summary.indexedEvents + checkpoint.indexedEvents,
        failedEvents: summary.failedEvents + checkpoint.failedEvents,
        lastIndexedAt: this.maxIso(summary.lastIndexedAt, checkpoint.lastIndexedAt),
        lastErrorAt: this.maxIso(summary.lastErrorAt, checkpoint.lastErrorAt),
      }),
      {
        checkpoints: 0,
        indexedEvents: 0,
        failedEvents: 0,
        lastIndexedAt: null,
        lastErrorAt: null,
      },
    );
  }

  private assertValidInput(input: RecordSorobanEventInput): void {
    this.assertValidNetwork(input.network);
    this.assertValidContractId(input.contractId);

    if (!Number.isSafeInteger(input.ledger) || input.ledger < 0) {
      throw new BadRequestException('Soroban event ledger must be a safe integer');
    }

    if (input.cursor !== undefined && input.cursor !== null && input.cursor.length > 256) {
      throw new BadRequestException('Soroban event cursor exceeds 256 characters');
    }
  }

  private assertValidNetwork(network: string): void {
    if (!VALID_NETWORKS.has(network as AnalyticsNetwork)) {
      throw new BadRequestException('Unsupported Stellar network');
    }
  }

  private assertValidContractId(contractId: string): void {
    if (!CONTRACT_ID_PATTERN.test(contractId)) {
      throw new BadRequestException('Invalid Soroban contract ID');
    }
  }

  private maxIso(current: string | null, next: Date | null): string | null {
    if (!next) {
      return current;
    }
    const nextIso = next.toISOString();
    if (!current || nextIso > current) {
      return nextIso;
    }
    return current;
  }
}
