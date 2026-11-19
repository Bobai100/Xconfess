import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Repository } from 'typeorm';
import { ModerationAccessGrant } from '../../admin/entities/moderation-access-grant.entity';
import { User, UserRole } from '../../user/entities/user.entity';
import { ModerationAccessGrantGuard } from './moderation-access-grant.guard';

describe('ModerationAccessGrantGuard', () => {
  const scope = 'sensitive-report-queue';
  const handler = () => undefined;
  const context = {
    getHandler: () => handler,
    getClass: () => class TestController {},
    switchToHttp: () => ({
      getRequest: () => ({ user: { id: 42 } }),
    }),
  };

  function createGuard(
    grant: ModerationAccessGrant | null,
    user: Pick<User, 'id' | 'role' | 'is_active'> | null = {
      id: 42,
      role: UserRole.MODERATOR,
      is_active: true,
    },
  ) {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(scope),
    };
    const repository = { findOne: jest.fn().mockResolvedValue(grant) };
    const userRepository = { findOne: jest.fn().mockResolvedValue(user) };
    return {
      guard: new ModerationAccessGrantGuard(
        reflector as unknown as Reflector,
        repository as unknown as Repository<ModerationAccessGrant>,
        userRepository as unknown as Repository<User>,
      ),
      repository,
      userRepository,
    };
  }

  it('denies access when no active scoped grant exists', async () => {
    const { guard, repository } = createGuard(null);

    await expect(guard.canActivate(context as never)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(repository.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 42,
          scope,
        }),
      }),
    );
  });

  it('allows access only when a matching active grant is found', async () => {
    const { guard } = createGuard({
      id: 'grant-1',
      userId: 42,
      scope,
      expiresAt: new Date(Date.now() + 60_000),
    } as ModerationAccessGrant);

    await expect(guard.canActivate(context as never)).resolves.toBe(true);
  });

  it('denies access after the recipient account is deactivated', async () => {
    const { guard, repository } = createGuard(null, {
      id: 42,
      role: UserRole.MODERATOR,
      is_active: false,
    });

    await expect(guard.canActivate(context as never)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(repository.findOne).not.toHaveBeenCalled();
  });
});
