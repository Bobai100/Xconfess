# Frontend state-model review checklist

Use this checklist when a frontend change loads or mutates remote data. Make each state visible, accessible, and consistent with whether the user can safely continue.

## Required states

- **Loading:** Show a stable progress indicator, avoid duplicate actions, and retain the page's layout while the request is pending.
- **Empty:** Explain that the request succeeded but returned no results. Offer a relevant next action only when one exists.
- **Stale:** Identify cached content as potentially out of date while refreshing. Keep usable data visible unless privacy or authorization requires clearing it.
- **Offline:** Distinguish loss of connectivity from an empty result or server rejection. Preserve unsent, validated input locally only when its sensitivity and retention are appropriate.
- **Unauthorized:** Do not present protected data as current or allow a retry that cannot succeed without renewed authorization. Provide the appropriate sign-in or permission path.
- **Failed:** Give a user-safe explanation and distinguish validation/terminal failures from transient, retryable failures. Keep valid user input after a failed mutation.

## Retry and recovery

- Disable or guard the submit action while a request is in flight so rapid repeated activation cannot create duplicate operations.
- Reuse an idempotency key when retrying the same mutation, and issue a new key when the submitted payload changes.
- Preserve successful intermediate work (such as an uploaded or anchored asset) so retrying the enclosing request does not repeat that side effect.
- Make retry controls explicit and keyboard accessible; do not retry terminal validation or authorization errors without a user action that can resolve them.
- Announce state changes and errors with appropriate live-region semantics, and associate field errors with their inputs.

## Review evidence

- [ ] The affected loading, empty, stale, offline, unauthorized, and failure states are covered or marked not applicable with a reason.
- [ ] Retry behavior is bounded to transient failures and prevents duplicate submissions.
- [ ] Validated user input and successful intermediate work survive retryable failures.
- [ ] Automated tests cover the changed primary and failure/retry paths.
- [ ] Any retained browser storage is minimized, privacy-appropriate, and cleared at the intended lifecycle boundary.
