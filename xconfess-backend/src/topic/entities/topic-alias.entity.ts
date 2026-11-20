import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Topic } from './topic.entity';

@Entity('topic_aliases')
export class TopicAlias {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 100, unique: true })
  @Index()
  alias: string;

  @Column({ name: 'topic_id', type: 'uuid' })
  @Index()
  topicId: string;

  @ManyToOne(() => Topic, (topic) => topic.aliases, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'topic_id' })
  topic: Topic;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
