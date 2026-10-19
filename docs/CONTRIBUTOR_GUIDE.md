# Contributor Guide

This guide is the starting point for external contributors working on xConfess.
It ties together local setup, issue selection, branch names, pull request
linking, validation commands, and review handoff.

## Choosing Work

Before starting work, choose an open issue, check that it is not already
assigned, and look for an existing pull request that mentions the same issue
number or title. If the issue is unclear or broad, ask a maintainer to confirm
scope before opening a large PR.

## Local Setup

Run these commands from a fresh clone of the repository.

```bash
git clone https://github.com/Xconfess/Xconfess.git
cd Xconfess
npm install
```

Start the local infrastructure:

```bash
docker compose -f compose.yaml up -d
docker compose -f compose.yaml ps
```

Copy the local environment templates:

```bash
cp xconfess-backend/.env.example xconfess-backend/.env
cp xconfess-frontend/.env.example xconfess-frontend/.env.local
```

The example files are intentionally safe for local development. Do not commit
`.env` or `.env.local`, and do not paste private keys, tokens, passwords, or
production credentials into issues, pull requests, screenshots, or logs.

For a faster local UI workflow, you may add this value to
`xconfess-frontend/.env.local`:

```bash
NEXT_PUBLIC_DEV_BYPASS_AUTH=true
```

## Running The App

Run the full stack from the repository root:

```bash
npm run dev
```

Or run one service at a time:

```bash
npm run dev:backend
npm run dev:frontend
```

Default local URLs:

- Frontend: `http://localhost:3000`
- Backend API: `http://localhost:5000`
- Live health check: `http://localhost:5000/api/health/live`
- Readiness health check: `http://localhost:5000/api/health/ready`
- Postgres: `localhost:55432`
- Redis: `localhost:6379`

## Branch Naming

Use a small, issue-focused branch name:

```bash
git checkout -b docs/contributor-guide
git checkout -b fix/comment-search-proxy
git checkout -b test/wave-demo-journey-smoke
```

Keep each branch scoped to one issue. Avoid unrelated formatting, generated
files, dependency upgrades, or cleanup unless the issue explicitly asks for them.

## Validation Commands

Run the smallest relevant check while developing, then run the full CI command
before opening the pull request when practical.

```bash
# Backend only
npm run backend:build
npm run backend:lint
npm run backend:test

# Frontend only
npm run frontend:lint
npm run frontend:test
npm run frontend:build

# Contracts only
npm run contract:fmt:check
npm run contract:lint
npm run contract:test
npm run contract:build:release

# Full repository check
npm run ci
```

If a full check cannot run locally because a dependency, Docker service, or
platform tool is unavailable, document the failed command and the exact blocker
in the pull request body.

## Advanced Search Query Grammar

Advanced search is parsed and enforced by the backend at the owning boundary
(`backend/src/search`). The parser accepts only the documented grammar below;
anything outside it is rejected with a stable validation error rather than
being silently interpreted or forwarded to the database.

### Allowlisted Fields

Only these fields may appear on the left of an operator:

- `author` — message author handle
- `conversation` — conversation id
- `tag` — message tag
- `before` / `after` — ISO-8601 date bounds
- `has` — attachment presence (`has:attachment`)

Any other field name is rejected with `SEARCH_UNKNOWN_FIELD`.

### Allowlisted Operators

- `field:value` — equality match
- `field:"quoted value"` — equality match with spaces
- `-field:value` — negation
- Bare terms (no operator) are treated as full-text terms

Operators outside this set (for example `field>value`, `field~value`, or
wildcards like `field:*`) are rejected with `SEARCH_UNSUPPORTED_OPERATOR`.

### Complexity Limits

The parser caps query complexity so a single request cannot trigger an
expensive scan. Exceeding any limit is rejected with `SEARCH_QUERY_TOO_COMPLEX`:

- Maximum of 32 tokens per query
- Maximum of 16 clauses (field matches plus bare terms)
- Maximum nesting depth of 2 (one level of parentheses)
- Maximum of 256 characters per quoted value

### Validation Error Codes

Malformed or disallowed expressions return a stable error code and message so
clients can render consistent feedback:

| Code | Meaning |
| --- | --- |
| `SEARCH_EMPTY_QUERY` | Query is empty or whitespace only |
| `SEARCH_UNKNOWN_FIELD` | Field is not in the allowlist |
| `SEARCH_UNSUPPORTED_OPERATOR` | Operator is not in the allowlist |
| `SEARCH_UNBALANCED_QUOTES` | Quoted value is not terminated |
| `SEARCH_UNBALANCED_PARENS` | Parentheses are unbalanced |
| `SEARCH_QUERY_TOO_COMPLEX` | A complexity limit was exceeded |

### Failure Semantics

- Invalid queries are rejected before any database access; they never reach
the query builder.
- Rejections return `400 Bad Request` with the error code above and a
  human-readable message; they are not retried automatically.
- Authorization is checked before parsing, so unauthorized callers receive
  `403` regardless of query validity.

### Testing Expectations

Backend tests for this area must cover the expected path plus adversarial
inputs (unknown fields, unsupported operators, unbalanced quotes/parens, and
queries that exceed the complexity caps) and the regression risk of a
malformed query reaching the database. Run them with:

```bash
npm run backend:test
```

## Message Retention And Expiry

Private messages have an explicit, enforceable lifecycle. Retention is chosen
per conversation and enforced by the backend at the ownership boundary; clients
must not assume messages live forever or that local copies outlive the server.

### Supported Retention Choices And Defaults

Moderation reviewers interpret ambiguous policy cases. To keep decisions
consistent without letting consensus replace policy review, reviewer guidance is
versioned and reviewers are calibrated against anonymized exercises.

### Versioned Annotation Guidelines

- Guidelines are versioned; every review decision records the guideline version
  it was made under so past decisions remain reproducible.
- Publishing a new guideline version is an authorized action (moderator/admin)
  enforced at the owning backend boundary; unauthorized publishes are rejected
  with `403`.
- A decision referencing an unknown or retired guideline version is rejected
  with `422` rather than silently falling back to the latest version.

### Anonymized Calibration Exercises

- Calibration exercises present anonymized cases (no reporter or author
  identity) so reviewers judge the policy question, not the person.
- Exercise responses are stored separately from live moderation decisions and
  never affect a real case outcome.
- Only authorized reviewers may fetch exercises or submit responses;
  unauthorized access is rejected at the boundary.

### Measuring Agreement

- Reviewer agreement (e.g. inter-rater agreement such as Cohen's or Fleiss'
  kappa) is computed over calibration responses and reported as a signal.
- Agreement is **not** a substitute for policy review: a high-agreement but
  policy-incorrect answer is still wrong, and consensus never auto-resolves a
  live case.
- Agreement metrics are advisory; final decisions remain with authorized
  reviewers applying the current guideline version.

### Testing Expectations

Backend tests for this area must cover the expected path plus rejection cases
(unauthorized guideline publish, unknown guideline version, unauthorized
calibration access) and the regression risk that agreement metrics are treated
as advisory rather than as an automatic decision. Run them with:

```bash
npm run backend:test
```

## Safe Policy Replay

Policy migrations need a way to estimate how decisions would change under a new
policy version **without** touching live user content or notifying anyone. The
replay command runs over a selected set of moderation cases in isolation.

### Running A Replay

```bash
npm run backend:replay -- \
  --policy-version <new-version> \
  --cases <case-id,case-id,...>
```

- Replay is an authorized action (moderator/admin) enforced at the owning
  backend boundary; unauthorized invocations are rejected with `403`.
- An unknown or retired target policy version is rejected with `422`.

### Isolation Guarantees

- Replay never mutates live user content, never writes production decision
  records, and never triggers notifications or fanout.
- Replay reads cases into an isolated evaluation context; results are written
  only to the diff report, not to the case store.

### Redaction

- Replay inputs and outputs redact identifiers: user ids, author/reporter
  identity, and raw content are replaced with stable opaque tokens.
- The diff report contains only redacted tokens, decision labels, and counts —
  never raw content or personal identifiers.

### Diff Report

- The report compares the recorded decision against the decision the new policy
  version would produce, per case, and summarizes changed vs unchanged counts.
- The report is advisory: it cannot apply decisions to production records.

### Testing Expectations

Backend tests for this area must cover the expected path plus rejection cases
(unauthorized replay, unknown policy version) and the regression risk that a
replay mutates live content, writes production decisions, or leaks identifiers.
Run them with:

```bash
npm run backend:test
```

## User Safety Filters For Sensitive Content

Users can opt in or out of seeing sensitive content categories. These are
**display preferences only** and never change moderation enforcement.

### Supported Categories

- **Join** — a user may join only via an accepted invite or an explicit
  self-join policy enabled for the conversation. Direct joins without either
  are rejected with `403`.
- **Leave** — any active member may leave. Leaving removes the member from
  future fanout but preserves their historical access per the history rules
  below.
- **Remove** — only the conversation owner or an authorized moderator may
  remove another member. Removing a non-member is a no-op success; removing
yourself must go through the leave path.
- Every transition is idempotent and records the actor, target, and reason so
  audit trails stay consistent.

### Where Preferences Are Applied

- Only active members with the `invite` capability (owner, moderators, or
  members when the conversation allows member invites) may create invites.
- Invites are scoped to a single conversation and a single invitee, expire, and
  

### Supported Retention Choices And Defaults

- `7d`, `30d`, `90d`, `1y`, and `forever` are the supported retention choices.
- The default is `30d` when a conversation does not specify one.
- Retention is set by an authorized participant (owner or moderator) and is
  validated against the supported set; unknown values are rejected with `422`.
- Changing retention applies to messages going forward and re-evaluates
  existing messages against the new window.

### Expiry Enforcement

- Expiry is enforced in primary storage: expired messages are excluded from
  reads and purged by the retention job.
- Secondary indexes (search, previews, unread) are updated in the same
  operation so expired content is never surfaced.
- Notifications and device sync fanout skip expired messages; clients receive
  an expiry event and drop the local copy.
- Reads of an expired message return `410 Gone` rather than `404`, so clients
  can distinguish expiry from a missing message.

### Deletion Completion Records

```bash
npm run backend:test
```

## Cross-Domain Data Integrity Verification (#218)

Independent table-level constraints can leave subtle orphan references across boundaries.
The platform provides a read-only integrity report endpoint at `GET /api/admin/integrity/report` with:
- **Domains covered**: `identity` (links between users and anonymous identities), `content` (confessions, comments), `export` (export requests, chunks), and `moderation` (reports, evidence).
- **Stable Error Codes**: Canonical `ERR_INTEGRITY_*` codes for predictable log parsing and alert routing.
- **Bounded Execution**: Configurable timeout budgets (`timeoutMs`, default 5s, max 30s) and per-check row limits (`limit`, default 50, max 200). If execution exceeds time bounds, the report returns truncated without crashing.
- **Repair Guidance**: Each violation includes an actionable SQL query or remediation step for operators.
- **Authorization**: Strictly restricted to administrators via `JwtAuthGuard` and `AdminGuard`.

## Locale-Aware Message Catalogues with Typed Coverage (#219)

User-facing strings are decoupled from presentation components into typed message catalogues under `xconfess-frontend/app/lib/i18n/`.
- **Catalogue Structure**: Canonical keys are defined in `types.ts` (`REQUIRED_MESSAGE_KEYS`) and implemented in locale files (`locales/en.ts`, `locales/es.ts`).
- **Typed Coverage**: The TypeScript types enforce that all catalogues provide every required key. `assertCompleteCatalog` verifies runtime completeness and fails checks if any key is missing.
- **Fallback Behavior**: When a localized string is missing in the user's active locale, the `useTranslation` hook automatically falls back to the default English (`en`) catalogue. If missing in all catalogues, the key itself is returned.

## Localized Formatting for Dates, Numbers, and Relative Time (#220)

Shared formatters live in `xconfess-frontend/app/lib/i18n/formatters.ts` and wrap standard `Intl` APIs:
- **Relative vs Absolute Time**: `formatRelativeTime` formats recent intervals into relative units (seconds, minutes, hours, days) and automatically transitions to absolute dates (`formatAbsoluteDate`) beyond configurable thresholds.
- **Daylight Saving Time (DST)**: Relative durations use monotonic UTC millisecond math to avoid hour-boundary distortion during spring-forward or fall-back transitions.
- **Safe Fallbacks**: Missing, null, undefined, or non-parseable inputs return safe fallback tokens (default `"—"`) rather than throwing runtime exceptions.
- **Numbers and Pluralization**: `formatNumber` and `formatCount` format counts, compact abbreviations (`1.2K`), and locale-appropriate plural nouns.

## Cross-Tab Draft Conflict Resolution (#221)

When users edit confession drafts across multiple browser tabs:
- **Revision Tracking**: Drafts maintain monotonic integer `version` numbers across saves.
- **Stale Write Detection**: `useDrafts` inspects storage state prior to persisting. If another tab has committed a higher version, the local write is rejected and flagged as a `tab_conflict`.
- **Dual-Version Preservation**: Unsaved local content and the newer conflicting version from storage are both captured in memory without data loss.
- **Accessible Decision Flow**: `DraftManager` presents an accessible alert (`role="alert"`, `aria-live="assertive"`) offering choices to:
  1. *Keep my version*: Rebase and persist local content with an incremented revision.
  2. *Use other tab's version*: Overwrite the local editor with the newer copy.
  3. *Save as separate draft*: Store the local content as a new draft, preserving both versions.
  4. *Dismiss*: Dismiss the notice without altering editor state.

