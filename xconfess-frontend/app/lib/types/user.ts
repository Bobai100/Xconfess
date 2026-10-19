/**
 * Shared user types for auth store and API contracts.
 * Re-exports from auth for single source of truth.
 */
export type { User } from "./auth";

/**
 * Non-personalized discovery mode preference.
 *
 * When `personalizationEnabled` is `false`, the backend bypasses all
 * personal ranking features (hidden user signals) for discovery results.
 * The preference is persisted server-side and survives cache invalidation.
 */
export interface PersonalizationPreference {
  /** Whether personalized ranking features may influence discovery results. */
  personalizationEnabled: boolean;
}

/**
 * Response payload returned when reading or updating the
 * personalization preference.
 */
export interface PersonalizationPreferenceResponse
  extends PersonalizationPreference {
  /** Server-side timestamp of the last persisted update (ISO 8601). */
  updatedAt?: string;
}