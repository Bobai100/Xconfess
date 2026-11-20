import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  OneToMany,
} from 'typeorm';
import { TopicAlias } from './topic-alias.entity';

export enum TopicStatus {
  ACTIVE = 'ACTIVE',
  RETIRED = 'RETIRED',
  MERGED = 'MERGED',
}

@Entity('topics')
export class Topic {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 100, unique: true })
  @Index()
  slug: string;

  @Column({ type: 'varchar', length: 150 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({
    type: 'enum',
    enum: TopicStatus,
    default: TopicStatus.ACTIVE,
  })
  @Index()
  status: TopicStatus;

  @Column({ name: 'merged_into_topic_id', type: 'uuid', nullable: true })
  @Index()
  mergedIntoTopicId?: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToMany(() => TopicAlias, (alias) => alias.topic, { cascade: true })
  aliases: TopicAlias[];
}
