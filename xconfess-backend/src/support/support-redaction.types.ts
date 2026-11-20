export interface SupportReportInclusionControls {
  includeDiagnosticsLogs: boolean;
  includeDeviceInfo: boolean;
  includeNetworkMetrics: boolean;
}

export interface RawSupportPayload {
  category: string;
  description: string;
  userEmail?: string;
  systemLogs?: string[];
  deviceInfo?: {
    os?: string;
    browser?: string;
    ipAddress?: string;
    deviceId?: string;
  };
  inclusionControls: SupportReportInclusionControls;
}

export interface RedactionRecord {
  field: string;
  patternDetected: string;
  replacement: string;
}

export interface SupportReportPreview {
  previewId: string;
  category: string;
  redactedDescription: string;
  redactedLogs: string[];
  sanitizedDeviceInfo?: {
    os?: string;
    browser?: string;
    ipAddress?: string;
  };
  redactionsApplied: RedactionRecord[];
  generatedAt: string;
}

export interface SubmittedSupportReport {
  ticketId: string;
  userId?: string;
  status: 'RECEIVED' | 'TRIAGED';
  submittedAt: string;
  report: SupportReportPreview;
}
