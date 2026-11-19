import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, MoreThan, Repository } from 'typeorm';
import { ModerationAccessGrant } from '../../admin/entities/moderation-access-grant.entity';
import { User, UserRole } from '../../user/entities/user.entity';
import { AuthenticatedRequest } from '../interfaces/jwt-payload.interface';
import { MODERATION_ACCESS_SCOPE_METADATA } from './moderation-access-grant.decorator';

@Injectable()
export class ModerationAccessGrantGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @InjectRepository(ModerationAccessGrant)
    private readonly grantRepository: Repository<ModerationAccessGrant>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const scope = this.reflector.getAllAndOverride<string>(
      MODERATION_ACCESS_SCOPE_METADATA,
      [context.getHandler(), context.getClass()],
    );
    if (!scope) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const userId = request.user?.id;
    if (!userId) {
      throw new ForbiddenException('A moderation access grant is required');
    }

    const user = await this.userRepository.findOne({
      where: { id: userId },
      select: { id: true, role: true, is_active: true },
    });
    if (
      !user?.is_active ||
      ![UserRole.ADMIN, UserRole.MODERATOR].includes(user.role)
    ) {
      throw new ForbiddenException(
        'An active administrator or moderator account is required',
      );
    }

    const grant = await this.grantRepository.findOne({
      where: {
        userId,
        scope,
        revokedAt: IsNull(),
        expiresAt: MoreThan(new Date()),
      },
      order: { expiresAt: 'DESC' },
    });

    if (!grant) {
      throw new ForbiddenException(
        'An active, scoped moderation access grant is required',
      );
    }
    return true;
  }
}
