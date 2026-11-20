import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { TopicService } from './topic.service';
import { Topic, TopicStatus } from './entities/topic.entity';
import { TopicAlias } from './entities/topic-alias.entity';
import { ConflictException, BadRequestException, NotFoundException } from '@nestjs/common';

describe('TopicService', () => {
  let service: TopicService;
  let topicRepo: any;
  let aliasRepo: any;

  const mockTopic: Topic = {
    id: 'topic-uuid-1',
    slug: 'mental-health',
    name: 'Mental Health',
    description: 'Mental health and wellbeing confessions',
    status: TopicStatus.ACTIVE,
    createdAt: new Date(),
    updatedAt: new Date(),
    aliases: [],
  };

  beforeEach(async () => {
    topicRepo = {
      create: jest.fn().mockImplementation((d) => ({ ...d, id: 'topic-uuid-1' })),
      save: jest.fn().mockImplementation((t) => Promise.resolve(t)),
      findOne: jest.fn().mockResolvedValue(mockTopic),
      find: jest.fn().mockResolvedValue([mockTopic]),
      createQueryBuilder: jest.fn().mockReturnValue({
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([mockTopic]),
      }),
    };

    aliasRepo = {
      create: jest.fn().mockImplementation((a) => ({ ...a, id: 'alias-uuid-1' })),
      save: jest.fn().mockImplementation((a) => Promise.resolve(a)),
      findOne: jest.fn().mockResolvedValue(null),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TopicService,
        { provide: getRepositoryToken(Topic), useValue: topicRepo },
        { provide: getRepositoryToken(TopicAlias), useValue: aliasRepo },
      ],
    }).compile();

    service = module.get<TopicService>(TopicService);
  });

  it('should normalize topic identifiers consistently', () => {
    expect(service.normalizeIdentifier('  Mental Health & Care! ')).toBe('mental-health-care');
    expect(service.normalizeIdentifier('---tech---talk---')).toBe('tech-talk');
  });

  it('should prevent conflicting slugs or aliases', async () => {
    topicRepo.findOne.mockResolvedValueOnce(mockTopic);
    await expect(
      service.createTopic({ name: 'Mental Health', slug: 'mental-health' }),
    ).rejects.toThrow(ConflictException);
  });

  it('should safely retire a topic and prevent new assignments', async () => {
    const retired = await service.retireTopic('topic-uuid-1', 1);
    expect(retired.status).toBe(TopicStatus.RETIRED);
    expect(() => service.assertTopicAssignable(retired)).toThrow(BadRequestException);
  });

  it('should merge topics and convert source slug into an alias on target', async () => {
    const targetTopic: Topic = {
      id: 'topic-uuid-2',
      slug: 'wellness',
      name: 'Wellness',
      status: TopicStatus.ACTIVE,
      createdAt: new Date(),
      updatedAt: new Date(),
      aliases: [],
    };

    topicRepo.findOne
      .mockResolvedValueOnce(mockTopic) // getTopicById source
      .mockResolvedValueOnce(targetTopic) // getTopicById target
      .mockResolvedValueOnce(targetTopic); // final getTopicById target

    const result = await service.mergeTopics('topic-uuid-1', { targetTopicId: 'topic-uuid-2' }, 1);
    expect(aliasRepo.save).toHaveBeenCalled();
    expect(mockTopic.status).toBe(TopicStatus.MERGED);
  });

  it('should resolve aliases to canonical topics', async () => {
    topicRepo.findOne.mockResolvedValueOnce(null); // not direct slug
    aliasRepo.findOne.mockResolvedValueOnce({
      alias: 'wellbeing',
      topic: mockTopic,
    });

    const resolved = await service.resolveTopic('wellbeing');
    expect(resolved.slug).toBe('mental-health');
  });
});
