import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  Req,
  Query,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';

import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { SearchDiscoveryService } from './search-discovery.service';
import { CreateSavedSearchDto } from './dto/create-saved-search.dto';
import { SearchConfessionDto } from '../confession/dto/search-confession.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequestCost, COST } from '../common/guards/cost-throttler.guard';

@ApiTags('Search Discovery')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('confessions/search/discovery')
export class SearchDiscoveryController {
  constructor(private readonly service: SearchDiscoveryService) {}

  @Get()
  @RequestCost(COST.MEDIUM) // full-text search + filtering is more expensive than a simple read
  @ApiOperation({ summary: 'Execute full text search with filters and highlighting' })
  async executeSearch(
    @Req() req: any,
    @Query() query: SearchConfessionDto,
    @Query('personalized') personalized?: string,
  ) {
    const userId = this.requireUserId(req);
    const mode = await this.resolvePersonalizedMode(userId, personalized);
    return this.service.executeFullTextSearch(userId, query, mode);
  }

  @Post('presets')
  @ApiOperation({ summary: 'Save a search preset' })
  savePreset(@Req() req: any, @Body() dto: CreateSavedSearchDto) {
    return this.service.savePreset(req.user.id, dto);
  }

  @Get('presets')
  @ApiOperation({ summary: 'List saved search presets' })
  listPresets(@Req() req: any) {
    return this.service.listPresets(req.user.id);
  }

  @Delete('presets/:id')
  @ApiOperation({ summary: 'Delete a search preset' })
  deletePreset(@Req() req: any, @Param('id') id: string) {
    return this.service.deletePreset(req.user.id, id);
  }

  @Get('history')
  @ApiOperation({ summary: 'Get recent search history' })
  getHistory(@Req() req: any) {
    return this.service.getRecentSearches(req.user.id);
  }

  @Get('recommendations')
  @ApiOperation({ summary: 'Get personalized recommendations with safeguards and explanations' })
  async getRecommendations(
    @Req() req: any,
    @Query('limit') limit?: number,
    @Query('personalized') personalized?: string,
  ) {
    const userId = this.requireUserId(req);
    const mode = await this.resolvePersonalizedMode(userId, personalized);
    return this.service.getPersonalizedRecommendations(userId, limit, mode);
  }

  @Get('preferences')
  @ApiOperation({ summary: 'Get user discovery personalization and diversity preferences' })
  getPreferences(@Req() req: any) {
    return this.service.getUserDiscoveryPreference(req.user.id);
  }

  @Put('preferences')
  @ApiOperation({ summary: 'Update personalization opt-out and diversity preferences' })
  updatePreferences(@Req() req: any, @Body() dto: any) {
    return this.service.updateUserDiscoveryPreference(req.user.id, dto);
  }

  /**
   * Resolves the effective personalization mode for a request.
   *
   * - When the caller does not supply `personalized`, the persisted user
   *   preference is authoritative (opt-out is always honored).
   * - When the caller explicitly requests a mode, it may only *disable*
   *   personalization. Forcing personalization on while the user has opted out
   *   is rejected so hidden signals can never be re-enabled implicitly.
   */
  private async resolvePersonalizedMode(
    userId: string,
    personalized?: string,
  ): Promise<boolean> {
    const preference = await this.service.getUserDiscoveryPreference(userId);
    const optedOut = preference?.personalizationEnabled === false;

    if (personalized === undefined || personalized === null || personalized === '') {
      return !optedOut;
    }

    const requested = this.parseBooleanFlag(personalized);
    if (requested === null) {
      throw new ForbiddenException(
        'Invalid "personalized" flag; expected "true" or "false".',
      );
    }

    if (requested && optedOut) {
      throw new ForbiddenException(
        'Personalization is disabled for this account; non-personalized mode is enforced.',
      );
    }

    return requested;
  }

  private parseBooleanFlag(value: string): boolean | null {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return null;
  }

  private requireUserId(req: any): string {
    const userId = req?.user?.id;
    if (!userId) {
      throw new UnauthorizedException(
        'Authentication is required to select a discovery mode.',
      );
    }
    return userId;
  }
}