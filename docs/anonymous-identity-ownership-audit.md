# Anonymous Identity and Ownership Security Audit

## Account and Preference Ownership Boundary

Personalization and discovery preferences are account-owned state. They are
persisted against the authenticated account and must not be written, read,
cached, or exported as browser-local state belonging to another account.

| Preference | Owner | Account-switch behavior |
|---|---|---|
| Personalization opt-out / enabled flag | Authenticated account | Load only for the active account; invalidate account discovery caches on change. |
| Discovery diversity threshold | Authenticated account | Do not copy to a browser default or carry it into another account session. |
| Excluded discovery categories | Authenticated account | Replace only the active account's value; clear session-derived views on logout. |
| Saved searches and search history | Authenticated account | Bind reads and writes to `req.user.id`; never reuse another account's rows. |
| Anonymous context / draft identity | Unlinked anonymous identity or linked account identity | Linked identities remain visible only to the owning account; account switches require re-resolution. |
| Device-only transient UI state | Browser | Never treated as an account preference; discard when it contains owner-sensitive ranking signals. |

Invalid or failed preference operations return `400` for validation failures,
`401` for missing authentication, `403` for mismatched account ownership,
and `404` for missing owner-bound records. Writes fail closed: the prior
account preference remains authoritative when persistence or cache
invalidation fails. On account switch or logout, in-memory personalized
recommendations and account-bound caches are cleared or replaced before the
next account request is served.

Issue: #1694

## Threat Model

XConfess separates real account identity from anonymous identities. Any anonymous identity linked through `user_anonymous_users` is private account state. A caller must not be able to infer, use, mutate, export, message, report as, or moderate through another account's linked anonymous identity.

The default rule is:

- Linked anonymous identity: usable only by the linked authenticated account.
- Unlinked anonymous identity: usable by public anonymous surfaces that intentionally do not require login.
- Missing or forged linked identity: return `404` so the response does not confirm whether the identity exists.
- Admin exception: admin-only moderation/report/audit endpoints may cross ownership boundaries when protected by `JwtAuthGuard` and `AdminGuard`.

## Endpoint Ownership Matrix

| Surface | Endpoint | IDs accepted | Ownership rule | Failure |
| --- | --- | --- | --- | --- |
| Confessions public feed | `GET /confessions`, `GET /confessions/:id`, search/tag/trending routes | `confessionId`, tag/search query | Public approved, non-deleted surface. No user ownership required. | `404` for missing/deleted item paths |
| Confession create | `POST /confessions` | body only | Creates a fresh anonymous confession through service rules. No linked identity is accepted from caller. | `400` validation |
| Confession mutate | `PUT /confessions/:id`, `DELETE /confessions/:id`, `PATCH /confessions/:id/restore`, schedule routes | `confessionId` | High-risk legacy surface. Must be treated as owner/admin-only before production exposure. | Should be `403`/`404` |
| Comments public read | `GET /confessions/:confessionId/comments` | `confessionId` | Public approved comments only. | Empty/`404` via confession filtering |
| Comments create/edit/delete | `POST/PATCH/DELETE /confessions/:confessionId/comments...` | `confessionId`, `commentId`, `anonymousContextId` | JWT a required. Edit/delete compares comment anonymous user to authenticated request anonymous user. | `403`/`404` depending path |
| Reactions | `POST /reactions` | `confessionId`, `anonymousUserId` | Optional JWT. Linked `anonymousUserId` must belong to authenticated caller; unlinked IDs remain public. | `404` for forged/missing anonymous identity |
| Reports | `POST /confessions/:id/report` | `confessionId`, `x-anonymous-user-id`, idempotency key | Optional JWT. Authenticated reports use real `reporterId`; anonymous reports may use only unlinked anonymous identities. Linked IDs cannot be used without owner auth. | `400` missing anon header, `404` forged/missing linked identity |
| Messages | `POST /messages`, reply/thread/inbox routes | `confessionId`, `messageId`, `threadId`, sender anonymous ID in thread | JWT required. Service resolves sender from caller session and verifies thread participant via caller's anonymous links. | `404` for non-participant thread reads |
| Data export | `/data-export/*`, `/export/*` | `exportId`, `jobId`, signed token | JWT endpoints bind requests by `req.user.id`. Signed downloads require the stored token, not only ID. | `401` invalid token, `404` missing owner-bound job |
| User history/profile private | `GET /users/:userId/activities`, `confessions`, settings/delete | `userId` | `OwnershipGuard` requires `req.user.id === :userId`; delete allows admin bypass. | `403` |
| Admin reports/moderation/users | `/admin/*`, comment admin, moderation, email, key rotation, DLQ admin | report/confession/comment/user IDs | Admin-only exception. Must be protected by `JwtAuthGuard` + `AdminGuard`. | `403` for non-admin |
| Tips | `/confessions/:id/tips*`, tip verification | `confessionId`, `tipId`, `txId` | Public tip stats by confession; verification is idempotent by `(confessionId, txId)` and does not accept anonymous account identity. | `404` missing confession, `409` replay/conflict |

## Hardened Endpoints

- `POST /reactions`
  - Now uses `OptionalJwtAuthGuard`.
  - Linked `anonymousUserId` requires the authenticated linked account.
  - Public unlinked anonymous identities continue to work.

- `POST /confessions/:id/report`
  - Anonymous reports now verify the supplied `x-anonymous-user-id`.
  - Linked anonymous identities are rejected for anonymous callers with `404`.
  - Authenticated reports continue to bind to `reporterId`, not a body/header identity.

## Username and Identity Enumeration Resistance

Issue: #27

Registration, login, recovery, and profile endpoints can reveal whether an identity exists through response differences, status codes, headers, or timing. The following rules normalize externally visible behavior while keeping internal logs useful.

### Externally Visible Contract

| Surface | Endpoint | Existing identity | Non-existing identity | Notes |
| --- | --- | --- | --- | --- |
| Registration | `POST /auth/register` | `201` generic success body | `201` generic success body | Duplicate registration must not confirm the account exists. If the email/username is taken, respond with the same shape and status as a fresh registration and notify the real owner out-of-band. |
| Login | `POST /auth/login` | `200` with tokens | `401` generic `Invalid credentials` | Same status, body, and headers for unknown user, wrong password, and disabled account. |
| Password recovery request | `POST /auth/recovery/request` | `202` generic accepted | `202` generic accepted | Always return the same body and status; never echo whether the identifier matched. |
| Password recovery verify | `POST /auth/recovery/verify` | `200`/`400` based on token validity only | `400` generic invalid token | Token validity is the only signal; do not branch on whether the account exists. |
| Profile lookup | `GET /users/:userId` | `200` public profile | `404` generic not found | `404` must not distinguish deleted, private, or never-existed accounts. |
| Username availability | `GET /auth/username-available` | `200` `{ available: false }` | `200` `{ available: true }` | If this endpoint is exposed, it is an explicit product decision and must be rate limited; otherwise remove it. |

### Timing Budget

- Authentication and recovery handlers must run the same code path for existing and non-existing identities, including a constant-cost password hash comparison against a dummy hash when the user is missing.
- Target budget: the difference in p95 latency between existing and non-existing identities must stay within 50 ms on the reference environment.
- Timing tests assert the budget rather than exact equality to avoid flakiness on shared CI runners.

### Internal Logging

- Logs may record the outcome (`login_failed`, `recovery_requested`, `register_duplicate`) and a hashed identifier (`sha256(lowercased(identifier) + LOG_SALT)`).
- Logs must not contain raw email addresses, usernames, or user IDs on enumeration-sensitive paths.
- Operators can still correlate repeated attempts by the hashed identifier without exposing the underlying identity.

### Regression Coverage

- `src/auth/auth-enumeration.spec.ts`
  - Registration returns identical status, body, and headers for new and duplicate identities.
  - Login returns identical status, body, and headers for unknown user, wrong password, and disabled account.
  - Recovery request returns identical status, body, and headers for existing and non-existing identities.
  - Timing budget: p95 delta between existing and non-existing identities stays within 50 ms.
  - Logs on enumeration-sensitive paths contain only hashed identifiers.

## Account Merge and Anonymous Identity Transfer

Issue: #1694

An authenticated account may need to adopt anonymous activity that was created before login. The merge workflow must never silently reassign ownership and must leave audit evidence for every decision.

### Scope and Boundary

- Merge is always initiated by the authenticated target account. The caller cannot merge another account's records.
- The source anonymous identity must be unlinked and unclaimed at the time of merge. Already-linked identities are not mergeable.
- Merge is atomic where the datable allows; where it is not, the operation is wrapped in a compensating rollback that restores the pre-merge ownership state.
- Conflicts are surfaced to the caller with explicit confirmation requirements before any write is committed.

### Merge Request Contract

`POST /accounts/merge` is JWT-required. The body carries the source anonymous identity and an explicit confirmation flag. The target account is derived from `req.user.id` and is never taken from the request body.

| Field | Required | Rule |
| --- | --- | --- |
| `anonymousIdentityId` | yes | Must resolve to an unlinked anonymous identity owned by the caller or unclaimed. Forged/missing IDs return `404`. |
| `confirmConflicts` | yes | Must be `true` when the preview reports conflicts. Omitted or `false` with conflicts returns `409` with the conflict list. |
| `rollbackOnConflict` | no | Defaults to `true`. When false, the caller explicitly accepts the declared conflict resolution. |

### Conflict Matrix

Conflicts are detected before any write. Each conflict reports the affected record class, the source owner, the target owner, and the resolution that will be applied only after explicit confirmation.

| Record class | Conflict type | Detection | Resolution required | Failure without confirmation |
| --- | --- | --- | --- | --- |
| Usernames | Source username already bound to the target account or to another account | `UNION SELECT` on normalized username across source and target ownership | Keep the target account's existing username; attach the source username as an alias only when the target does not already hold it | `409` with `conflicts: ["xusername"]` |
| Messages | Source anonymous identity is a participant in a thread that also has the target account as a participant | thread participant join on `thread_participants` | Merge the participant rows into the target account's participant row and deduplicate messages by `id`; never drop a message without an explicit confirmation |
| Drafts | Source and target both hold a draft for the same confession | draft key on `(confessionId, ownerId)` | Keep the most recently updated draft and preserve the other as a conflict artifact in the audit log |
| Tips | Source and target both record a tip for the same `txId` on the same confession | unique `(txId, confessionId)` | Keep a single tip record; attach the consolidated ownership to the target account and record the deduplicated source row in the audit log |
| Anchors | Source and target both reference the same anchor on the same confession | anchor key on `(confessionId, anchorId)` | Keep one anchor row and merge the ownership metadata into the target account |

### Atomicity and Rollback

- The merge is executed inside a single database transaction when the storage engine supports it.
- When a transaction is not available, the service writes an intent record before any mutation and records a compensating operation for every write. On failure, the compensating operations are applied in reverse order until the pre-merge ownership state is restored.
- Rollback is attempted for any failure after the first write, including validation errors discovered mid-merge and conflicts that were not confirmed by the caller.
- Rollback failures are logged with the merge identifier and the failed step, without exposing raw account identifiers.

### Authorization

- The caller must be authenticated; unauthenticated requests return `401`.
- The caller may only merge an anonymous identity that is unlinked and unclaimed. Attempts to merge an identity already linked to another account return `404` so the response does not confirm the identity exists.
- Admin bypass is not available for the merge endpoint. Merge is an owner-initiated operation.

### Audit Evidence

Every merge attempt writes an audit record that includes:

| Field | Description |
| --- | --- |
| `mergeId` | Server-generated identifier for the attempt. |
| `actorUserId` | Authenticated target account identifier. |
| `sourceAnonymousId` | Hashed source anonymous identity identifier. |
| `outcome` | `merged`, `conflict`, `rolledback`, or `rejected`. |
| `conflicts` | List of conflict classes surfaced during the attempt. |
| `rollbackSteps` | Ordered list of compensating operations applied on failure. |
| `timestamp` | Server time of the attempt. |

Audit records are append-only and are retained even when the merge fails or rolls back.

### Response Contract

| Outcome | Status | Body |
| --- | --- | --- |
| Successful merge | `200` | `{ mergeId, outcome: "merged", conflicts: [] }` |
| Unconfirmed conflicts | `409` | `{ mergeId, outcome: "conflict", conflicts: [...] }` |
| Rolled back after failure | `500` | `{ mergeId, outcome: "rollback", conflicts: [...] }` |
| Unauthorized or forged source | `401`/`404` { mergeId, outcome: "rejected" } |

### Runbook

1. Preview the merge with `confirmConflicts: false` to obtain the conflict list.
2. Review the conflict list with the account owner and confirm the resolutions.
3. Re-run the merge with `confirmConflicts: true` only after the owner accepts the resolutions.
4. If the merge rolls back, inspect the audit record by `mergeId` and report the failed step to the on-call operator.
5. Never retry a merge without a new preview and confirmation cycle.

## Regression Coverage

- `src/common/security/anonymous-identity-ownership.spec.ts`
  - Shared anonymous identity assertion tests.
- `src/reaction/reaction.service.spec.ts`
  - Owner linked identity allowed.
  - Another user's linked identity rejected with `404`.
  - Public unlinked anonymous identity still works.
- `src/report/reports.service.spec.ts`
  - Anonymous report with forged linked identity rejected before report creation.
- `src/account/account-merge.service.spec.ts`
  - Unlinked anonymous identity merges into the authenticated target account.
  - Already-linked identity merge attempt returns `404` without mutating ownership.
  - Unauthenticated merge request returns `401`.
  - Unconfirmed conflicts return `409` and leave ownership unchanged.
- `src/account/account-merge.rollback.spec.ts`
  - Failure after the first write restores the pre-merge ownership state.
  - Audit record is retained with the rollback steps and the merge identifier.

## Review Evidence Commands

```bash
npm run test --workspace=xconfess-backend - src/common/security/anonymous-identity-ownership.spec.ts src/reaction/reaction.service.spec.ts src/report/reports.service.spec.ts src/account/account-merge.service.spec.ts src/account/account-merge.rollback.spec.ts
npm run build --workspace=xconfess-backend
```
