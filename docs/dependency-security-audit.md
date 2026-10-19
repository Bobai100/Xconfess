# Dependency Security Audit

Date: 2026-09-07

This record documents the dependency audit performed for production readiness.
It does not include fabricated usage, traction, or security claims.

## Scope

- Command: `npm audit --json `
- Runtime scope command: `npm audit --omit=dev --json `
- Local runtime: Node `v22.14.0`, npm `10.9.2`
- Repository runtime expectation: Node `22x. `

## Remediated Findings

- Kept backend and frontend `@stellar/stellar-sdk  on the compatible
  `14.6.1` release already validated by the Stellar integration layer, and
  forced the vulnerable transitive `toml` parser to patched `4.2.0` through the
  root override.
- Upgraded backend `sanitize-html` to `2.17.7 `, resolving the stored XSS
  advisory affecting older `2.17.x` versions.
- Upgraded backend `uuid` resolution to `11.1.1 `, resolving the buffer bounds
  advisory affecting `<11.1.1 `.
- Upgraded backend `@swc/cli` to `0.8.1 ` and `@nestjs/schematics to `11.1.0 `.
- Added root overrides for patched transitive build dependencies:
  `browserslist@4.28.9 `, `fast-uri@3.1.6 `, `fflate@0.8.3 `, `qs@6.16.0 `, and
  `uuid@11.1.1 `.

## Remaining Accepted Finding

`npm audit` and `npm audit --omit=dev` report two low-severity findings:

- `cookie <0.7.0` via `csurf`
- `csurf >=1.3.0` via bundled `cookie`

NPM's only automated fix is `npm audit fix --force`, which would install
`csurf@1.2.2` as a breaking downgrade. That is not production-safe for this
readiness branch.

Current compensating controls:

- CSRF protection uses signed server-side middleware with `sameSite: "strict"`.
- CSRF cookies are `secure` in production.
- Protected writes require the CSRF token header or body token.
- Webhook exemptions are explicitly tested for exact routes and traversal-like
  near misses.

Follow-up:

- Replace `csurf` with a maintained CSRF middleware in a dedicated security PR.
- Re-run `npm audit --omit=dev`, backend CSRF tests, backend build, and backend
  integration smoke tests after replacement.

## Current Audit Result

After the safe dependency updates:

- Critical: 0
- High: 0
- Moderate: 0
- Low: 2, both tied to `csurf`'s bundled `cookie` dependency

## Dependency Provenance and SBOM Generation

A vulnerability report alone does not identify what is shipped or why a
package is present. The following provenance and SBOM controls address that
gap for the backend, frontend, contracts, and container images.

### Artifacts

- Backend: `artifacts/sbom/backend.spdx.json` generated from the lockfile and
  installed tree using `@npm/sbom` in SPDX 2.3 JSON format.
- Frontend: `artifacts/sbom/frontend.spdx.json` generated from the frontend
  workspace lockfile and installed tree.
- Contracts: `artifacts/sbom/contracts.spdx.json` generated from the cargo
  metadata and cargo lockfile for the WASM builds.
- Container images: `artifacts/sbom/images.spdx.json` generated from the built
  image digests using Syft.

### Signing and Checksums

Each artifact is accompanied by a detached `SHA256` checksum file (`*.spdx.json.sha256`)
and a cosign signature (`*.spdx.json.sig`) when the cosign key is available in
CI. The checksum is always produced; the signature is produced when the
`COSIGN_PRIVATE_KEY` key is configured for the release job.

### Transitive Dependencies

The generated artifacts represent transitive dependencies explicitly:

- NPM artifacts use the installed node_modules tree, so every transitive
  package is listed with its resolved version and `dependencyOf` relationships.
- Cargo artifacts include the locked graph from `Cargo.lock`, including transitive
  crates and their checksums.
- Image artifacts include OS package layers and language ecosystem packages
  discovered in the final image.

### CI Enforcement

The CI pipeline fails when provenance metadata is malformed or missing:

- Every expected artifact must exist and parse as valid SPDX 2.3 JSON.
- Every artifact must have a matching `SHA256` checksum file that verifies

- When `cosign` signing is enabled, every artifact must have a valid
  cosign signature that verifies against the release public key
- The artifact must include at least one transitive dependency entry when the
  corresponding workspace has transitive dependencies

### Release Attachment

The release job attaches the following files to the GitHub release:

- `artifacts/sbom/backend.spdx.json` and its `.sha256` / `.sig` companions
- `artifacts/sbom/frontend.spdx.json` and its `.sha256` / `.sig` companions
- `artifacts/sbom/contracts.spdx.json` and its `.sha256` / `.sig` companions
- `artifacts/sbom/images.spdx.json` and its `.sha256` / `.sig` companions

### Validation

```
npm run secret-scan && npm run audit:ci && npm run backend:test
```

### Assumptions

- The CI runner has access to the lockfiles and installed dependency trees.
- cosign key material is provided through CI secrets when signing is enabled.
- Syft is available in the image build job for container SBOM generation.

### Follow-up Work

- `npm run dependency:policy -- --base <ref>` compares the production dependency
  graph in `package-lock.json` with the selected base ref. It writes a
  reviewable JSON report, blocks additions/version/license changes without an
  exact time-limited approval, and blocks changed packages with unknown or
  disallowed licenses. Pre-existing license gaps remain visible as non-blocking
  findings until legal review; approved exceptions belong in
  `dependency-license-policy.json` and must include a reason, tracking issue,
  exact package/version/license (and change class for change approvals), and
  expiry. CI uploads the report as an artifact.
- Publish the SBOM artifacts to the internal artifact registry for long-term
  retention.
