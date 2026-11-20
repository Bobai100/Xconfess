import { Injectable, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  RawSupportPayload,
  SupportReportPreview,
  SubmittedSupportReport,
  RedactionRecord,
} from './support-redaction.types';

const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const IP_REGEX = /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/g;
const TOKEN_REGEX = /\b(ey[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+|S[A-Z2-7]{55}|ak_[a-zA-Z0-9_-]{20,})\b/g;

@Injectable()
export class SupportRedactionService {
  private readonly previews = new Map<string, SupportReportPreview>();
  private readonly submittedTickets = new Map<string, SubmittedSupportReport>();

  /**
   * Generates a preview with all redactions applied and explicit inclusion toggles respected
   */
  async generatePreview(payload: RawSupportPayload): Promise<SupportReportPreview> {
    if (!payload.description || payload.description.trim() === '') {
      throw new BadRequestException('Report description is required');
    }

    const redactionsApplied: RedactionRecord[] = [];
    const previewId = randomUUID();

    // Redact description text
    const redactedDescription = this.scrubText(
      payload.description,
      'description',
      redactionsApplied,
    );

    // Diagnostics logs: only included if user opted in
    let redactedLogs: string[] = [];
    if (payload.inclusionControls?.includeDiagnosticsLogs && payload.systemLogs) {
      redactedLogs = payload.systemLogs.map((log, index) =>
        this.scrubText(log, `systemLogs[${index}]`, redactionsApplied),
      );
    }

    // Device info: only included if user opted in, and IP is masked
    let sanitizedDeviceInfo:
      | { os?: string; browser?: string; ipAddress?: string }
      | undefined;

    if (payload.inclusionControls?.includeDeviceInfo && payload.deviceInfo) {
      sanitizedDeviceInfo = {
        os: payload.deviceInfo.os,
        browser: payload.deviceInfo.browser,
        ipAddress: payload.deviceInfo.ipAddress
          ? payload.deviceInfo.ipAddress.replace(/\.\d+$/, '.xxx')
          : undefined,
      };
    }

    const preview: SupportReportPreview = {
      previewId,
      category: payload.category || 'GENERAL_INQUIRY',
      redactedDescription,
      redactedLogs,
      sanitizedDeviceInfo,
      redactionsApplied,
      generatedAt: new Date().toISOString(),
    };

    this.previews.set(previewId, preview);
    return preview;
  }

  /**
   * Finalizes submission of the previewed support report
   */
  async submitReport(
    previewId: string,
    userId?: string,
  ): Promise<SubmittedSupportReport> {
    const preview = this.previews.get(previewId);
    if (!preview) {
      throw new BadRequestException(
        'Invalid or expired previewId. Please generate a preview before submitting.',
      );
    }

    const ticketId = `TICKET-${randomUUID().slice(0, 8).toUpperCase()}`;
    const report: SubmittedSupportReport = {
      ticketId,
      userId,
      status: 'RECEIVED',
      submittedAt: new Date().toISOString(),
      report: preview,
    };

    this.submittedTickets.set(ticketId, report);
    return report;
  }

  private scrubText(
    text: string,
    fieldName: string,
    records: RedactionRecord[],
  ): string {
    let result = text;

    if (EMAIL_REGEX.test(result)) {
      result = result.replace(EMAIL_REGEX, '[EMAIL_REDACTED]');
      records.push({
        field: fieldName,
        patternDetected: 'EMAIL_ADDRESS',
        replacement: '[EMAIL_REDACTED]',
      });
    }

    if (IP_REGEX.test(result)) {
      result = result.replace(IP_REGEX, '[IP_REDACTED]');
      records.push({
        field: fieldName,
        patternDetected: 'IP_ADDRESS',
        replacement: '[IP_REDACTED]',
      });
    }

    if (TOKEN_REGEX.test(result)) {
      result = result.replace(TOKEN_REGEX, '[SECRET_REDACTED]');
      records.push({
        field: fieldName,
        patternDetected: 'SECRET_TOKEN',
        replacement: '[SECRET_REDACTED]',
      });
    }

    return result;
  }
}
