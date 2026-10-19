# Test Reliability

## Browser coverage

The critical public-page navigation suite runs in Chromium, Firefox, and WebKit. Browser binaries are selected by the locked `@playwright/test` version, so update the dependency lockfile when changing the supported browser revisions. CI retains the Playwright JSON and HTML reports; a test that passes on retry is reported as flaky with its attempt details rather than being indistinguishable from a clean pass.

## Time semantics

Persist timestamps that represent moments as UTC instants (RFC 3339 timestamps with an offset, or database timestamps normalized to UTC). Render those instants in the viewer's timezone. Values that represent a calendar date, such as a date filter, are not instants: preserve them as `YYYY-MM-DD` and do not convert them through a local midnight. Tests around daylight-saving transitions must assert elapsed-time behavior using instants and calendar display using the selected timezone.

## Flaky-test triage

Do not permanently skip a flaky test without registering it in `.github/test-quarantine.json`. Each entry names the test, an owner, an expiry date, a tracking issue, a concise reason, and whether the suspected cause is a product or infrastructure failure. The CI validator rejects missing metadata, unregistered static skips, expired entries, and entries that no longer match a skipped test. Prefer repairing the cause and removing the registry entry; quarantine is temporary, not a replacement for a test.

Use the retained Playwright report to compare attempts. A repeatable failure in application behavior is classified as `product`; failures attributable to runner availability, browser installation, or external test infrastructure are classified as `infrastructure`. Leave ambiguous failures unquarantined until the cause is understood.

## Mutation contention

Concurrency coverage uses PostgreSQL rather than repository mocks. The reaction contention case sends synchronized duplicate mutations and asserts that all callers receive one canonical record, the unique invariant remains intact, and only one creation event is broadcast. Run it with `npm run test:e2e -- --runInBand --runTestsByPath test/reaction-contention.e2e-spec.ts` from `xconfess-backend` against an isolated test database.