# Data-Flow Threat-Model Review Checklist

Complete this checklist for a change that adds or materially changes collection,
storage, access, retention, export, or disclosure of data. Keep the answers in
the pull request or a linked design note; never include real user data or
secrets.

## Data Classification

- [ ] Identify each data element and classify it as public, operational,
  personal, sensitive, credential, or on-chain.
- [ ] State why each element is necessary and whether it can be minimized,
  aggregated, or kept ephemeral.
- [ ] Identify the systems, replicas, caches, queues, logs, and third parties
  that can hold or receive it.

## Trust Boundaries and Access

- [ ] Draw or describe the data flow, including client, API, worker, database,
  provider, and contract boundaries that apply.
- [ ] Identify who may create, read, change, export, and delete the data.
- [ ] Enforce authorization at the owning backend boundary; do not rely on a
  client check or possession of an identifier.
- [ ] Record how service credentials and encryption keys are protected and
  rotated. Do not place secrets in source, logs, or examples.

## Abuse and Failure Cases

- [ ] Consider unauthorized access, enumeration, replay, injection, resource
  exhaustion, confused-deputy behavior, and abuse by an otherwise authorized
  user.
- [ ] Define rejection, timeout, retry, partial-failure, and recovery behavior.
- [ ] Check that a failed delete, export, or delivery is not reported as
  complete and cannot leak data through a secondary path.

## Retention, Deletion, and Observability

- [ ] State retention defaults and limits for primary data and every derived
  copy, including caches, search indexes, backups, and queued work.
- [ ] Define deletion propagation and any minimal audit evidence retained.
- [ ] Confirm logs, metrics, traces, and alerts exclude secrets and sensitive
  payloads while still supporting incident response.
- [ ] Identify user or operator notices and incident escalation needs.

## Review and Release

- [ ] Name the tests or review evidence that cover authorization, rejection,
  failure, deletion, and disclosure risks. If a case is not automatable, state
  the manual check.
- [ ] Identify migrations, configuration, rollout, rollback, and monitoring
  required before release.
- [ ] Request review from the owners of every affected data and trust boundary.
- [ ] Record unresolved risks and the person responsible for accepting them.

For the repository's security/privacy design context, see the
[contract threat model](contract-threat-model.md),
[WebSocket threat model](websocket-threat-model.md), and
[data-export privacy runbook](data-export-privacy-runbook.md).