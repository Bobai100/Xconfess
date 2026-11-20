import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { SupportRedactionService } from './support-redaction.service';
import { RawSupportPayload } from './support-redaction.types';

describe('SupportRedactionService (#409)', () => {
  let service: SupportRedactionService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [SupportRedactionService],
    }).compile();

    service = module.get<SupportRedactionService>(SupportRedactionService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should generate a preview redacting emails, tokens, and IPs', async () => {
    const payload: RawSupportPayload = {
      category: 'BILLING_BUG',
      description:
        'I had an error when paying from user.help@domain.org while connected to 192.168.1.105 with token ak_test12345678901234567890.',
      inclusionControls: {
        includeDiagnosticsLogs: false,
        includeDeviceInfo: true,
        includeNetworkMetrics: false,
      },
      deviceInfo: {
        os: 'macOS',
        browser: 'Chrome 120',
        ipAddress: '203.0.113.42',
      },
      systemLogs: ['Log containing sensitive user data: secret-token-line'],
    };

    const preview = await service.generatePreview(payload);

    expect(preview).toBeDefined();
    expect(preview.previewId).toBeDefined();
    expect(preview.redactedDescription).not.toContain('user.help@domain.org');
    expect(preview.redactedDescription).not.toContain('ak_test12345678901234567890');
    expect(preview.redactedDescription).toContain('[EMAIL_REDACTED]');
    expect(preview.redactedDescription).toContain('[SECRET_REDACTED]');

    // Diagnostics logs should NOT be included because includeDiagnosticsLogs was false
    expect(preview.redactedLogs.length).toEqual(0);

    // IP address should be subnet-masked
    expect(preview.sanitizedDeviceInfo?.ipAddress).toEqual('203.0.113.xxx');
  });

  it('should include and redact diagnostics logs when user opts in', async () => {
    const payload: RawSupportPayload = {
      category: 'CRASH_REPORT',
      description: 'App crashed on startup',
      inclusionControls: {
        includeDiagnosticsLogs: true,
        includeDeviceInfo: false,
        includeNetworkMetrics: false,
      },
      systemLogs: [
        'Connecting to host 10.0.0.15',
        'Authentication failure for alice.secret@domain.com',
      ],
    };

    const preview = await service.generatePreview(payload);
    expect(preview.redactedLogs.length).toEqual(2);
    expect(preview.redactedLogs[1]).not.toContain('alice.secret@domain.com');
    expect(preview.redactedLogs[1]).toContain('[EMAIL_REDACTED]');
    expect(preview.sanitizedDeviceInfo).toBeUndefined();
  });

  it('should submit report using previewId successfully', async () => {
    const payload: RawSupportPayload = {
      category: 'GENERAL_INQUIRY',
      description: 'Simple inquiry with no secrets',
      inclusionControls: {
        includeDiagnosticsLogs: false,
        includeDeviceInfo: false,
        includeNetworkMetrics: false,
      },
    };

    const preview = await service.generatePreview(payload);
    const submitted = await service.submitReport(preview.previewId, 'usr-test-submit');

    expect(submitted.ticketId).toMatch(/^TICKET-/);
    expect(submitted.status).toEqual('RECEIVED');
    expect(submitted.userId).toEqual('usr-test-submit');
  });

  it('should reject submission with invalid previewId', async () => {
    await expect(service.submitReport('invalid-preview-id')).rejects.toThrow(BadRequestException);
  });
});
