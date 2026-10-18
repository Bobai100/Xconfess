import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { AnonymousConfession } from '../../confession/entities/confession.entity';

export enum TipVerificationStatus {
  PENDING = 'pending',
  STALE_PENDING = 'stale_pending',
  VERIFIED = 'verified',
  REJECTED = 'rejected',
  CONFLICT = 'conflict',
}

/**
 * User-visible finality of a tip's on-chain transaction.
 *
 * A submitted transaction is not equivalent to one that is included and
 * finalized on the expected network, so the ledger only exposes transitions
 * that have been verified against RPC observations.
 */
export enum TipFinalityState {
  /** Observed by RPC but not yet included in a ledger. */
  ACCEPTED = 'accepted',
  /** Included in a ledger but not yet finalized. */
  INCLUDED = 'included',
  /** Included and finalized on the expected network. */
  FINALIZED = 'finalized',
  /** Included but the transaction failed on-chain. */
  FAILED = 'failed',
  /** No reliable observation yet (e.g. RPC lag or conflicting responses). */
  UNKNOWN = 'unknown',
}

@Entity('tips')
export class Tip {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'confession_id', type: 'uuid' })
  @Index()
  confessionId: string;

  @ManyToOne(() => AnonymousConfession, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'confession_id' })
  confession: AnonymousConfession;

  @Column({ type: 'decimal', precision: 20, scale: 7 })
  amount: number;

  @Column({ name: 'tx_id', type: 'varchar', length: 64, unique: true })
  @Index()
  txId: string;

  /**
   * Stable identifier shared by an original transaction and all of its
   * fee-bump replacements so the ledger records one logical operation.
   */
  @Column({ name: 'logical_tx_id', type: 'varchar', length: 64, nullable: true })
  @Index()
  logicalTxId: string | null;

  /** Hash of the first transaction submitted for this logical operation. */
  @Column({
    name: 'original_tx_hash',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  @Index()
  originalTxHash: string | null;

  /** Hash of the fee-bump replacement that superseded the original, if any. */
  @Column({
    name: 'replacement_tx_hash',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  @Index()
  replacementTxHash: string | null;

  @Column({
    name: 'finality_state',
    type: 'enum',
    enum: TipFinalityState,
    default: TipFinalityState.UNKNOWN,
  })
  @Index()
  finalityState: TipFinalityState;

  /** Ledger (network) the finality observation was made against. */
  @Column({
    name: 'finality_ledger',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  finalityLedger: string | null;

  @Column({ name: 'finality_observed_at', type: 'timestamp', nullable: true })
  finalityObservedAt: Date | null;

  /**
   * SHA-256(confessionId:txId) — DB-enforced uniqueness prevents double-credit
   * on concurrent verify calls hitting the same (confession, tx) pair.
   * The partial unique index in the migration covers only non-NULL values so
   * reconciliation rows that start without a key don't collide.
   */
  @Column({
    name: 'idempotency_key',
    type: 'varchar',
    length: 128,
    nullable: true,
  })
  @Index({ unique: true })
  idempotencyKey: string | null;

  @Column({
    name: 'sender_address',
    type: 'varchar',
    length: 56,
    nullable: true,
  })
  senderAddress: string | null;

  @Column({
    name: 'verification_status',
    type: 'enum',
    enum: TipVerificationStatus,
    default: TipVerificationStatus.VERIFIED,
  })
  verificationStatus: TipVerificationStatus;

  @Column({ name: 'verified_at', type: 'timestamp', nullable: true })
  verifiedAt: Date | null;

  @Column({ name: 'rejection_reason', type: 'text', nullable: true })
  rejectionReason: string | null;

  @Column({ name: 'retry_count', type: 'int', default: 0 })
  retryCount: number;

  @Column({ name: 'last_chain_status', type: 'varchar', length: 50, nullable: true })
  lastChainStatus: string | null;

  @Column({ name: 'last_checked_at', type: 'timestamp', nullable: true })
  lastCheckedAt: Date | null;

  @Column({ name: 'reconciliation_metadata', type: 'jsonb', nullable: true })
  reconciliationMetadata: Record<string, any> | null;

  @Column({ name: 'processing_lock', type: 'varchar', length: 64, nullable: true })
  processingLock: string | null;

  @Column({ name: 'locked_at', type: 'timestamp', nullable: true })
  lockedAt: Date | null;

  @Column({ name: 'locked_by', type: 'varchar', length: 100, nullable: true })
  lockedBy: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
