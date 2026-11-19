import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminController } from './admin.controller';
import { AdminService } from './services/admin.service';
import { ModerationService } from './services/moderation.service';
import { StellarDiagnosticsService } from './services/stellar-diagnostics.service';
import { Report } from './entities/report.entity';
import { AuditLog } from '../audit-log/audit-log.entity';
import { ModerationNoteTemplate } from '../comment/entities/moderation-note-template.entity';
import { ModerationTemplateService } from '../comment/moderation-template.service';
import { AnonymousConfession } from '../confession/entities/confession.entity';
import { User } from '../user/entities/user.entity';
import { AuthModule } from '../auth/auth.module';
import { AdminGateway } from './realtime/admin.gateway';
import { ReportsEventsListener } from './realtime/reports.events.listener';
import { UserModule } from '../user/user.module';
import { UserAnonymousUser } from '../user/entities/user-anonymous-link.entity';
import { WebSocketLogger } from '../websocket/websocket.logger';
import { WsRolesGuard } from '../auth/guards/ws-roles.guard';
import { Reflector } from '@nestjs/core';
import { CapabilityPolicyService } from '../auth/capabilities/capability-policy.service';
import { CapabilityGuard } from '../auth/capabilities/capability.guard';
import { Tip } from '../tipping/entities/tip.entity';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { StellarModule } from '../stellar/stellar.module';

// New imports
import { NotificationTemplate } from '../database/entities/notification-template.entity';
import { TemplateVersion } from '../database/entities/template-version.entity';
import { NotificationTemplatesController } from './controllers/notification-templates.controller';
import { TemplatesService } from './services/templates.service';

import { StellarAnchor } from '../stellar/entities/stellar-anchor.entity';
import { SorobanEventCheckpoint } from '../stellar/entities/soroban-event-checkpoint.entity';
import { DiagnosticsBundleService } from './services/diagnostics-bundle.service';
import { CrossDomainIntegrityService } from './services/cross-domain-integrity.service';
import { AdminActionApproval } from './entities/admin-action-approval.entity';
import { ModerationAccessGrant } from './entities/moderation-access-grant.entity';
import { ModerationPolicyRun } from './entities/moderation-policy-run.entity';
import { ModerationGovernanceService } from './services/moderation-governance.service';
import { ModerationGovernanceController } from './controllers/moderation-governance.controller';
import { ModerationAccessGrantGuard } from '../auth/guards/moderation-access-grant.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Report,
      AuditLog,
      ModerationNoteTemplate,
      AnonymousConfession,
      User,
      UserAnonymousUser,
      Tip,
      NotificationTemplate, // Added
      TemplateVersion,      // Added
      StellarAnchor,
      SorobanEventCheckpoint,
      AdminActionApproval,
      ModerationAccessGrant,
      ModerationPolicyRun,
    ]),
    AuthModule,
    UserModule,
    AuditLogModule,
    NotificationsModule,
    StellarModule,
  ],
  controllers: [
    AdminController,
    NotificationTemplatesController, // Added
    ModerationGovernanceController, // Added
  ],
  providers: [
    AdminService,
    ModerationService,
    ModerationTemplateService,
    StellarDiagnosticsService,
    AdminGateway,
    ReportsEventsListener,
    WebSocketLogger,
    WsRolesGuard,
    Reflector,
    CapabilityPolicyService,
    CapabilityGuard,
    TemplatesService, // Added
    DiagnosticsBundleService,
    CrossDomainIntegrityService,
    ModerationGovernanceService,
    ModerationAccessGrantGuard,
  ],
  exports: [
    AdminService, 
    ModerationService, 
    ModerationTemplateService, 
    TemplatesService, // Added
    DiagnosticsBundleService,
    CrossDomainIntegrityService,
    CapabilityPolicyService,
    CapabilityGuard,
  ],
})
export class AdminModule {}
