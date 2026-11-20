# Privacy Diagnostics, Cross-Device Sync, Export Receipts & Support Redaction

## 1. Field-Level Privacy in Logs and Diagnostics (#406)
- All loggers and diagnostic serializers run through `PrivacyLogSanitizer`.
- Automatic redaction prevents secrets (Stellar secret seeds, hex tokens, JWTs, Bearer headers), user passwords, emails, confession contents, and direct chat messages from entering logging sinks or diagnostics payloads.

## 2. Consent-Aware Preference Synchronization Across Devices (#407)
- **Synchronizable Keys**: Only non-sensitive preferences (`theme`, `contentLanguage`, `nsfwBlur`, `emailDigestFrequency`, `soundEffectsEnabled`, `reducedMotion`, `displayCompactMode`) are accepted.
- **Excluded Secrets**: Device-local keys (`pushNotificationToken`, `deviceBiometricKey`, `localEncryptionKey`, `sessionCookie`, `hardwareId`, `privateKeystore`) are stripped and rejected.
- **Deterministic Conflict Resolution Rule**:
  1. Higher `version` number wins.
  2. If version matches, later `clientUpdatedAt` ISO timestamp wins.
  3. If timestamps match, tie is broken deterministically by string comparison of `deviceId`.

## 3. Access Receipts for Data Exports (#408)
- Generates verifiable audit receipts for data exports (`ExportReceipt`) containing:
  - `exportRequestId`, `requestedAt`, `completedAt`, `expiresAt`, `fileSizeBytes`, `sha256Digest`.
- Strict user-only access:
  - Users can only query receipts belonging to their own `userId`.
  - Platform administrators and moderators are barred from inspecting user data export receipts by default.
  - Raw export payloads and files are ephemeral and never retained within the audit receipt.

## 4. Privacy-Safe Support Report Redaction (#409)
- User-submitted reports provide a two-phase flow:
  1. `POST /support/preview`: Returns sanitized payload with masked emails, IPs, tokens, and preview of redacted text.
  2. `POST /support/submit`: Finalizes submission referencing `previewId`.
- Explicit user inclusion toggles:
  - `includeDiagnosticsLogs`: Omitted unless explicitly enabled.
  - `includeDeviceInfo`: Masked subnet IP unless opted in.
