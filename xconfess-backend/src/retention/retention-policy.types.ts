export type RetentionDomain =
  | 'messages'
  | 'logs'
  | 'exports'
  | 'analytics'
  | 'moderation_evidence';

export interface RetentionPolicy {
  domain: RetentionDomain;
  ttlDays: number;
  action: 'delete' | 'anonymize';
  description: string;
  allowLegalHold: boolean;
}

export interface PurgeExecutionReport {
  domain: RetentionDomain;
  dryRun: boolean;
  cutoffDate: Date;
  scannedCount: number;
  eligibleCount: number;
  heldCount: number;
  purgedCount: number;
  durationMs: number;
  executedBy: string;
  timestamp: string;
}

export interface RetentionPolicyPreview {
  domain: RetentionDomain;
  proposedTtlDays: number;
  proposedAction: 'delete' | 'anonymize';
  cutoffDate: string;
  dryRun: true;
  boundedLimit: number;
  truncated: boolean;
  recordClasses: Array<{
    table: string;
    affectedCount: number;
  }>;
  affectedRecordCount: number;
  heldCount: number;
  executedBy: string;
  timestamp: string;
}

export const DOMAIN_RETENTION_POLICIES: Record<RetentionDomain, RetentionPolicy> = {
  messages: {
    domain: 'messages',
    ttlDays: 365, // 1 year
    action: 'delete',
    description: 'Direct user messages retained for 1 year',
    allowLegalHold: true,
  },
  logs: {
    domain: 'logs',
    ttlDays: 90, // 90 days
    action: 'delete',
    description: 'System access & API request logs retained for 90 days',
    allowLegalHold: true,
  },
  exports: {
    domain: 'exports',
    ttlDays: 7, // 7 days
    action: 'delete',
    description: 'User data archive export files expired and removed after 7 days',
    allowLegalHold: false,
  },
  analytics: {
    domain: 'analytics',
    ttlDays: 180, // 180 days
    action: 'anonymize',
    description: 'User-associated telemetry anonymized after 180 days',
    allowLegalHold: false,
  },
  moderation_evidence: {
    domain: 'moderation_evidence',
    ttlDays: 730, // 2 years
    action: 'delete',
    description: 'Moderation logs and evidence retained for 2 years compliance audit',
    allowLegalHold: true,
  },
};
