import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export const SENSITIVE_REPORT_QUEUE_SCOPE = 'sensitive-report-queue';

@Entity('moderation_access_grants')
@Index(['userId', 'scope', 'expiresAt'])
@Index(['grantedById', 'createdAt'])
export class ModerationAccessGrant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'int' })
  userId: number;

  @Column({ name: 'granted_by_id', type: 'int' })
  grantedById: number;

  @Column({ type: 'varchar', length: 64 })
  scope: string;

  @Column({ type: 'text' })
  reason: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @Column({ name: 'revoked_by_id', type: 'int', nullable: true })
  revokedById: number | null;
}
