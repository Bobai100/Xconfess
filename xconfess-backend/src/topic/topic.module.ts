import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Topic } from './entities/topic.entity';
import { TopicAlias } from './entities/topic-alias.entity';
import { TopicService } from './topic.service';
import { AdminTopicController, PublicTopicController } from './topic.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Topic, TopicAlias])],
  controllers: [AdminTopicController, PublicTopicController],
  providers: [TopicService],
  exports: [TopicService],
})
export class TopicModule {}
