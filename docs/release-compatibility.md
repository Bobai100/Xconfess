# Release Compatibility Evidence

`npm run check:release-compatibility` writes `release-compatibility-report.json`
for the current Git candidate. The report records root, backend, and frontend
versions; `scripts/.api-snapshot.json` and its route count; contract ABI and WASM manifest versions,
contract sets, and SHA-256 digests; and the results of the existing API and ABI
drift checks. A missing or malformed input, manifest mismatch, or drift-check
failure blocks the command and prints the failed check name.

Attach the generated report to the release candidate. The report identifies
its source commit so evidence cannot be mistaken for another candidate. The
release pipeline runs this gate before artifact creation and promotion.