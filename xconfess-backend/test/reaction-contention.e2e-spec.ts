import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AnonymousConfession } from '../src/confession/entities/confession.entity';
import { Reaction } from '../src/reaction/entities/reaction.entity';
import { ReactionService } from '../src/reaction/reaction.service';
import { ReactionsGateway } from '../src/reaction/reactions.gateway';
import { AnonymousUser } from '../src/user/entities/anonymous-user.entity';

describe('Reaction mutation contention (PostgreSQL e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let reactionService: ReactionService;
  let anonymousUser: AnonymousUser;
  let confession: AnonymousConfession;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    dataSource = app.get(DataSource);
    reactionService = app.get(ReactionService);
  }, 30000);

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      if (confession?.id) {
        await dataSource.getRepository(AnonymousConfession).delete(confession.id);
      }
      if (anonymousUser?.id) {
        await dataSource.getRepository(AnonymousUser).delete(anonymousUser.id);
      }
    }
    await app?.close();
  });

  it('returns one canonical reaction for synchronized duplicate requests', async () => {
    const anonymousUserRepository = dataSource.getRepository(AnonymousUser);
    const confessionRepository = dataSource.getRepository(AnonymousConfession);
    const reactionRepository = dataSource.getRepository(Reaction);

    anonymousUser = await anonymousUserRepository.save(
      anonymousUserRepository.create({}),
    );
    confession = await confessionRepository.save(
      confessionRepository.create({
        message: 'Concurrent reaction test fixture',
        anonymousUserId: anonymousUser.id,
        anonymousUser,
        isDeleted: false,
      }),
    );

    const broadcast = jest.spyOn(
      app.get(ReactionsGateway),
      'broadcastReactionAdded',
    );
    const requests = Array.from({ length: 24 }, () =>
      reactionService.createReaction({
        confessionId: confession.id,
        anonymousUserId: anonymousUser.id,
        emoji: '❤️',
      }),
    );

    const results = await Promise.all(requests);
    const persisted = await reactionRepository.find({
      where: {
        confession: { id: confession.id },
        anonymousUser: { id: anonymousUser.id },
      },
    });

    expect(new Set(results.map((reaction) => reaction.id)).size).toBe(1);
    expect(persisted).toHaveLength(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
  }, 30000);
});