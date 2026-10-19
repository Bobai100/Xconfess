import {
  Controller,
  Get,
  Patch,
  Delete,
  Param,
  Body,
  Req,
  UseGuards,
  Query,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OwnershipGuard } from '../common/guards/ownership.guard';
import { Ownership } from '../common/decorators/ownership.decorator';
import { UserService } from './user.service';
import { UpdatePersonalizationDto } from './dto/update-personalization.dto';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UserController {
  constructor(private readonly userService: UserService) {}

  /** Public profile — no ownership required */
  @Get([':userId/profile', ':userId/public-profile'])
  async getPublicProfile(@Param('userId') userId: string) {
    return this.userService.getPublicProfile(userId);
  }

  /** Get authenticated user's own profile summary */
  @Get('profile/summary')
  async getMyProfileSummary(@Req() req: any) {
    const userId = req.user.id ?? req.user.sub;
    return this.userService.getProfileSummary(userId);
  }

  /** Get authenticated user's dashboard stats */
  @Get('stats')
  async getMyStats(@Req() req: any) {
    const userId = req.user.id ?? req.user.sub;
    return this.userService.getDashboardStats(Number(userId));
  }

  /** Get specific user's profile summary (with ownership check) */
  @Get(':userId/profile/summary')
  @UseGuards(OwnershipGuard)
  @Ownership({ paramKey: 'userId' })
  async getProfileSummary(
    @Param('userId') userId: string,
  ) {
    return this.userService.getProfileSummary(parseInt(userId, 10));
  }

  /** Get user's activities list (with ownership check) */
  @Get(':userId/activities')
  @UseGuards(OwnershipGuard)
  @Ownership({ paramKey: 'userId' })
  async getUserActivities(
    @Param('userId') userId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const p = page ? parseInt(page, 10) : 1;
    const l = limit ? parseInt(limit, 10) : 10;
    return this.userService.getUserActivitiesList(parseInt(userId, 10), p, l);
  }

  /** Get user's confessions list (with ownership check) */
  @Get(':userId/confessions')
  @UseGuards(OwnershipGuard)
  @Ownership({ paramKey: 'userId' })
  async getUserConfessions(
    @Param('userId') userId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const p = page ? parseInt(page, 10) : 1;
    const l = limit ? parseInt(limit, 10) : 10;
    return this.userService.getUserConfessionsList(parseInt(userId, 10), p, l);
  }

  /**
   * PATCH /users/me/personalization
   * Explicitly toggles the non-personalized discovery mode for the
   * authenticated user. Persists the preference and invalidates any cached
   * personalized results so hidden signals stop affecting discovery.
   *
   * Failure semantics:
   *  - 401 when the request is unauthenticated (JwtAuthGuard).
   *  - 403 when the caller is not the account owner.
   */
  @Patch('me/personalization')
  @UseGuards(JwtAuthGuard)
  async updatePersonalization(
    @Body() dto: UpdatePersonalizationDto,
    @Req() req: any,
  ) {
    const authedUserId = req.user?.id ?? req.user?.sub;
    if (authedUserId === undefined || authedUserId === null) {
      throw new UnauthorizedException('Authentication required');
    }

    if (dto.userId !== undefined && String(dto.userId) !== String(authedUserId)) {
      throw new ForbiddenException(
        'You may only change your own personalization preference',
      );
    }

    return this.userService.updatePersonalizationPreference(
      Number(authedUserId),
      dto.nonPersonalized,
    );
  }

  /**
   * PATCH /users/:userId/settings
   * Ownership enforced independently at backend.
   */
  @Patch(':userId/settings')
  @UseGuards(OwnershipGuard)
  @Ownership({ paramKey: 'userId' })
  async updateSettings(
    @Param('userId') userId: string,
    @Body() dto: Record<string, unknown>,
    @Req() req: any,
  ) {
    const authedUserId = req.user.id ?? req.user.sub;
    return this.userService.updateSettings(authedUserId, dto);
  }

  /**
   * DELETE /users/:userId
   * Only the account owner can delete it (admin handled separately).
   */
  @Delete(':userId')
  @UseGuards(OwnershipGuard)
  @Ownership({ paramKey: 'userId', adminBypass: true })
  async deleteAccount(@Param('userId') userId: string, @Req() req: any) {
    const authedUserId = req.user.id ?? req.user.sub;
    return this.userService.deleteAccount(authedUserId);
  }
}
