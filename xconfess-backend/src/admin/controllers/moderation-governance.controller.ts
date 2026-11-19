import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { AdminService } from '../services/admin.service';
import { ModerationGovernanceService } from '../services/moderation-governance.service';
import {
  CreateModerationAccessGrantDto,
  PreviewPolicyDto,
  ShadowEvaluationDto,
} from '../dto/moderation-governance.dto';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { CapabilityGuard } from '../../auth/capabilities/capability.guard';
import { RequireCapability } from '../../auth/capabilities/require-capability.decorator';
import {
  CAPABILITY_ADMIN,
  CAPABILITY_MODERATE_CONTENT,
} from '../../auth/capabilities/capability.constants';
import { GetUser } from '../../auth/get-user.decorator';
import { RequestUser } from '../../auth/interfaces/jwt-payload.interface';
import { ModerationAccessGrantGuard } from '../../auth/guards/moderation-access-grant.guard';
import { RequireModerationAccessGrant } from '../../auth/guards/moderation-access-grant.decorator';
import { BulkResolveDto } from '../dto/bulk-resolve.dto';
import { ResolveReportDto } from '../dto/resolve-report.dto';
import { ReportStatus, ReportType } from '../entities/report.entity';

type AuthenticatedRequest = Request & { user?: RequestUser };

@ApiTags('Admin Moderation')
@ApiBearerAuth()
@Controller('admin/moderation')
@UseGuards(JwtAuthGuard, CapabilityGuard)
export class ModerationGovernanceController {
  constructor(
    private readonly governanceService: ModerationGovernanceService,
    private readonly adminService: AdminService,
  ) {}

  @Post('access-grants')
  @RequireCapability(CAPABILITY_ADMIN)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Grant time-bounded access to sensitive report queues',
  })
  createAccessGrant(
    @Body() dto: CreateModerationAccessGrantDto,
    @GetUser('id') actorId: number,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.governanceService.grantQueueAccess(actorId, dto, request);
  }

  @Get('access-grants')
  @RequireCapability(CAPABILITY_ADMIN)
  @ApiOperation({ summary: 'List sensitive report queue access grants' })
  listAccessGrants() {
    return this.governanceService.listQueueAccessGrants();
  }

  @Delete('access-grants/:id')
  @RequireCapability(CAPABILITY_ADMIN)
  @ApiOperation({ summary: 'Revoke a sensitive report queue access grant' })
  revokeAccessGrant(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @GetUser('id') actorId: number,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.governanceService.revokeQueueAccess(id, actorId, request);
  }

  @Get('report-queue')
  @RequireCapability(CAPABILITY_MODERATE_CONTENT)
  @UseGuards(ModerationAccessGrantGuard)
  @RequireModerationAccessGrant()
  @ApiOperation({ summary: 'List reports for an explicitly granted moderator' })
  getReportQueue(
    @Query('status') status?: ReportStatus,
    @Query('type') type?: ReportType,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('limit') limitValue?: string,
    @Query('offset') offsetValue?: string,
  ) {
    if (status && !Object.values(ReportStatus).includes(status)) {
      throw new UnprocessableEntityException('Report status is invalid');
    }
    if (type && !Object.values(ReportType).includes(type)) {
      throw new UnprocessableEntityException('Report type is invalid');
    }
    const limit = this.boundedInteger(limitValue, 50, 1, 100);
    const offset = this.boundedInteger(offsetValue, 0, 0, 10_000);
    const start = startDate ? new Date(startDate) : undefined;
    const end = endDate ? new Date(endDate) : undefined;
    if (
      (start && !Number.isFinite(start.getTime())) ||
      (end && !Number.isFinite(end.getTime())) ||
      (start && end && start > end)
    ) {
      throw new UnprocessableEntityException('Report dates must be valid');
    }
    return this.adminService.getReports(
      status,
      type,
      start,
      end,
      limit,
      offset,
    );
  }

  @Get('report-queue/stats')
  @RequireCapability(CAPABILITY_MODERATE_CONTENT)
  @UseGuards(ModerationAccessGrantGuard)
  @RequireModerationAccessGrant()
  @ApiOperation({ summary: 'Read sensitive report queue statistics' })
  getReportQueueStats() {
    return this.governanceService.getReportQueueStats();
  }

  @Get('report-queue/:id')
  @RequireCapability(CAPABILITY_MODERATE_CONTENT)
  @UseGuards(ModerationAccessGrantGuard)
  @RequireModerationAccessGrant()
  @ApiOperation({ summary: 'Read a report in a sensitive queue' })
  getReport(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.adminService.getReportById(id);
  }

  @Patch('report-queue/:id/resolve')
  @RequireCapability(CAPABILITY_MODERATE_CONTENT)
  @UseGuards(ModerationAccessGrantGuard)
  @RequireModerationAccessGrant()
  @ApiOperation({ summary: 'Resolve a report in a sensitive queue' })
  resolveReport(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ResolveReportDto,
    @GetUser('id') actorId: number,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.adminService.resolveReport(
      id,
      actorId,
      dto.resolutionNotes ?? null,
      dto.templateId,
      request,
    );
  }

  @Patch('report-queue/:id/dismiss')
  @RequireCapability(CAPABILITY_MODERATE_CONTENT)
  @UseGuards(ModerationAccessGrantGuard)
  @RequireModerationAccessGrant()
  @ApiOperation({ summary: 'Dismiss a report in a sensitive queue' })
  dismissReport(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ResolveReportDto,
    @GetUser('id') actorId: number,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.adminService.dismissReport(
      id,
      actorId,
      dto.resolutionNotes ?? null,
      request,
    );
  }

  @Patch('report-queue/bulk-resolve')
  @RequireCapability(CAPABILITY_MODERATE_CONTENT)
  @UseGuards(ModerationAccessGrantGuard)
  @RequireModerationAccessGrant()
  @ApiOperation({ summary: 'Bulk resolve reports in a sensitive queue' })
  bulkResolveReports(
    @Body() dto: BulkResolveDto,
    @GetUser('id') actorId: number,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.adminService.bulkResolveReports(
      dto.reportIds,
      actorId,
      dto.notes ?? null,
      request,
    );
  }

  @Get('report-clusters')
  @RequireCapability(CAPABILITY_MODERATE_CONTENT)
  @UseGuards(ModerationAccessGrantGuard)
  @RequireModerationAccessGrant()
  @ApiOperation({
    summary: 'Group likely duplicate reports without changing their status',
  })
  getReportClusters(@Query('limit') limit?: string) {
    return this.governanceService.findReportClusters(
      this.boundedInteger(limit, 250, 1, 500),
    );
  }

  @Post('policy-shadow-evaluations')
  @RequireCapability(CAPABILITY_MODERATE_CONTENT)
  @UseGuards(ModerationAccessGrantGuard)
  @RequireModerationAccessGrant()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Evaluate a policy against a bounded fixture set without applying it',
  })
  runShadowEvaluation(
    @Body() dto: ShadowEvaluationDto,
    @GetUser('id') actorId: number,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.governanceService.runShadowEvaluation(actorId, dto, request);
  }

  @Post('policy-previews')
  @RequireCapability(CAPABILITY_MODERATE_CONTENT)
  @UseGuards(ModerationAccessGrantGuard)
  @RequireModerationAccessGrant()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Preview proposed actions and explanations before applying a policy',
  })
  previewPolicy(
    @Body() dto: PreviewPolicyDto,
    @GetUser('id') actorId: number,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.governanceService.previewPolicy(actorId, dto, request);
  }

  @Get('policy-runs/:id')
  @RequireCapability(CAPABILITY_MODERATE_CONTENT)
  @UseGuards(ModerationAccessGrantGuard)
  @RequireModerationAccessGrant()
  @ApiOperation({ summary: 'Read a policy preview or evaluation result' })
  getPolicyRun(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @GetUser('id') actorId: number,
  ) {
    return this.governanceService.getPolicyRun(id, actorId);
  }

  @Post('policy-previews/:id/commit')
  @RequireCapability(CAPABILITY_MODERATE_CONTENT)
  @UseGuards(ModerationAccessGrantGuard)
  @RequireModerationAccessGrant()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Commit an unexpired policy preview' })
  commitPolicyPreview(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @GetUser('id') actorId: number,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.governanceService.commitPolicyPreview(id, actorId, request);
  }

  @Post('policy-previews/:id/rollback')
  @RequireCapability(CAPABILITY_MODERATE_CONTENT)
  @UseGuards(ModerationAccessGrantGuard)
  @RequireModerationAccessGrant()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Safely roll back an unchanged policy application' })
  rollbackPolicy(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @GetUser('id') actorId: number,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.governanceService.rollbackPolicy(id, actorId, request);
  }

  private boundedInteger(
    value: string | undefined,
    fallback: number,
    minimum: number,
    maximum: number,
  ): number {
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value)) {
      throw new UnprocessableEntityException(
        `Value must be an integer between ${minimum} and ${maximum}`,
      );
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < minimum) {
      throw new UnprocessableEntityException(
        `Value must be an integer between ${minimum} and ${maximum}`,
      );
    }
    return Math.min(parsed, maximum);
  }
}
