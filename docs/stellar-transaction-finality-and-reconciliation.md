# Transaction Finality, Fee-Bump Lineage, and Multi-Contract Recovery

This document describes how the backend models the lifecycle of user-visible Stellar transactions, how fee-bump replacements are reconciled into a single logical operation, and how multi-contract workflows recover from partial failures. It also covers the search-filter accessibility contract, the operational configuration introduced by these changes, and how to run the associated tests.

Audience: backend and frontend contributors, contract integrators, and operators.

---

## 1. Transaction finality state machine

A submitted transaction is **not** the same as a transaction that has been included and finalized on the expected network. The backend models each user-visible transaction with an explicit state so that only verified transitions are ever exposed to clients.

### States

| State | Meaning | How it is reached |
| --- | --- | --- |
| `accepted` | The transaction was accepted by the submission endpoint and a hash was returned. It may or may not be included yet. | Submission succeeds (Horizon `submitTransaction` returns a hash). |
| `included` | The transaction appears in a ledger on the expected network, but finality has not yet been confirmed. | Horizon reports the transaction in a ledger, or a ledger close is observed containing it. |
| `finalized` | The transaction is included and the confirmation depth / finality criteria for the expected network have been met. | Inclusion plus the configured confirmation threshold (see `STELLAR_FINALITY_CONFIRMATIONS`). |
| `failed` | The transaction is definitively not going to be included (rejected, expired, or failed on-chain). | Horizon returns a failure result, or the transaction is observed as failed. |
| `unknown` | The current state cannot be verified (RPC unavailable, conflicting observations, or the transaction is not yet visible). | Any observation that cannot be reconciled to one of the above. |

### Transition rules

- Transitions are **monotonic** with respect to finality: `accepted → included → finalized`. A transaction never moves backwards from `finalized`.
- `failed` is terminal. A transaction that has been observed as failed is not re-promoted to `included` or `finalized` even if a later RPC observation disagrees; conflicting observations are surfaced as `unknown` for operator review rather than silently overwriting a terminal state.
- `unknown` is a **non-terminal** state used when observations are delayed or conflicting. It is re-evaluated on the next reconciliation pass and may resolve to any of the other states.
- Only verified transitions are exposed to clients. A client never sees `finalized` unless the confirmation threshold has actually been observed.

### Delayed and conflicting RPC observations

- **Delayed observations**: if a transaction is not yet visible, it remains `accepted` (or `unknown` if the submission result itself was ambiguous) until a later pass observes inclusion. Delays do not cause a downgrade.
- **Conflicting observations**: if two RPC sources disagree (e.g., one reports inclusion, another reports failure), the transaction is marked `unknown` and the conflict is recorded for reconciliation. It is not resolved by "last write wins".

### Owning boundary and authorization

- The finality state is owned by the backend transaction service. Clients cannot set or override finality state; they may only read it.
- Reconciliation passes run under the backend service identity. Any endpoint that mutates transaction state requires the caller to be the internal reconciler or an authorized operator (see `RECONCILIATION_API_TOKEN`).

---

## 2. Fee-bump lineage model

A fee-bumped transaction is a **replacement** of an original transaction, not a new logical operation. The backend persists the lineage so that the user-facing ledger records exactly one logical operation per payment.

### Model

- Each logical operation has a stable `operationId`.
- Each submitted transaction (original and each replacement) is stored as a **transaction attempt** linked to the `operationId`.
- A replacement records `replacesHash` pointing at the hash it supersedes. The lineage forms a chain: `original → bump1 → bump2 → …`.
- The **canonical hash** of a logical operation is the hash of the most recent attempt that reached `included` or `finalized`. If no attempt is included, the canonical hash is the most recent submitted attempt.

### Reconciliation rules

- When a replacement hash is observed, it is matched to its lineage via `replacesHash`. It is **not** recorded as a separate payment.
- If both the original and a replacement are observed as included (a conflict that should not normally happen), the operation is marked `unknown` and flagged for operator review; the ledger does not double-count.
- The user-facing ledger exposes one record per `operationId`, with the canonical hash and the finality state of the canonical attempt.
- Attempts that were superseded and never included are retained for audit but hidden from the user-facing ledger.

### Authorization and failure semantics

- Only the transaction service may append attempts to a lineage. Attempts are append-only; lineage records are never deleted, only superseded.
- A replacement that references an unknown `replacesHash` is rejected at ingestion and logged; it is not silently attached to a new operation.

---

## 3. Multi-contract saga and compensation

Some workflows call more than one contract. If a later call fails, earlier calls may already have succeeded, leaving backend state inconsistent. These workflows are modeled as **sagas** with explicit compensation.

### Inventory of multi-contract flows

Each multi-contract flow must be registered with:

- The ordered list of external calls (contract invocations).
- The **compensating action** for each call (or an explicit `no-op` with justification).
- The **reconciliation** behavior for each partial state (what the backend does if it cannot compensate).

Contributors adding a new multi-contract flow must add it to this inventory and provide compensation for every step that has an external side effect.

### Execution and compensation

- Each step records its outcome before the next step begins, so that a crash between steps is recoverable.
- On failure of step *N*, the saga runs compensating actions for steps *N-1 … 1* in reverse order.
- Compensation is **best-effort and idempotent**: each compensating action can be retried safely.
- If a compensating action fails, the saga enters a `needs_reconciliation` state and is surfaced to operators. It is not silently abandoned.
- Interruption after **every** external call is a tested scenario (see tests below).

### Authorization and failure semantics

- Saga execution runs under the backend service identity. Compensating actions require the same authorization as the forward action.
- A saga that cannot reach a consistent state is marked `needs_reconciliation`; it is never reported to the user as fully succeeded.

---

## 4. Search filter accessibility

Filter state and result counts must be keyboard-operable and screen-reader announced, and valid filter state must be preserved in the URL so it is shareable.

- Filter controls are reachable and operable via keyboard.
- Filter changes and result counts are announced to assistive technology (live region).
- A **reset** control clears all filters and restores the default result set; reset behavior is covered by tests.
- Empty-result states are announced and offer a reset path.
- Valid filter state is encoded in the URL; invalid or stale parameters are dropped rather than breaking the page.

---

## 5. Operational configuration

The following environment variables are introduced or made relevant by these changes. All are optional unless noted; defaults are shown.

| Variable | Default | Purpose |
| --- | --- | --- |
| `STELLAR_FINALITY_CONFIRMATIONS` | `1` | Number of confirmations (ledger closes) required before a transaction is considered `finalized`. |
| `STELLAR_RECONCILIATION_INTERVAL_MS` | `15000` | Interval between reconciliation passes that re-evaluate `accepted`/`unknown` transactions. |
| `STELLAR_RECONCILIATION_MAX_ATTEMPTS` | `20` | Maximum reconciliation passes before an unresolved transaction is escalated to operators. |
| `RECONCILIATION_API_TOKEN` | *(unset)* | Bearer token required for operator endpoints that mutate transaction state. Must be set in any environment where those endpoints are enabled. |
| `SAGA_COMPENSATION_MAX_RETRIES` | `3` | Number of retries for each compensating action before a saga is marked `needs_reconciliation`. |

Rollout notes:

- Increasing `STELLAR_FINALITY_CONFIRMATIONS` delays when clients see `finalized` but does not change any other state.
- Reconciliation is safe to run concurrently; passes are idempotent.
- Operator endpoints are disabled when `RECONCILIATION_API_TOKEN` is unset.

---

## 6. Running the tests

Run the full validation for these changes:

```bash
# Backend: finality state machine, fee-bump lineage, saga compensation
npm run backend:test

# Contract integration: multi-contract flows and interruption after each external call
npm run contract:test:integration

# Frontend end-to-end: search filter accessibility, empty results, reset behavior
npm run frontend:test:e2e
```

### What the tests cover

- **Finality** (`backend:test`): expected transitions (`accepted → included → finalized`), rejection/failure paths, delayed observations, and conflicting RPC observations resolving to `unknown` without downgrading terminal states.
- **Fee-bump lineage** (`backend:test`): original + replacement reconcile to one logical operation; superseded attempts are hidden; conflicting inclusions are flagged, not double-counted; unknown `replacesHash` is rejected.
- **Saga recovery** (`backend:test`, `contract:test:integration`): interruption after every external call, compensation in reverse order, idempotent retries, and `needs_reconciliation` escalation when compensation fails.
- **Search filters** (`frontend:test:e2e`): keyboard operation, screen-reader announcements, empty-result handling, reset behavior, and shareable URL state.

---

## 7. Contributor checklist

When changing any of the behavior above:

1. Update the state machine, lineage, or saga inventory in this document.
2. Add or update tests for the expected path, the rejection/failure path, and the relevant regression risk.
3. Update the environment variable table if configuration changes.
4. Run the validation commands in section 6 before opening a pull request.