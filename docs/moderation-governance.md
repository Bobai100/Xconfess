# Moderation governance

The admin API provides four safeguards for report handling: explicit access
grants, duplicate-report clusters, shadow policy evaluation, and previewable
policy application with rollback.

## Sensitive queue access

An administrator with `ADMIN` capability can grant access:

```http
POST /api/admin/moderation/access-grants
{
  "userId": 42,
  "reason": "On-call moderation coverage",
  "expiresAt": "2026-11-19T20:00:00.000Z"
}
```

The recipient must be an active administrator or moderator other than the
granting administrator. Expiry must be in the future and within 24 hours.
Grants can be audited through `GET /api/admin/moderation/access-grants` and
revoked with `DELETE /api/admin/moderation/access-grants/:id`. The report queue,
report actions, clustering, and policy operations require a current grant for
the `sensitive-report-queue` scope. Missing, revoked, or expired grants are
denied. Existing `/api/admin/reports` endpoints enforce the same rule.

Granted moderators use `/api/admin/moderation/report-queue` to list, inspect,
resolve, dismiss, or bulk-resolve reports. List requests are bounded to 100
records; bulk actions are bounded to 100 report IDs.

## Duplicate-report clustering

`GET /api/admin/moderation/report-clusters?limit=250` groups pending or
reviewing reports from the last 30 days by the exact confession ID and report
type. The response includes report IDs and the matching signals. It does not
include reporter identities or report text, modify any report, or resolve cases.
The scan limit is capped at 500.

## Shadow evaluation and policy preview

`POST /api/admin/moderation/policy-shadow-evaluations` accepts a policy rule
map and 1–100 fixture records containing only a report type and current
decision. It returns and persists aggregate disagreement counts and evaluation
latency; fixture-level data is not retained and live reports are never changed.

`POST /api/admin/moderation/policy-previews` accepts 1–100 report IDs and rules
mapping report types to `resolved` or `dismissed`, each with an explanation.
It returns representative report IDs, current/proposed states, and explanation
text. A preview is valid for 10 minutes and does not apply the policy.

Commit with `POST /api/admin/moderation/policy-previews/:id/commit`. Commit is
atomic and fails if a report changed since preview. A committed operation can
be rolled back for 24 hours with
`POST /api/admin/moderation/policy-previews/:id/rollback`; rollback is atomic
and refuses to overwrite a report modified after the policy was applied. All
grant, preview, evaluation, commit, and rollback operations are written to the
moderation audit log.

## Schema and validation

Migration `20261119000002-add-moderation-governance` creates the grant and
policy-run tables. Apply it through the normal backend migration workflow before
deploying the new endpoints. No existing report records are rewritten.

An hourly scheduled purge marks expired previews and removes their stored
snapshots; committed snapshots are removed after the 24-hour rollback window.
Rolled-back snapshots are removed immediately. Shadow inputs are never stored,
and their aggregate results are removed after 90 days. Expired or revoked grant
rows are removed after 90 days. Minimal audit-log decision records remain under
the platform's existing audit retention policy, including policy rules and
affected report IDs for committed changes.
