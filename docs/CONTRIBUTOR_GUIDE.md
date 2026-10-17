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

## Conversation-Level Blocking And Report Handoff

Blocking, reporting, and conversation access interact, so the backend defines
precedence and preserves only the safety evidence it needs. All of this is
enforced at the owning boundary; clients must not infer block or report state
locally.

### Atomic State Transitions

- A block is a single atomic transition: the block record, the conversation
  access change, and the delivery-suppression flag are written together or not
  at all. A partial block is never observable.
- A report is likewise atomic: the report record and its handoff marker are
  written in one transaction. If the handoff write fails, the report is not
  reported as filed and the caller receives an error to retry.
- Both transitions are idempotent: repeating a block or report for the same
  target returns the existing state rather than creating duplicates.

### Precedence When States Conflict

- A block takes precedence over conversation access: once a block is in place,
  the blocked party can no longer read, send to, or be fanned out the
  conversation, even if they were previously a member.
- A report does not by itself change conversation access. Reporting and
  blocking are independent; a reporter may block separately, and a block does
  not implicitly file a report.
- If a block and a report target the same conversation, the block's delivery
  suppression applies immediately while the report is handed off for review.

### Reporter Privacy

- The blocked party is never told who reported them, and report metadata is
  never included in conversation reads, previews, or fanout to the blocked
  party.
- Only the minimum safety evidence is retained: the report id, conversation
  id, reporter id (visible only to authorized reviewers), target id, reason
  code, and timestamp. Message bodies are not copied into the report record.

### Delivery Suppression And Queued Messages

- After a block, new messages to the blocked party are suppressed at the
  boundary and the sender receives a generic failure that does not reveal the
  block reason.
- Messages already queued for delivery when the block lands are dropped before
  fanout; they are not delivered late. The sender is not retroactively
  notified of the drop.
- Suppression is checked at send time and again at fanout time so a race
  between queueing and blocking cannot leak a message.

### Appeal Implications

- A block may be appealed through the moderation flow; filing an appeal does
  not lift the block. The block stays in effect until a reviewer resolves the
  appeal.
- Resolving an appeal in the blocked party's favor removes the block
  atomically and restores access per the conversation's membership rules.

### Authorization And Failure Semantics

- Only a participant may block or report within a conversation; unauthorized
  requests are rejected with `403` at the owning boundary.
- Blocking or reporting a non-participant is rejected with `404` so the caller
  cannot probe membership.
- Failed transitions surface an error and are safe to retry; the caller never
  sees a success for a transition that did not commit.

### Testing Expectations

Backend tests for this area must cover the expected path plus rejection cases
(unauthorized block/report, non-participant target), the atomicity of partial
failures, delivery suppression of already-queued messages, and the regression
risk of reporter identity leaking to the blocked party. Run them with:

```bash
npm run backend:test && npm run frontend:test
```
