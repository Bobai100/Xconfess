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

## Reviewer Guidelines And Calibration

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

- `violence`, `nudity`, `profanity`, and `self_harm` are the supported
  sensitive content categories.
- Each category has an explicit per-user preference: `show` (opt in) or `hide`
  (opt out). Categories without a stored preference fall back to the default
  (`hide` for `self_harm`, `show` for the rest).

### Where Preferences Are Applied

- Preferences are stored and validated at the owning backend boundary; unknown
  categories or values are rejected with `422`.
- The same filter is applied consistently to both feed and search results so a
  category hidden in one surface is hidden in the other.
- Filtering happens at read time on the server; clients never receive content
  the user opted out of.

### Moderation Is Independent Of Display Preference

- Opting in to a category only affects display; it never bypasses moderation.
  Content that violates policy is still removed or restricted regardless of the
  user's filter settings.
- Opting out of a category hides content but does not report, flag, or otherwise
  affect the author's moderation status.

### Testing Expectations

Backend tests for this area must cover the expected path (preferences applied to
feed and search), rejection cases (unknown category or value), and the
regression risk that a display preference weakens moderation enforcement. Run
them with:

```bash
npm run backend:test && npm run frontend:test
```

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
- These markers support audit and 
