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

## Accessibility Contributor Test Harness

The accessibility harness gives every contributor a consistent, low-friction
way to run the same checks locally. It is wired into the standard frontend
commands, so a clean checkout can run it without extra setup:

```bash
npm run frontend:lint        # static a11y lint rules
npm run frontend:test        # component-level a11y assertions
npm run frontend:test:e2e    # browser-level a11y checks
```

### Fixtures

Shared fixtures live under `xconfess-frontend/tests/a11y/fixtures/`. They cover
the routes and states the harness exercises (for example the confession feed,
comment thread, and profile pages). Add a fixture when you introduce a new route
or a new interactive state that needs coverage; keep fixtures minimal and free
of real user data.

### Browser Setup

End-to-end accessibility checks run in a real browser via Playwright. Install
the browser binaries once per machine:

```bash
npx playwright install --with-deps chromium
```

Then run the harness through the standard command:

```bash
npm run frontend:test:e2e
```

If the browser cannot be installed in your environment, run the lint and unit
layers (`npm run frontend:lint && npm run frontend:test`) and note the blocker in
your pull request.

### Reading Harness Output

Every failure names the route under test and the specific rule that was
violated, for example:

```
/a11y/feed  color-contrast  expected 4.5:1, got 3.1:1
/a11y/profile  label  form control has no accessible name
```

Use the route to reproduce the page and the rule to look up the requirement
before changing markup.

### Known Limitations

- Automated checks cover a subset of WCAG rules and cannot judge meaning,
  reading order, or content quality.
- Dynamic states (modals, toasts, async loading) are only covered where a
  fixture exists.
- Screen reader behavior and keyboard-only flows are not fully simulated.

### When Manual Testing Is Required

Run manual testing in addition to the harness when a change affects:

- Keyboard navigation, focus order, or focus trapping.
- Screen reader announcements, live regions, or dynamic content updates.
- Color, contrast, or motion where the automated rule set is incomplete.
- Any new interactive component without an existing fixture.

### Failure Triage

1. Reproduce the failing route locally with `npm run dev:frontend`.
2. Confirm the rule in the harness output against the WCAG requirement.
3. Fix the markup or styles at the source rather than suppressing the rule.
4. If a rule is a false positive, document why in the pull request and add a
   scoped, commented exception instead of disabling the check globally.

## Database Migrations

xConfess uses TypeORM migrations to manage the Postgres schema. There are two
migration directories:

- `xconfess-backend/migrations/` — historical and feature migrations.
- `xconfess-backend/src/migrations/` — newer in-source migrations.

Both directories are loaded by the TypeORM CLI and the app at startup.

### Show pending migrations

```bash
npm run backend:migration:show
```

This prints the list of all migrations and which ones have already run in the
connected database. Check that it completes without TypeORM class-name errors
before opening a migration-related PR.

### Run pending migrations (clean database)

For a fresh Postgres database — for example, a new Docker container — run all
pending migrations in order:

```bash
npm run backend:migration:run
```

This is the standard path for CI, staging, and production deployments.

### Repair a local synchronized database

If your local database was bootstrapped with TypeORM `synchronize: true` (the
old default for dev), the schema may be missing columns or indexes that
migrations add. **Use the repair command instead of blowing away your database:**

```bash
npm run backend:schema:repair
```

This script is idempotent and data-safe. It adds any missing
`anonymous_confessions` columns and indexes and backfills `search_vector` for
existing rows. It must only be used locally — never in staging or production.

### Verify schema readiness

After either path, confirm the readiness probe returns 200:

```
GET http://localhost:5000/api/health/ready
```

If the schema check is still failing, the response body includes `missingColumns`,
`missingIndexes`, and a `hint` with the exact command to run.

## Pull Request Checklist

Your pull request should include:

- A short summary of what changed.
- The validation commands you ran and their results.
- Screenshots for visible UI changes.
- Any known limitations or follow-up work.
- A closing keyword that links the issue.

Use this format in the pull request body so GitHub can connect the work to the
issue:

```md
Closes #1118
```

Replace `1118` with the actual issue number you are solving. Do not omit the
closing keyword when the PR resolves an issue.

## Review Handoff

When the PR is ready, use the ready-for-review template:

- [Wave 5 ready-for-review template](WAVE_5_READY_FOR_REVIEW_TEMPLATE.md)

If your PR includes logs or screenshots, follow the redaction rules:

- [Attaching logs to issues and PRs](LOG_ATTACHING_GUIDE.md)

Never include production secrets, private keys, or credentials in any artifact
attached to an issue or pull request.
