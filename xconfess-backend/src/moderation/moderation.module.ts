// src/moderation/moderation.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { AiModerationService } from './ai-moderation.service';
import { ModerationRepositoryService } from './moderation-repository.service';
import { ModerationController } from './moderation.controller';
import { ModerationWebhookController } from './moderation-webhook.controller';
import { ModerationEventsListener } from './moderation-events.listener';
import { User } from '../user/entities/user.entity';
import { ModerationLog } from './entities/moderation-log.entity';
import { ModerationEvidence } from './entities/moderation-evidence.entity';
import { ModerationEvidenceService } from './moderation-evidence.service';
import { AnonymousConfession } from '../confession/entities/confession.entity';
import { NotificationsModule as InAppNotificationModule } from '../notifications/notifications.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { LanguageEvaluationService } from './language-evaluation.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([ModerationLog, ModerationEvidence, AnonymousConfession, User]),
    ConfigModule,
    InAppNotificationModule,
    AuditLogModule,
  ],
  controllers: [ModerationController, ModerationWebhookController],
  providers: [
    AiModerationService,
    ModerationRepositoryService,
    ModerationEventsListener,
    ModerationEvidenceService,
    LanguageEvaluationService,
  ],
  exports: [AiModerationService, ModerationRepositoryService, ModerationEvidenceService],
})
export class ModerationModule {}
