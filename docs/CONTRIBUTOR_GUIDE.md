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

## Message Retention And Expiry

Private messages have an explicit, enforceable lifecycle. Retention is chosen
per conversation and enforced by the backend at the ownership boundary; clients
must not assume messages live forever or that local copies outlive the server.

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

- When a message is purged, the backend records a deletion completion marker
  (message id, conversation id, timestamp, reason) **without** the message body.
- These markers support audit and idempotent retries and must never contain
  message content.

### Authorization And Failure Semantics

- Only authorized participants may read, change retention for, or delete
  messages; unauthorized requests are rejected with `403` at the owning
  boundary.
- Purge failures are retried and surfaced; a message is never reported as
  deleted until the deletion completion marker is written.

### Testing Expectations

Backend tests for this area must cover the expected path plus rejection cases
(unauthorized retention change, unsupported retention value, expired read) and
the regression risk of expired content leaking through indexes, notifications,
or device sync. Run them with:

```bash
npm run backend:test && npm run frontend:test
```

## Conversation Ordering And Unread Reconciliation

Conversation previews and unread counts are owned by the backend. Clients must
treat the server as the single source of truth and never derive ordering or
unread totals from local timestamps.

### Deterministic Ordering

- Conversation previews are ordered by a stable, server-assigned monotonic
  sequence (not client `createdAt`/`updatedAt`). Ties are broken by the
  conversation id so the order is total and reproducible.
- Each message and preview carries an event cursor. Clients apply events in
  cursor order and ignore any event whose cursor is not greater than the last
  applied cursor for that conversation.

### Reconnect Replay

- On reconnect, clients resume from their last applied cursor. Replay is
  idempotent: duplicate events are dropped and out-of-order events are buffered
  or discarded rather than reordering previews.
- Delayed delivery must not move a conversation ahead of a newer one; the
  server sequence, not arrival time, decides position.

### Unread Reconciliation

- Unread counts are reconciled from authoritative server state (the unread
  endpoint), not incremented optimistically from client events alone.
- Reconciliation requires an authenticated session; unauthenticated or
  unauthorized requests are rejected at the owning boundary and the client
  keeps its last known counts rather than guessing.
- On failure, clients surface the error and retry reconciliation; they must not
  silently reset counts to zero.

### Testing Expectations

Backend tests for this area must cover the expected path plus delayed,
duplicate, and out-of-order delivery, and the rejection/failure cases for
unauthorized reconciliation. Run them with:

```bash
npm run backend:test
```

## Multi-Member Conversation Authorization

Group conversations have their own authorization model. Membership, invites,
history visibility, blocking, and fanout are all enforced by the backend at the
ownership boundary; clients must not assume one-to-one messaging permissions
extend to groups.

### Membership Transitions

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

### Invite Authorization

- Only active members with the `invite` capability (owner, moderators, or
  members when the conversation allows member invites) may create invites.
- Invites are scoped to a single conversation and a single invitee, expire, and
  are single-use.

## Multilingual Search Normalization

Search queries and indexed text are normalized and tokenized by the backend at
the search boundary so that equivalent input matches regardless of Unicode form,
diacritics, or language-specific token boundaries. Clients must send raw query
text and must not pre-normalize it.

### Normalization Rules

- Text is normalized to Unicode NFKC before tokenization, so composed and
  decomposed forms (e.g. `é` vs `e` + combining accent) match.
- Diacritics are folded for Latin-script languages so `café` matches `cafe`.
- Case is folded using locale-aware lowercasing for the detected language.
- The same normalization is applied to both the query and the indexed text; a
  mismatch between the two is a bug.

### Tokenization Per Language

- Supported languages (`en`, `fr`, `es`, `de`, `pt`, `ar`, `zh`, `ja`) each
  define their own token boundaries. CJK languages tokenize per character or
  bigram rather than on whitespace; Arabic and Latin languages split on
  whitespace and punctuation.
- The language is taken from an explicit request hint when present, otherwise
  detected from the query, otherwise falls back to the default language.

### Fallback For Unknown Languages

- Unknown or unsupported languages use a safe fallback: NFKC normalization,
  case folding, and whitespace/punctuation tokenization without diacritic
  folding that could corrupt non-Latin scripts.
- Malformed input (invalid UTF-8, lone surrogates, control characters) is
  sanitized before normalization; it never throws and never reaches the index
  unnormalized.

### Authorization And Failure Semantics

- Search requires an authenticated session; unauthorized requests are rejected
  with `403` at the search boundary.
- Normalization failures fall back to the safe fallback path rather than
  returning an error, and are logged without query content.

### Testing Expectations

Backend tests for this area must cover the expected path plus mixed-script
input, malformed input, and the fallback for unknown languages, and the
rejection case for unauthorized search. Fixtures live alongside the search
tests. Run them with:

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

