import { SetMetadata } from '@nestjs/common';
import { SENSITIVE_REPORT_QUEUE_SCOPE } from '../../admin/entities/moderation-access-grant.entity';

export const MODERATION_ACCESS_SCOPE_METADATA = 'moderationAccessScope';

export const RequireModerationAccessGrant = () =>
  SetMetadata(MODERATION_ACCESS_SCOPE_METADATA, SENSITIVE_REPORT_QUEUE_SCOPE);
