import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Query,
  UseGuards,
  Req,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { RetentionService } from './retention.service';
import { RetentionDomain } from './retention-policy.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';

@ApiTags('Admin Retention')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('admin/retention')
export class RetentionController {
  constructor(private readonly retentionService: RetentionService) {}

  @Get('policies')
  @ApiOperation({ summary: 'View active data retention policies across domains' })
  getPolicies() {
    return this.retentionService.getPolicies();
  }

  @Post('purge')
  @ApiOperation({ summary: 'Trigger a retention purge or dry-run report for a domain' })
  executePurge(
    @Req() req: any,
    @Body('domain') domain: RetentionDomain,
    @Body('dryRun') dryRun = true,
  ) {
    return this.retentionService.executeDomainPurge(
      domain,
      dryRun,
      `admin:${req.user?.id || 'unknown'}`,
    );
  }

  @Post('simulate')
  @ApiOperation({
    summary: 'Preview a proposed retention policy using bounded read-only queries',
  })
  simulate(
    @Req() req: any,
    @Body('domain') domain: RetentionDomain,
    @Body('ttlDays') ttlDays: number,
    @Body('action') action: 'delete' | 'anonymize',
    @Body('limit') limit = 100,
  ) {
    return this.retentionService.simulateRetentionPolicy(
      domain,
      { ttlDays: Number(ttlDays), action },
      Number(limit) || 100,
      `admin:${req.user?.id || 'unknown'}`,
    );
  }

  @Post('holds')
  @ApiOperation({ summary: 'Place a legal hold preserving entity data past retention window' })
  placeHold(
    @Req() req: any,
    @Body('domain') domain: RetentionDomain,
    @Body('entityId') entityId: string,
    @Body('reason') reason: string,
  ) {
    return this.retentionService.placeLegalHold(
      domain,
      entityId,
      `admin:${req.user?.id || 'unknown'}`,
      reason,
    );
  }

  @Delete('holds')
  @ApiOperation({ summary: 'Release a legal hold on an entity' })
  releaseHold(
    @Req() req: any,
    @Body('domain') domain: RetentionDomain,
    @Body('entityId') entityId: string,
  ) {
    return this.retentionService.releaseLegalHold(
      domain,
      entityId,
      `admin:${req.user?.id || 'unknown'}`,
    );
  }

  @Get('audit-logs')
  @ApiOperation({ summary: 'Retrieve retention and deletion audit logs' })
  getAuditLogs(
    @Query('domain') domain?: RetentionDomain,
    @Query('limit') limit = 50,
  ) {
    return this.retentionService.getAuditLogs(domain, Number(limit) || 50);
  }
}
