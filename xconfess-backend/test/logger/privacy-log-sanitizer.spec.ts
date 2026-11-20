import { PrivacyLogSanitizer } from '../../src/logger/privacy-log-sanitizer';

describe('PrivacyLogSanitizer & Field-Level Log Diagnostics (#406)', () => {
  const privateValues = {
    secretSeed: 'SBGFV2DTRM2N4TUXJ4H46J4YMYA7Y3Y3V7H2P3R4S5T6U7V8W9XYZ123',
    rawPassword: 'SuperSecretMasterPassword123!',
    confessionContent: 'I secretly took my roommate’s vintage vinyl collection and never confessed.',
    directMessage: 'Meet me at midnight behind the old warehouse; do not tell anyone.',
    userEmail: 'sensitive.whistleblower@protonmail.com',
    bearerToken: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-o-k-e-n-s-i-g-n-a-t-u-r-e',
    apiKey: 'ak_live_abcdef1234567890abcdef1234567890abcdef12',
  };

  const representativePayload = {
    requestId: 'req-abc-987',
    timestamp: '2026-11-20T10:00:00.000Z',
    status: 'failed',
    metadata: {
      account: {
        userId: 'usr-901',
        email: privateValues.userEmail,
        password: privateValues.rawPassword,
      },
      headers: {
        authorization: privateValues.bearerToken,
        apiKey: privateValues.apiKey,
      },
      activity: {
        lastConfession: {
          confessionId: 'conf-123',
          confessionText: privateValues.confessionContent,
        },
        chatMessage: {
          recipientId: 'usr-456',
          message: privateValues.directMessage,
        },
      },
      diagnostics: {
        stellarSecretSeed: privateValues.secretSeed,
        nestedTrace: `Error processing request for user ${privateValues.userEmail} with token ${privateValues.bearerToken}`,
      },
    },
  };

  it('should completely redact secrets, confessions, messages, emails, and tokens from serialized diagnostics', () => {
    const serializedDiagnostics = PrivacyLogSanitizer.serializeDiagnostics(representativePayload);

    // Assert that NONE of the raw sensitive values appear in the serialized output
    expect(serializedDiagnostics).not.toContain(privateValues.secretSeed);
    expect(serializedDiagnostics).not.toContain(privateValues.rawPassword);
    expect(serializedDiagnostics).not.toContain(privateValues.confessionContent);
    expect(serializedDiagnostics).not.toContain(privateValues.directMessage);
    expect(serializedDiagnostics).not.toContain(privateValues.userEmail);
    expect(serializedDiagnostics).not.toContain(privateValues.bearerToken);
    expect(serializedDiagnostics).not.toContain(privateValues.apiKey);

    // Assert non-sensitive metadata is preserved for observability
    expect(serializedDiagnostics).toContain('req-abc-987');
    expect(serializedDiagnostics).toContain('usr-901');
    expect(serializedDiagnostics).toContain('conf-123');
    expect(serializedDiagnostics).toContain('usr-456');
  });

  it('should redact sensitive values embedded in raw string logs and stack traces', () => {
    const errorLogString = `Fatal exception while authenticating ${privateValues.userEmail}: provided invalid seed ${privateValues.secretSeed}`;
    const sanitized = PrivacyLogSanitizer.sanitizeString(errorLogString);

    expect(sanitized).not.toContain(privateValues.userEmail);
    expect(sanitized).not.toContain(privateValues.secretSeed);
    expect(sanitized).toContain('Fatal exception while authenticating');
    expect(sanitized).toContain('[REDACTED]');
  });

  it('should handle circular references gracefully without crashing', () => {
    const circularObj: any = { id: 'obj-1', email: 'test@example.com' };
    circularObj.self = circularObj;

    const result: any = PrivacyLogSanitizer.sanitize(circularObj);
    expect(result.id).toBe('obj-1');
    expect(result.email).toBe('[REDACTED]');
    expect(result.self).toBe('[Circular]');
  });
});
