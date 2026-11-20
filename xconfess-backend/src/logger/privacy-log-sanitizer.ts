/**
 * Privacy Log Sanitizer & Diagnostics Serializer
 *
 * Implements strict field-level redaction for structured logs, diagnostics payloads,
 * and error telemetry. Guarantees that secrets, confession contents, direct messages,
 * email addresses, and auth tokens are sanitized before emission.
 */

const REDACTED_VALUE = '[REDACTED]';

// Regex patterns for sensitive values
const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gi;
const BEARER_TOKEN_REGEX = /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const JWT_REGEX = /\beyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\b/g;
const STELLAR_SECRET_REGEX = /\bS[A-Z2-7]{55}\b/g;
const GENERIC_SECRET_HEX = /\b[0-9a-fA-F]{40,64}\b/g;

// Sensitive keys requiring complete redaction
const SENSITIVE_KEY_PATTERNS = [
  /password/i,
  /secret/i,
  /private_?key/i,
  /api_?key/i,
  /token/i,
  /authorization/i,
  /auth_?header/i,
  /confession(_?text|_?body|_?content)?/i,
  /message(_?text|_?body|_?content)?/i,
  /email/i,
  /phone(_?number)?/i,
  /seed/i,
];

export class PrivacyLogSanitizer {
  /**
   * Sanitizes string values by masking regex matches
   */
  static sanitizeString(input: string): string {
    if (!input) return input;
    return input
      .replace(BEARER_TOKEN_REGEX, `Bearer ${REDACTED_VALUE}`)
      .replace(JWT_REGEX, REDACTED_VALUE)
      .replace(STELLAR_SECRET_REGEX, REDACTED_VALUE)
      .replace(EMAIL_REGEX, REDACTED_VALUE)
      .replace(GENERIC_SECRET_HEX, REDACTED_VALUE);
  }

  /**
   * Recursively sanitizes any structured log or diagnostics payload
   */
  static sanitize(value: unknown, seen = new WeakSet<object>()): unknown {
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value === 'string') {
      return this.sanitizeString(value);
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'bigint') {
      return value.toString();
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.sanitize(item, seen));
    }

    if (typeof value === 'object') {
      if (seen.has(value)) {
        return '[Circular]';
      }
      seen.add(value);

      const sanitizedObj: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        if (this.isSensitiveKey(key)) {
          sanitizedObj[key] = REDACTED_VALUE;
        } else {
          sanitizedObj[key] = this.sanitize(val, seen);
        }
      }
      return sanitizedObj;
    }

    return REDACTED_VALUE;
  }

  /**
   * Serializes a diagnostics or log object into a sanitized JSON string
   */
  static serializeDiagnostics(payload: Record<string, unknown>, space?: number): string {
    const sanitized = this.sanitize(payload);
    return JSON.stringify(sanitized, null, space);
  }

  /**
   * Checks whether a field key is in the sensitivity blacklist
   */
  private static isSensitiveKey(key: string): boolean {
    return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
  }
}
