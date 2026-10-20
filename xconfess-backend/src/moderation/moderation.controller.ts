// src/moderation/moderation.controller.ts
import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
  BadRequestException,
  Req,
  Patch,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { AiModerationService, ModerationStatus } from './ai-moderation.service';
import { ModerationRepositoryService } from './moderation-repository.service';
import { InvalidModerationTransitionError } from './moderation-state-machine';
import { TransitionModerationDto } from './dtos/transition-moderation.dto';
import { RunEvaluationDto } from './dtos/run-evaluation.dto';
import {
  ApprovePolicyImpactDto,
  PolicyImpactThresholdsDto,
} from './dtos/policy-impact.dto';
import { LanguageEvaluationService } from './language-evaluation.service';

class TestModerationDto {
  content!: string;
}

class ReviewModerationDto {
  status!: ModerationStatus;
  notes?: string;
}

@ApiTags('Admin - Moderation')
@ApiBearerAuth()
@Controller('admin/moderation')
@UseGuards(JwtAuthGuard, AdminGuard)
export class ModerationController {
  constructor(
    private readonly aiModerationService: AiModerationService,
    private readonly moderationRepoService: ModerationRepositoryService,
    private readonly languageEvaluationService: LanguageEvaluationService,
  ) {}

  @Post('language-evaluation')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Run privacy-safe multilingual moderation evaluation (Admin only)',
  })
  @ApiResponse({
    status: 200,
    description: 'Aggregate false-positive and false-negative metrics.',
  })
  @ApiResponse({ status: 400, description: 'Invalid evaluation filters.' })
  async runLanguageEvaluation(@Body() dto: RunEvaluationDto) {
    return this.languageEvaluationService.runEvaluation(dto);
  }

  @Post('policy-impact-preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Preview moderation threshold impact using local synthetic fixtures',
  })
  @ApiResponse({
    status: 200,
    description: 'Aggregate-only impact preview and one-time approval ID.',
  })
  @ApiResponse({ status: 400, description: 'Invalid proposed thresholds.' })
  previewPolicyImpact(@Body() dto: PolicyImpactThresholdsDto) {
    return this.languageEvaluationService.previewPolicyImpact(dto);
  }

  @Get('pending')
  @ApiOperation({ summary: 'Get pending moderation reviews (Admin only)' })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  @ApiResponse({ status: 200, description: 'Pending moderation reviews.' })
  async getPendingReviews(
    @Query('limit') limit = 50,
    @Query('offset') offset = 0,
  ) {
    return await this.moderationRepoService.getPendingReviews(
      Number(limit),
      Number(offset),
    );
  }

  @Post('review/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Review a moderation item (Admin only)' })
  @ApiParam({ name: 'id', description: 'Moderation item ID' })
  @ApiResponse({ status: 200, description: 'Moderation reviewed.' })
  async reviewModeration(
    @Param('id') id: string,
    @Body() dto: ReviewModerationDto,
  ) {
    return await this.moderationRepoService.updateReview(
      id,
      dto.status,
      'system',
      dto.notes,
    );
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get moderation statistics (Admin only)' })
  @ApiQuery({ name: 'startDate', required: false, example: '2026-04-01' })
  @ApiQuery({ name: 'endDate', required: false, example: '2026-04-30' })
  @ApiResponse({ status: 200, description: 'Moderation statistics.' })
  async getStats(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const start = startDate ? new Date(startDate) : undefined;
    const end = endDate ? new Date(endDate) : undefined;
    return await this.moderationRepoService.getModerationStats(start, end);
  }

  @Get('accuracy')
  @ApiOperation({ summary: 'Get accuracy metrics (Admin only)' })
  @ApiResponse({ status: 200, description: 'Accuracy metrics.' })
  async getAccuracyMetrics() {
    return await this.moderationRepoService.getAccuracyMetrics();
  }

  @Get('config')
  @ApiOperation({ summary: 'Get moderation configuration (Admin only)' })
  @ApiResponse({ status: 200, description: 'Current moderation config.' })
  getConfiguration() {
    return this.aiModerationService.getConfiguration();
  }

  @Post('config/thresholds')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Apply a previewed moderation threshold change after explicit approval',
  })
  @ApiResponse({ status: 200, description: 'Approved thresholds applied.' })
  @ApiResponse({
    status: 403,
    description: 'Explicit approval is required.',
  })
  @ApiResponse({
    status: 409,
    description: 'The preview is missing, expired, stale, or mismatched.',
  })
  updateThresholds(@Body() dto: ApprovePolicyImpactDto) {
    const thresholds = this.languageEvaluationService.approvePolicyImpact({
      previewId: dto.previewId,
      approved: dto.approved,
      proposedThresholds: {
        highThreshold: dto.highThreshold,
        mediumThreshold: dto.mediumThreshold,
      },
    });
    return { message: 'Approved thresholds applied successfully', thresholds };
  }

  @Post('test')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Test moderation content (Admin only)' })
  @ApiResponse({ status: 200, description: 'Moderation test completed.' })
  async testModeration(@Body() dto: TestModerationDto) {
    const result = await this.aiModerationService.moderateContent(dto.content);
    return {
      message: 'Moderation test completed',
      result,
    };
  }

  @Get('confession/:confessionId')
  @ApiOperation({ summary: 'Get moderation logs for a confession (Admin only)' })
  @ApiParam({ name: 'confessionId', description: 'Confession UUID' })
  @ApiResponse({ status: 200, description: 'Moderation logs.' })
  async getConfessionLogs(@Param('confessionId') confessionId: string) {
    return await this.moderationRepoService.getLogsByConfession(confessionId);
  }

  @Get('user/:userId')
  @ApiOperation({ summary: 'Get moderation logs for a user (Admin only)' })
  @ApiParam({ name: 'userId', description: 'User UUID' })
  @ApiQuery({ name: 'limit', required: false, example: 100 })
  @ApiResponse({ status: 200, description: 'User moderation logs.' })
  async getUserLogs(
    @Param('userId') userId: string,
    @Query('limit') limit = 100,
  ) {
    return await this.moderationRepoService.getLogsByUser(
      userId,
      Number(limit),
    );
  }

  @Patch(':id/transition')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Transition a moderation item to a new state (Admin only)' })
  @ApiParam({ name: 'id', description: 'Moderation log ID' })
  @ApiResponse({ status: 200, description: 'State transitioned.' })
  @ApiResponse({ status: 400, description: 'Invalid transition for the item\'s current state.' })
  async transitionModeration(
    @Param('id') id: string,
    @Body() dto: TransitionModerationDto,
    @Req() req: any, // adjust to your actual JwtAuthGuard's request.user shape
  ) {
    const actor = { id: req.user?.id ?? req.user?.sub, email: req.user?.email };
    if (!actor.id) {
      throw new BadRequestException('Unable to resolve acting admin from request');
    }

    try {
      return await this.moderationRepoService.transitionState(
        id,
        dto.nextState,
        actor,
        dto.reason,
        dto.notes,
      );
    } catch (err) {
      if (err instanceof InvalidModerationTransitionError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }
}
