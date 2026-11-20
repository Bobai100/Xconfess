import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Topic, TopicStatus } from './entities/topic.entity';
import { TopicAlias } from './entities/topic-alias.entity';
import {
  CreateTopicDto,
  UpdateTopicDto,
  AddTopicAliasDto,
  MergeTopicDto,
} from './dto/topic.dto';

@Injectable()
export class TopicService {
  private readonly logger = new Logger(TopicService.name);

  constructor(
    @InjectRepository(Topic)
    private readonly topicRepo: Repository<Topic>,
    @InjectRepository(TopicAlias)
    private readonly aliasRepo: Repository<TopicAlias>,
  ) {}

  normalizeIdentifier(input: string): string {
    if (!input) return '';
    return input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  async checkUniqueness(normalized: string, excludeTopicId?: string): Promise<void> {
    const existingTopic = await this.topicRepo.findOne({
      where: { slug: normalized },
    });
    if (existingTopic && existingTopic.id !== excludeTopicId) {
      throw new ConflictException(
        `Topic identifier '${normalized}' is already registered as a topic slug`,
      );
    }

    const existingAlias = await this.aliasRepo.findOne({
      where: { alias: normalized },
    });
    if (existingAlias && existingAlias.topicId !== excludeTopicId) {
      throw new ConflictException(
        `Identifier '${normalized}' is already registered as an alias for another topic`,
      );
    }
  }

  async createTopic(dto: CreateTopicDto, actorId?: number): Promise<Topic> {
    const slug = dto.slug
      ? this.normalizeIdentifier(dto.slug)
      : this.normalizeIdentifier(dto.name);

    if (!slug) {
      throw new BadRequestException('A valid topic name or slug is required');
    }

    await this.checkUniqueness(slug);

    const topic = this.topicRepo.create({
      slug,
      name: dto.name,
      description: dto.description,
      status: TopicStatus.ACTIVE,
    });

    const savedTopic = await this.topicRepo.save(topic);

    if (dto.aliases && dto.aliases.length > 0) {
      for (const rawAlias of dto.aliases) {
        const normAlias = this.normalizeIdentifier(rawAlias);
        if (normAlias && normAlias !== slug) {
          await this.checkUniqueness(normAlias);
          await this.aliasRepo.save(
            this.aliasRepo.create({
              alias: normAlias,
              topicId: savedTopic.id,
            }),
          );
        }
      }
    }

    this.logger.log(
      `[AUDIT] TOPIC_CREATED topicId=${savedTopic.id} slug=${savedTopic.slug} actor=${actorId || 'system'}`,
    );

    return this.getTopicById(savedTopic.id);
  }

  async getTopicById(id: string): Promise<Topic> {
    const topic = await this.topicRepo.findOne({
      where: { id },
      relations: ['aliases'],
    });

    if (!topic) {
      throw new NotFoundException(`Topic with ID ${id} not found`);
    }

    return topic;
  }

  async listTopics(status?: TopicStatus): Promise<Topic[]> {
    const query = this.topicRepo
      .createQueryBuilder('topic')
      .leftJoinAndSelect('topic.aliases', 'alias');

    if (status) {
      query.where('topic.status = :status', { status });
    }

    return query.orderBy('topic.name', 'ASC').getMany();
  }

  async updateTopic(
    id: string,
    dto: UpdateTopicDto,
    actorId?: number,
  ): Promise<Topic> {
    const topic = await this.getTopicById(id);

    if (dto.name !== undefined) topic.name = dto.name;
    if (dto.description !== undefined) topic.description = dto.description;

    const saved = await this.topicRepo.save(topic);
    this.logger.log(`[AUDIT] TOPIC_UPDATED topicId=${id} actor=${actorId || 'system'}`);
    return saved;
  }

  async addAlias(
    topicId: string,
    dto: AddTopicAliasDto,
    actorId?: number,
  ): Promise<TopicAlias> {
    const topic = await this.getTopicById(topicId);
    if (topic.status === TopicStatus.MERGED) {
      throw new BadRequestException('Cannot add alias to a merged topic');
    }

    const normAlias = this.normalizeIdentifier(dto.alias);
    if (!normAlias) {
      throw new BadRequestException('Alias must contain valid characters');
    }

    if (normAlias === topic.slug) {
      throw new BadRequestException('Alias cannot be identical to topic slug');
    }

    await this.checkUniqueness(normAlias);

    const aliasEntity = this.aliasRepo.create({
      alias: normAlias,
      topicId: topic.id,
    });

    const saved = await this.aliasRepo.save(aliasEntity);
    this.logger.log(
      `[AUDIT] TOPIC_ALIAS_ADDED topicId=${topicId} alias=${normAlias} actor=${actorId || 'system'}`,
    );
    return saved;
  }

  async removeAlias(
    topicId: string,
    alias: string,
    actorId?: number,
  ): Promise<void> {
    const normAlias = this.normalizeIdentifier(alias);
    const existing = await this.aliasRepo.findOne({
      where: { alias: normAlias, topicId },
    });

    if (!existing) {
      throw new NotFoundException(`Alias '${normAlias}' not found for topic ${topicId}`);
    }

    await this.aliasRepo.remove(existing);
    this.logger.log(
      `[AUDIT] TOPIC_ALIAS_REMOVED topicId=${topicId} alias=${normAlias} actor=${actorId || 'system'}`,
    );
  }

  async retireTopic(id: string, actorId?: number): Promise<Topic> {
    const topic = await this.getTopicById(id);
    if (topic.status === TopicStatus.RETIRED) {
      return topic;
    }

    topic.status = TopicStatus.RETIRED;
    const saved = await this.topicRepo.save(topic);

    this.logger.log(`[AUDIT] TOPIC_RETIRED topicId=${id} slug=${topic.slug} actor=${actorId || 'system'}`);
    return saved;
  }

  async mergeTopics(
    sourceId: string,
    dto: MergeTopicDto,
    actorId?: number,
  ): Promise<Topic> {
    if (sourceId === dto.targetTopicId) {
      throw new BadRequestException('Cannot merge a topic into itself');
    }

    const sourceTopic = await this.getTopicById(sourceId);
    const targetTopic = await this.getTopicById(dto.targetTopicId);

    if (targetTopic.status !== TopicStatus.ACTIVE) {
      throw new BadRequestException('Target topic must be ACTIVE to receive merged topics');
    }

    // Set source status to MERGED
    sourceTopic.status = TopicStatus.MERGED;
    sourceTopic.mergedIntoTopicId = targetTopic.id;
    await this.topicRepo.save(sourceTopic);

    // Convert source slug into an alias on target topic if not already existing
    const existingAlias = await this.aliasRepo.findOne({
      where: { alias: sourceTopic.slug },
    });
    if (!existingAlias) {
      await this.aliasRepo.save(
        this.aliasRepo.create({
          alias: sourceTopic.slug,
          topicId: targetTopic.id,
        }),
      );
    }

    // Re-point all source topic aliases to target topic
    if (sourceTopic.aliases && sourceTopic.aliases.length > 0) {
      for (const al of sourceTopic.aliases) {
        al.topicId = targetTopic.id;
        await this.aliasRepo.save(al);
      }
    }

    this.logger.log(
      `[AUDIT] TOPIC_MERGED sourceId=${sourceId} targetId=${targetTopic.id} actor=${actorId || 'system'}`,
    );

    return this.getTopicById(targetTopic.id);
  }

  async resolveTopic(input: string): Promise<Topic> {
    const norm = this.normalizeIdentifier(input);
    if (!norm) {
      throw new BadRequestException('Invalid topic identifier');
    }

    // Check direct slug
    let topic = await this.topicRepo.findOne({
      where: { slug: norm },
      relations: ['aliases'],
    });

    // Check alias
    if (!topic) {
      const alias = await this.aliasRepo.findOne({
        where: { alias: norm },
        relations: ['topic'],
      });
      if (alias) {
        topic = alias.topic;
      }
    }

    if (!topic) {
      throw new NotFoundException(`No topic found matching identifier '${input}'`);
    }

    // If merged, follow merge lineage recursively
    while (topic.status === TopicStatus.MERGED && topic.mergedIntoTopicId) {
      topic = await this.getTopicById(topic.mergedIntoTopicId);
    }

    return topic;
  }

  assertTopicAssignable(topic: Topic): void {
    if (topic.status === TopicStatus.RETIRED) {
      throw new BadRequestException(
        `Topic '${topic.slug}' is retired and cannot be assigned to new or updated confessions`,
      );
    }
    if (topic.status === TopicStatus.MERGED) {
      throw new BadRequestException(
        `Topic '${topic.slug}' has been merged and cannot be directly assigned. Use the canonical topic instead.`,
      );
    }
  }
}
