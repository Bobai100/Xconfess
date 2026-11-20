import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('api_deprecation_metrics')
@Index(['method', 'endpointPath'], { unique: true })
export class ApiDeprecationMetric {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'endpoint_path', type: 'varchar', length: 255 })
  endpointPath: string;

  @Column({ type: 'varchar', length: 16 })
  method: string;

  @Column({ name: 'call_count', type: 'bigint', default: 1 })
  callCount: number;

  @Column({ name: 'first_seen_at', type: 'timestamptz' })
  firstSeenAt: Date;

  @Column({ name: 'last_seen_at', type: 'timestamptz' })
  lastSeenAt: Date;

  @Column({ name: 'sample_client_family', type: 'varchar', length: 128, nullable: true })
  sampleClientFamily?: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
