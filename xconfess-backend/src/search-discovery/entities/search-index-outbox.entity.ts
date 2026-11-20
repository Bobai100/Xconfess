import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export enum SearchOutboxAction {
  INDEX_UPSERT = 'INDEX_UPSERT',
  INDEX_DELETE = 'INDEX_DELETE',
  TOPIC_SYNC = 'TOPIC_SYNC',
}

export enum SearchOutboxStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

@Entity('search_index_outbox')
@Index(['status', 'nextRetryAt'])
export class SearchIndexOutbox {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'entity_type', type: 'varchar', length: 64 })
  @Index()
  entityType: string;

  @Column({ name: 'entity_id', type: 'varchar', length: 128 })
  @Index()
  entityId: string;

  @Column({
    type: 'enum',
    enum: SearchOutboxAction,
    default: SearchOutboxAction.INDEX_UPSERT,
  })
  action: SearchOutboxAction;

  @Column({ type: 'jsonb' })
  payload: Record<string, any>;

  @Column({
    type: 'enum',
    enum: SearchOutboxStatus,
    default: SearchOutboxStatus.PENDING,
  })
  @Index()
  status: SearchOutboxStatus;

  @Column({ type: 'integer', default: 0 })
  attempts: number;

  @Column({ name: 'max_attempts', type: 'integer', default: 5 })
  maxAttempts: number;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError?: string;

  @Column({ name: 'next_retry_at', type: 'timestamptz', nullable: true })
  nextRetryAt?: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt?: Date;
}
