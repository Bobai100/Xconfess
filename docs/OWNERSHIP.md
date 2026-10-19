# Contributor Dependency Graph and Ownership Map

This document describes subsystem ownership, service boundaries, data owners,
and escalation paths for the xConfess monorepo.  It is the human-readable
companion to [.github/CODEOWNERS](../.github/CODEOWNERS), which drives
GitHub's automatic reviewer assignment.

## How to read this document

- **Owner** — the GitHub user or team responsible for a subsystem.  They are
  the first point of contact for reviews, incidents, and questions.
- **Escalation** — who to contact when the primary owner is unavailable or the
  change spans multiple subsystems.
- **Data sensitivity** — whether the subsystem touches PII, secrets, or
  on-chain state.

---

## Subsystem Map

### 1. Backend API (`xconfess-backend/`)

| Subsystem | Path | Owner | Data sensitivity |
|-----------|------|-------|-----------------|
| Auth & session | `src/auth/` | @yazeed11011 | High — JWTs, cookies, TOTP |
| Admin RBAC | `src/admin/` | @yazeed11011 | High — step-up auth, role gates |
| Encryption / key rotation | `src/encryption/`, `src/key-rotation/` | @yazeed11011 | Critical — envelope keys |
| Confessions | `src/confession/`, `src/confession-draft/` | @yazeed11011 | High — encrypted content |
| Comments | `src/comment/` | @yazeed11011 | Medium |
| Reactions | `src/reaction/` | @yazeed11011 | Low |
| Private messages | `src/messages/` | @yazeed11011 | High — E2E encrypted |
| Moderation | `src/moderation/` | @yazeed11011 | Medium |
| Notifications | `src/notifications/` | @yazeed11011 | Medium — Redis-backed queues |
| Data export / privacy | `src/data-export/`, `src/export/` | @yazeed11011 | High — user PII |
| Stellar integration | `src/stellar/` | @yazeed11011 | High — on-chain txns |
| Analytics | `src/analytics/` | @yazeed11011 | Medium |
| Tipping | `src/tipping/` | @yazeed11011 | High — XLM transfers |
| Database migrations | `migrations/`, `src/migrations/` | @yazeed11011 | Critical — schema |
| Health endpoints | `src/health/` | @yazeed11011 | Low |
| Audit log | `src/audit-log/` | @yazeed11011 | Medium |
| Anomaly detection | `src/anomaly/` | @yazeed11011 | Medium |
| Search | `src/search-discovery/` | @yazeed11011 | Low |
| Feature flags | `src/feature-flags/` | @yazeed11011 | Low |
| Security headers / CSP | `src/security-headers/`, `src/middleware/security-headers*` | @yazeed11011 | Medium — CSP reports, nonces |

### 2. Frontend (`xconfess-frontend/`)

| Subsystem | Path | Owner | Data sensitivity |
|-----------|------|-------|-----------------|
| Auth flows | `app/(auth)/` | @yazeed11011 | High — session cookies |
| Proxy routes | `app/api/` | @yazeed11011 | Medium — backend proxy |
| Dashboard / admin UI | `app/(dashboard)/` | @yazeed11011 | Medium |
| Wallet / Stellar UI | `components/wallet/`, `hooks/useStellarWallet.ts` | @yazeed11011 | High — key material |
| Confession composer | `components/confession/`, `app/confessions/` | @yazeed11011 | High |
| Traction / metrics | `app/traction/` | @yazeed11011 | Low |
| PWA / service worker | `public/sw.js`, `public/manifest.webmanifest` | @yazeed11011 | Low |
| Security headers / CSP | `middleware.ts`, `next.config.*`, `app/api/csp-report/` | @yazeed11011 | Medium — report-only rollout |

### 3. Soroban Contracts (`xconfess-contracts/`)

| Contract | Path | Owner | Data sensitivity |
|----------|------|-------|-----------------|
| Confession anchor | `contracts/confession-anchor/` | @yazeed11011 | Critical — immutable on-chain |
| Anonymous tipping | `contracts/anonymous-tipping/` | @yazeed11011 | Critical — XLM |
| Reputation badges | `contracts/reputation-badges/` | @yazeed11011 | High |
| Governance | `contracts/governance/` | @yazeed11011 | High |
| Emergency pause | `contracts/emergency_pause/` | @yazeed11011 | Critical |
| Shared types / events | `contracts/events.rs`, `contracts/error.rs` | @yazeed11011 | High |
| Deployments manifest | `deployments/` | @yazeed11011 | High |

### 4. Repo-wide tooling

| Area | Path | Owner |
|------|------|-------|
| GitHub Actions (CI/CD/release) | `.github/workflows/` | @yazeed11011 |
| Secret scanning | `scripts/secret-scanning-preflight.sh` | @yazeed11011 |
| Deploy preflight | `scripts/deploy-preflight.js` | @yazeed11011 |
| Environment diagnostics | `scripts/diagnose.js` | @yazeed11011 |
| Database schema repair | `scripts/schema-repair.ts` | @yazeed11011 |
| Seed data | `scripts/seed.ts` | @yazeed11011 |
| Maintainer triage | `maintainer/` | @yazeed11011 |
| CSP inventory / report triage | `scripts/csp-inventory.*`, `docs/runbooks/csp-rollout.md` | @yazeed11011 |

---

## Escalation Paths

1. **Primary owner unavailable** — open a GitHub issue and tag `@yazeed11011`
   directly.  Include the affected subsystem and urgency level.
2. **Security incident** (secrets exposed, auth bypass, on-chain exploit) —
   contact `@yazeed11011` immediately via the contact details in the private
   security policy.  Do **not** post details publicly.
3. **Cross-cutting change** (touches ≥ 2 subsystems) — request review from
   `@yazeed11011` and add a PR comment listing the affected subsystems.
4. **Contract upgrade** — follow
   [docs/contract-release-and-upgrade-runbook.md](contract-release-and-upgrade-runbook.md).
   Requires maintainer sign-off before any testnet or mainnet deploy.
5. **CSP / security header policy change** — coordinate frontend proxy and
   backend header owners.  Report-only mode must soak clean before enforcement
   is enabled via configuration.  See
   [docs/runbooks/csp-rollout.md](runbooks/csp-rollout.md) for the rollout,
   triage, and rollback procedure.

---

## Stale Ownership Detection

The CODEOWNERS file should be reviewed at the start of each Stellar Wave.
Ownership is considered **stale** if:

- The listed owner has not merged a PR in the relevant subsystem for 60+ days.
- The subsystem has grown substantially and no secondary owner is named.

Run `npm run deploy:preflight` before requesting review. Its repository
governance audit compares tracked files in the security-sensitive source areas
with explicit CODEOWNERS patterns; the default catch-all owner does not count
as area-specific coverage. A new high-risk area must be added to the audit's
area list as well as assigned in CODEOWNERS. GitHub's CODEOWNERS validation
should also be clear of syntax errors, and every listed account or team must
have repository write access for automatic reviewer assignment to work.

To update ownership:
1. Open a PR that edits `.github/CODEOWNERS` and this document, and state which
   active source areas or owner responsibilities change.
2. Get sign-off from the current owner of each affected area and a repository
   maintainer. If an owner is unreachable, a maintainer records the reason and
   approves the transition.
3. Confirm the new user or team has repository write access, run the governance
   audit, and check GitHub's CODEOWNERS syntax feedback.
4. Announce the approved change in the PR description so contributors can
   re-subscribe.

The `npm run diagnose` output includes a `git log` summary per subsystem that
can help identify inactive areas.

---

## Security Header Policy Ownership

Security headers (CSP, HSTS, X-Frame-Options, Referrer-Policy, etc.) are
owned jointly by the frontend proxy (`app/api/`, `middleware.ts`) and the
backend API (`src/security-headers/`).  Policy changes must be reviewed by
both owners.  CSP ships in **report-only** mode first; enforcement is toggled
by configuration only after reports are collected without sensitive URLs and
violations have been triaged to zero unexplained entries.

---

## Service Boundaries and Data Flow

```
Browser / Mobile
      │
      ▼
xconfess-frontend (Next.js App Router)
  ├── App Router proxy routes (/api/*) ──────────────────────────────────────┐
  └── Static assets, PWA, service worker                                      │
                                                                               │
                                                                               ▼
                                                               xconfess-backend (NestJS)
                                                                 ├── Security headers / CSP reports
                                                                 ├── Auth / RBAC / session
                                                                 ├── Confession CRUD + encryption
                                                                 ├── Reactions / comments / messages
                                                                 ├── Moderation + admin
                                                                 ├── Notifications (Redis queues)
                                                                 ├── Data export (async jobs)
                                                                 ├── Stellar integration
                                                                 │       │
                                                                 │       ▼
                                                                 │   Stellar Horizon (testnet / mainnet)
                                                                 │       │
                                                                 │       ▼
                                                                 │   xconfess-contracts (Soroban)
                                                                 │     ├── confession-anchor
                                                                 │     ├── anonymous-tipping
                                                                 │     ├── reputation-badges
                                                                 │     └── governance / emergency-pause
                                                                 │
                                                                 ├── PostgreSQL 16 (primary datastore)
                                                                 └── Redis 7   (queues, cache, rate-limit)
```

See [docs/adr/005-monorepo-structure.md](adr/005-monorepo-structure.md) for the
architectural decision that established this layout.
