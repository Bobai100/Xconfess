# Data Export Retention & Expiry

Reference for export job lifecycle, download token behaviour, and retention defaults.

## Defaults

| Parameter | Value | Source |
|---|---|---|
| Download TTL | 24 hours after `createdAt` | `app.exportDownloadTtlMs` (fallback: `24 * 60 * 60 * 1000`) |
| Rate limit | 1 per 7 days per user | Hardcoded in `requestExport()` |
| Token cleanup | Runs via `expireStaleDownloadTokens()` | `DATA_EXPORT_TTL_MS` env var |

## Export Manifest

Exports include `export_manifest.json` with `schemaVersion: "1.0"`. The manifest
lists each exported file, its source, and each field's type and nullability.
It does not include credentials, tokens, staff-only moderation annotations,
internal secret names, or deleted content. The field descriptions are additive
metadata and do not change the existing ZIP or JSON download contract.

## Export Statuses

| Status | Meaning |
|---|---|
| `PENDING` | Queued, waiting for background job |
| `PROCESSING` | Job picked up, file being generated |
| `READY` | File available for download |
| `FAILED` | Job failed (retryable) |
| `CANCELLED` | Owner canceled or account/privacy state changed; artifact and chunks are purged |
| `EXPIRED` | Download window elapsed |

## Snapshot Consistency

The worker records a hash of the owner's privacy state when processing starts, checks it after compilation and chunk creation, and conditionally publishes only while the request is still `PROCESSING`. Account deletion, activation changes, and privacy-settings updates synchronously cancel that user's pending, processing, failed, and ready exports. Download-link issuance and every file/chunk delivery also verify current ownership, user existence, consent, and the stored snapshot hash. Missing users are rejected as not found, consent withdrawal as forbidden, and stale snapshots as gone; the associated export artifacts are purged.

Apply migration `AddExportPrivacySnapshotVersion20261021000001` before deploying this behavior. Exports created before the migration have no fingerprint and will be invalidated on their next link or download attempt.

## Download Token Rules

1. A one-time random nonce is generated per `generateSignedDownloadUrl()` call.
2. Only the HMAC-SHA256 hash is stored in `downloadTokenHash`.
3. On first successful download, `downloadTokenHash` is cleared and `downloadedAt` is stamped.
4. Replay attempts (same token, or after `downloadedAt` is set) are rejected.
5. Tokens expire when `createdAt + TTL` elapses, even if never used.

## Redownload Behaviour

| File Available | Token Active | `canRedownload` | `canRequestNewLink` |
|---|---|---|---|
| Yes | Yes | `true` | `false` |
| Yes | No | `false` | `true` |
| No | - | `false` | `false` |

## Code References

- Service: `src/data-export/data-export.service.ts`
- Constants: `src/data-export/data-export.constants.ts`
- Cleanup scheduler: `src/data-export/data-export-cleanup.ts`
- Tests: `src/data-export/data-export.service.spec.ts`
