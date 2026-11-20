import {
  Controller,
  Get,
  Put,
  Body,
  Req,
  UseGuards,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { PreferenceSyncService } from './preference-sync.service';
import { SyncPreferencesDto, PreferenceSyncResponse } from './preference-sync.types';

@Controller('users/preferences/sync')
export class PreferenceSyncController {
  constructor(private readonly syncService: PreferenceSyncService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  async getPreferences(@Req() req: any): Promise<PreferenceSyncResponse> {
    const userId = req.user?.id || req.user?.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }
    return this.syncService.getPreferences(userId);
  }

  @Put()
  @UseGuards(JwtAuthGuard)
  async syncPreferences(
    @Req() req: any,
    @Body() dto: SyncPreferencesDto,
  ): Promise<PreferenceSyncResponse> {
    const userId = req.user?.id || req.user?.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }
    return this.syncService.syncPreferences(userId, dto);
  }
}
