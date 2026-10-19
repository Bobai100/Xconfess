import { registerAs } from '@nestjs/config';

export interface IntegrityConfig {
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  defaultLimit: number;
  maxLimit: number;
}

export default registerAs(
  'integrity',
  (): IntegrityConfig => ({
    defaultTimeoutMs: Number(process.env.INTEGRITY_CHECK_DEFAULT_TIMEOUT_MS ?? 5000),
    maxTimeoutMs: Number(process.env.INTEGRITY_CHECK_MAX_TIMEOUT_MS ?? 30000),
    defaultLimit: Number(process.env.INTEGRITY_CHECK_DEFAULT_LIMIT ?? 50),
    maxLimit: Number(process.env.INTEGRITY_CHECK_MAX_LIMIT ?? 200),
  }),
);
