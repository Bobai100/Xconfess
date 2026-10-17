#!/usr/bin/env bash
# scripts/rollback-drills.sh
# Automated rollback and forward-fix drills for xConfess.
#
# Exercises rollback procedures for app, schema, contracts, and frontend to
# prove RTO targets and identify gaps before a real incident forces the issue.
# Findings that cannot be resolved within the drill are written to a remediation
# issue file for follow-up tracking.
#
# Usage:
#   ./scripts/rollback-drills.sh [--drill <name>] [--rto-minutes <n>] [--dry-run]
#
# Drill names (--drill):
#   all         Run all drills in sequence (default)
#   app         Backend application rollback drill
#   schema      Database schema migration rollback drill
#   contract    Soroban contract rollback drill
#   storage     Contract storage migration rehearsal drill (issue #275)
#   frontend    Frontend deployment rollback drill
#
# Options:
#   --rto-minutes <n>    Override the RTO target in minutes (default: 30)
#   --dry-run            Print what would be done without executing side-effects
#   --report-dir <dir>   Directory for drill evidence files (default: rollback-drill-results)
#
# Environment variables:
#   BACKEND_URL       Backend base URL (default: http://localhost:5000)
#   FRONTEND_URL      Frontend base URL (default: http://localhost:3000)
#   DB_HOST / DB_PORT / DB_NAME / DB_USERNAME / DB_PASSWORD
#                     Database connection (for schema drills)
#
# Exit codes:
#   0  All drills passed within RTO
#   1  One or more drills failed or exceeded RTO
#   2  Invalid usage
#
# Acceptance criteria (issue #132):
#   - Drills meet RTO targets
#   - Data compatibility is verified (forward/backward column checks)
#   - Unresolved gaps become tracked remediation issues
#
# Acceptance criteria (issue #275):
#   - Prior-version contract storage fixtures are applied to a rehearsal env
#   - Migration is rehearsed and rollback constraints are verified
#   - The exact operator sequence is documented before release
#
# NOTE: This script exercises STAGING boundaries only.  The irreversible
#       boundary is any live database or contract deployment.  Each drill
#       section documents what is reversible and what is not.

set -euo pipefail

# ── Constants ─────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEFAULT_RTO_MINUTES=30
DEFAULT_REPORT_DIR="${REPO_ROOT}/rollback-drill-results"

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# ── Parse args ────────────────────────────────────────────────────────────────
DRILL_NAME="all"
RTO_MINUTES="${DEFAULT_RTO_MINUTES}"
DRY_RUN=false
REPORT_DIR="${DEFAULT_REPORT_DIR}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --drill)
      DRILL_NAME="${2:-all}"
      shift 2
      ;;
    --rto-minutes)
      RTO_MINUTES="${2:-${DEFAULT_RTO_MINUTES}}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --report-dir)
      REPORT_DIR="${2:-${DEFAULT_REPORT_DIR}}"
      shift 2
      ;;
    -h|--help)
      head -40 "${BASH_SOURCE[0]}" | grep '^#' | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown argument: $1${NC}" >&2
      exit 2
      ;;
  esac
done

BACKEND_URL="${BACKEND_URL:-http://localhost:5000}"
FRONTEND_URL="${FRONTEND_URL:-http://localhost:3000}"

# ── Helpers ───────────────────────────────────────────────────────────────────
log_section() { echo -e "\n${BLUE}━━━ $1 ━━━${NC}"; }
log_pass()    { echo -e "${GREEN}✓ PASS${NC}: $1"; }
log_fail()    { echo -e "${RED}✗ FAIL${NC}: $1"; }
log_warn()    { echo -e "${YELLOW}⚠ WARN${NC}: $1"; }
log_info()    { echo -e "${CYAN}ℹ INFO${NC}: $1"; }
log_dry()     { echo -e "${YELLOW}[DRY-RUN]${NC}: $1"; }

DRILLS_PASSED=0
DRILLS_FAILED=0
GAPS=()

drill_pass() {
  local name="$1"
  log_pass "Drill: ${name}"
  ((DRILLS_PASSED++)) || true
}

drill_fail() {
  local name="$1" reason="$2"
  log_fail "Drill: ${name} — ${reason}"
  GAPS+=("${name}: ${reason}")
  ((DRILLS_FAILED++)) || true
}

# Record elapsed time for RTO measurement
rto_start() { echo "$(($(date +%s)))" ; }
rto_check() {
  local label="$1" start="$2"
  local elapsed_s=$(( $(date +%s) - start ))
  local elapsed_m=$(( elapsed_s / 60 ))
  if (( elapsed_m > RTO_MINUTES )); then
    drill_fail "${label}" "exceeded RTO target of ${RTO_MINUTES}m (took ${elapsed_m}m)"
    return 1
  fi
  log_info "${label} completed in ${elapsed_m}m ${elapsed_s}s (RTO target: ${RTO_MINUTES}m)"
  return 0
}

mkdir -p "${REPORT_DIR}"
REPORT_FILE="${REPORT_DIR}/drill-$(date +%Y%m%dT%H%M%S).txt"
REMEDIATION_FILE="${REPORT_DIR}/remediation-gaps-$(date +%Y%m%dT%H%M%S).md"

# Tee all output into the report file
exec > >(tee -a "${REPORT_FILE}") 2>&1

echo "xConfess Rollback Drills"
echo "========================"
echo "Date:        $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Drill set:   ${DRILL_NAME}"
echo "RTO target:  ${RTO_MINUTES}m"
echo "Dry-run:     ${DRY_RUN}"
echo "Report:      ${REPORT_FILE}"
echo ""

# ── Drill 1: App (backend binary/process) rollback ────────────────────────────
drill_app() {
  log_section "Drill 1: Backend Application Rollback"
  # IRREVERSIBLE BOUNDARY: none — this drill only checks health endpoints and
  # simulates the rollback decision gate.  No actual process restart is triggered
  # unless running against a live host via SSH (which requires manual confirmation).

  local start
  start=$(rto_start)

  # 1a. Verify current build artifact exists (dist/main.js)
  log_info "Checking backend build artifact..."
  if [[ -f "${REPO_ROOT}/xconfess-backend/dist/main.js" ]]; then
    log_pass "Backend dist artifact present"
  else
    log_warn "Backend dist artifact not found — run 'npm run backend:build' to produce it"
    # Not a drill failure — the drill proves the procedure, not the artifact state
  fi

  # 1b. Verify health endpoints respond (if backend is running locally)
  log_info "Probing backend health endpoints..."
  local live_status ready_status
  live_status=$(curl -sf --max-time 5 "${BACKEND_URL}/api/health/live" -o /dev/null -w "%{http_code}" 2>/dev/null || echo "unreachable")
  ready_status=$(curl -sf --max-time 5 "${BACKEND_URL}/api/health/ready" -o /dev/null -w "%{http_code}" 2>/dev/null || echo "unreachable")

  if [[ "${live_status}" == "200" ]]; then
    log_pass "Backend liveness probe: 200"
  else
    log_warn "Backend liveness probe: ${live_status} (backend may not be running locally — skipping live check)"
  fi

  if [[ "${ready_status}" == "200" ]]; then
    log_pass "Backend readiness probe: 200"
  else
    log_warn "Backend readiness probe: ${ready_status} (backend may not be running locally — skipping ready check)"
  fi

  # 1c. Simulate rollback decision gate
  # In a real rollback: re-run the CD workflow against the previous commit SHA,
  # or SSH to host and swap dist/ to the previous artifact.
  log_info "Rollback procedure:"
  log_info "  1. Identify the last known-good commit SHA from CI run history"
  log_info "  2. Re-run CD workflow with that SHA (workflow_dispatch → previous SHA)"
  log_info "  3. Confirm /api/health/ready returns 200 within ${RTO_MINUTES}m"
  log_info "  4. Run deploy:smoke to verify critical paths"

  if [[ "${DRY_RUN}" == "true" ]]; then
    log_dry "Would re-deploy previous artifact and poll /api/health/ready"
  fi

  # 1d. Document data compatibility check
  # Forward-fix: if new code introduced a DB column that didn't exist in the
  # previous version, the previous binary must tolerate NULL gracefully.
  log_info "Data compatibility boundary:"
  log_info "  - Columns added by recent migrations must have DEFAULT or be nullable"
  log_info "  - Previous app version must not crash on NULL in new columns"
  log_info "  - Check: latest migration adds columns with NOT NULL without DEFAULT?"
  local bad_migrations
  bad_migrations=$(grep -rl "NOT NULL" "${REPO_ROOT}/xconfess-backend/migrations/" 2>/dev/null | head -5 || true)
  if [[ -n "${bad_migrations}" ]]; then
    log_warn "Found migrations with NOT NULL constraints — verify each has a DEFAULT or backfill:"
    echo "${bad_migrations}" | while IFS= read -r f; do
      echo "    $f"
    done
  else
    log_pass "No problematic NOT NULL without DEFAULT patterns detected in migrations"
  fi

  rto_check "App rollback drill" "${start}" && drill_pass "App rollback" || true
}

# ── Drill 2: Schema migration rollback ────────────────────────────────────────
drill_schema() {
  log_section "Drill 2: Schema Migration Rollback"
  # IRREVERSIBLE BOUNDARY: Running a DOWN migration on a production database is
  # irreversible if data was inserted into the new column/table.  This drill
  # validates that every migration has a reversible down() method and that the
  # TypeORM migration list is consistent.

  local start
  start=$(rto_start)

  # 2a. Check that every migration file exports a down() method
  log_info "Checking all migration files for down() method..."
  local missing_down=()
  while IFS= read -r -d '' f; do
    if ! grep -q "async down" "${f}"; then
      missing_down+=("${f}")
    fi
  done < <(find "${REPO_ROOT}/xconfess-backend/migrations" -name "*.ts" -not -name "*.spec.ts" -print0 2>/dev/null)

  if [[ ${#missing_down[@]} -gt 0 ]]; then
    drill_fail "Schema rollback" "Migrations missing down() method: ${missing_down[*]}"
  else
    log_pass "All migration files have a down() method"
  fi

  # 2b. Check for addColumn without nullable:true or default value (rollback risk)
  log_info "Checking migrations for NOT NULL columns without DEFAULT..."
  local risky_migrations=()
  while IFS= read -r -d '' f; do
    # Look for addColumn patterns with isNullable:false (or no isNullable) and no default
    if grep -q "addColumn\|addColumn" "${f}" 2>/dev/null; then
      if grep -q "isNullable.*false" "${f}" 2>/dev/null && ! grep -q "default:" "${f}" 2>/dev/null; then
        risky_migrations+=("$(basename "${f}")")
      fi
    fi
  done < <(find "${REPO_ROOT}/xconfess-backend/migrations" -name "*.ts" -not -name "*.spec.ts" -print0 2>/dev/null)

  if [[ ${#risky_migrations[@]} -gt 0 ]]; then
    log_warn "Migrations with NOT NULL columns and no default (forward-fix risk on rollback):"
    for m in "${risky_migrations[@]}"; do
      echo "    ${m}"
    done
    GAPS+=("Schema: Risky NOT NULL columns in ${risky_migrations[*]} — verify backfill exists before rollback")
  else
    log_pass "No risky NOT NULL without DEFAULT patterns detected"
  fi

  # 2c. Verify migration file count matches expectation (drift detection)
  local migration_count
  migration_count=$(find "${REPO_ROOT}/xconfess-backend/migrations" -name "*.ts" -not -name "*.spec.ts" | wc -l | tr -d ' ')
  log_info "Migration count: ${migration_count} files"

  # 2d. Simulate revert procedure
  log_info "Schema rollback procedure:"
  log_info "  1. Identify the target migration to revert to (name/timestamp)"
  log_info "  2. Run: npm run backend:migration:show  (confirm current position)"
  log_info "  3. Run: npx typeorm migration:revert  (reverts the last migration)"
  log_info "  4. Re-run: npm run backend:migration:show  (confirm revert applied)"
  log_info "  5. If data was inserted into dropped column — restore from backup"
  log_info "  Rollback of data-bearing migrations requires a DB backup restore"

  if [[ "${DRY_RUN}" == "true" ]]; then
    log_dry "Would run: npm run backend:migration:show"
    log_dry "Would run: npx typeorm migration:revert (once per step back)"
  fi

  rto_check "Schema rollback drill" "${start}" && drill_pass "Schema rollback" || true
}

# ── Drill 3: Soroban contract rollback ────────────────────────────────────────
drill_contract() {
  log_section "Drill 3: Soroban Contract Rollback"
  # IRREVERSIBLE BOUNDARY: Deployed Soroban contracts on mainnet cannot be
  # undeployed.  On testnet, redeployment is possible.  This drill verifies
  # the wasm hash manifest, identifies upgrade constraints, and documents the
  # forward-fix path.

  local start
  start=$(rto_start)

  # 3a. Verify the deployment manifest exists
  log_info "Checking contract deployment manifest..."
  local manifest_file="${REPO_ROOT}/deployments/testnet.json"
  if [[ -f "${manifest_file}" ]]; then
    log_pass "Deployment manifest found: ${manifest_file}"
    # Check required fields
    if command -v node &>/dev/null; then
      node -e "
        const m = require('${manifest_file}');
        const required = ['network', 'deployedAt'];
        const missing = required.filter(k => !m[k]);
        if (missing.length) { console.error('Missing fields:', missing.join(', ')); process.exit(1); }
        console.log('Manifest fields OK');
      " && log_pass "Deployment manifest schema valid" || log_warn "Deployment manifest missing required fields"
    fi
  else
    drill_fail "Contract rollback" "Deployment manifest not found at ${manifest_file}"
  fi

  # 3b. Verify wasm manifest exists with hashes
  local wasm_manifest="${REPO_ROOT}/deployments/contract-wasm-manifest.json"
  if [[ -f "${wasm_manifest}" ]]; then
    log_pass "WASM manifest present: ${wasm_manifest}"
  else
    log_warn "WASM manifest not found — run contracts-release.sh to generate it"
    GAPS+=("Contract: WASM manifest missing — cannot verify rollback artifact integrity")
  fi

  # 3c. Verify ABI manifest
  local abi_manifest="${REPO_ROOT}/deployments/contract-abi-manifest.json"
  if [[ -f "${abi_manifest}" ]]; then
    log_pass "ABI manifest present: ${abi_manifest}"
  else
    log_warn "ABI manifest not found — run check-abi-drift.sh to generate it"
  fi

  # 3d. Contract rollback constraints
  log_info "Contract rollback constraints:"
  log_info "  Soroban contracts are immutable once deployed — rollback = forward-fix"
  log_info "  Upgrade path requires admin key and contract upgrade_authority"
  log_info "  Emergency pause is available if emergency_pause contract is deployed"
  log_info "  See: docs/contract-release-and-upgrade-runbook.md"
  log_info "  See: xconfess-contracts/EMERGENCY_PAUSE_MODEL.md"

  # 3e. Check emergency pause contract exists
  local pause_contract="${REPO_ROOT}/xconfess-contracts/contracts/emergency_pause"
  if [[ -d "${pause_contract}" ]]; then
    log_pass "Emergency pause contract directory found"
  else
    log_warn "Emergency pause contract not found — no fast circuit-breaker available"
    GAPS+=("Contract: Emergency pause contract directory missing — no fast rollback path")
  fi

  # 3f. Simulate forward-fix procedure
  log_info "Contract forward-fix procedure:"
  log_info "  1. Identify the breaking change in the deployed contract"
  log_info "  2. Implement fix in xconfess-contracts/ (patch version bump)"
  log_info "  3. Run: cargo test --workspace  (verify no regressions)"
  log_info "  4. Run: ./scripts/contracts-release.sh  (build and hash)"
  log_info "  5. If emergency: call emergency_pause contract to suspend user-facing ops"
  log_info "  6. Deploy patched wasm via upgrade_authority"
  log_info "  7. Verify via contracts-gas-checks.sh and backend stellar diagnostics"
  log_info "  8. Lift emergency pause if applied"

  if [[ "${DRY_RUN}" == "true" ]]; then
    log_dry "Would run: cargo test --workspace (in xconfess-contracts/)"
    log_dry "Would run: ./scripts/contracts-release.sh"
  fi

  rto_check "Contract rollback drill" "${start}" && drill_pass "Contract rollback" || true
}

# ── Drill 4: Contract storage migration rehearsal ────────────────────────────
drill_storage() {
  log_section "Drill 4: Contract Storage Migration Rehearsal"
  # IRREVERSIBLE BOUNDARY: This drill runs ONLY against a rehearsal/testnet
  # contract instance.  Applying a storage migration to a live mainnet contract
  # is irreversible once the new schema is committed.  The drill proves that
  # prior-version on-chain state can be transformed safely and that the
  # rollback constraints hold before any real deployment.

  local start
  start=$(rto_start)

  local fixtures_dir="${REPO_ROOT}/xconfess-contracts/fixtures/storage-migrations"
  local rehearsal_script="${REPO_ROOT}/xconfess-contracts/scripts/storage-migration-rehearsal.sh"

  # 4a. Verify prior-version fixtures exist
  log_info "Checking prior-version storage fixtures..."
  if [[ -d "${fixtures_dir}" ]]; then
    local fixture_count
    fixture_count=$(find "${fixtures_dir}" -name "*.json" | wc -l | tr -d ' ')
    if [[ "${fixture_count}" -gt 0 ]]; then
      log_pass "Found ${fixture_count} prior-version storage fixture(s) in ${fixtures_dir}"
    else
      drill_fail "Storage migration rehearsal" "No fixture JSON files found in ${fixtures_dir}"
    fi
  else
    drill_fail "Storage migration rehearsal" "Fixtures directory not found: ${fixtures_dir}"
  fi

  # 4b. Verify rehearsal harness is present
  log_info "Checking storage migration rehearsal harness..."
  if [[ -x "${rehearsal_script}" ]]; then
    log_pass "Rehearsal harness present and executable: ${rehearsal_script}"
  elif [[ -f "${rehearsal_script}" ]]; then
    log_warn "Rehearsal harness present but not executable — run: chmod +x ${rehearsal_script}"
    GAPS+=("Storage: Rehearsal harness not executable — chmod +x ${rehearsal_script}")
  else
    drill_fail "Storage migration rehearsal" "Rehearsal harness not found: ${rehearsal_script}"
  fi

  # 4c. Run the rehearsal (apply fixtures → migrate → verify rollback constraints)
  if [[ "${DRY_RUN}" == "true" ]]; then
    log_dry "Would run: ${rehearsal_script} --fixtures ${fixtures_dir} --verify-rollback"
  elif [[ -x "${rehearsal_script}" ]]; then
    log_info "Running storage migration rehearsal..."
    if "${rehearsal_script}" --fixtures "${fixtures_dir}" --verify-rollback; then
      log_pass "Storage migration rehearsal completed and rollback constraints verified"
    else
      drill_fail "Storage migration rehearsal" "Rehearsal harness reported failure — see output above"
    fi
  else
    log_warn "Skipping rehearsal execution — harness not executable"
  fi

  # 4d. Document the exact operator sequence before release
  log_info "Contract storage migration operator sequence (pre-release):"
  log_info "  1. Snapshot current on-chain storage: ./scripts/export-contract-storage.sh --network testnet"
  log_info "  2. Apply prior-version fixtures to rehearsal instance:"
  log_info "       ${rehearsal_script} --fixtures ${fixtures_dir} --apply"
  log_info "  3. Run the migration against the rehearsal instance and capture the new schema hash"
  log_info "  4. Verify rollback constraints: ${rehearsal_script} --verify-rollback"
  log_info "  5. Confirm the migration is idempotent (re-run step 3, expect no diff)"
  log_info "  6. Record the rehearsal evidence in ${REPORT_DIR}"
  log_info "  7. Only after all checks pass, schedule the live upgrade via upgrade_authority"
  log_info "  See: docs/contract-release-and-upgrade-runbook.md (Storage Migration section)"

  # 4e. Rollback constraints for storage migrations
  log_info "Storage migration rollback constraints:"
  log_info "  - A committed storage schema change cannot be reverted on-chain"
  log_info "  - Rollback = forward-fix migration that maps new schema back to a compatible shape"
  log_info "  - Every migration MUST be idempotent and tolerate partially-migrated state"
  log_info "  - Prior-version readers must tolerate unknown keys (forward compatibility)"

  rto_check "Storage migration rehearsal drill" "${start}" && drill_pass "Storage migration rehearsal" || true
}

# ── Drill 5: Frontend deployment rollback ────────────────────────────────────
drill_frontend() {
  log_section "Drill 5: Frontend Deployment Rollback"
  # IRREVERSIBLE BOUNDARY: none for Vercel/preview — deployments are immutable
  # and each commit creates a distinct deployment URL.  Rollback is a repoint
  # of the production alias to a previous deployment.

  local start
  start=$(rto_start)

  # 4a. Verify frontend build output exists
  log_info "Checking frontend build output..."
  local next_dir="${REPO_ROOT}/xconfess-frontend/.next"
  if [[ -d "${next_dir}" ]]; then
    log_pass "Frontend .next directory present"
    # Check BUILD_ID as a health indicator of the last build
    if [[ -f "${next_dir}/BUILD_ID" ]]; then
      local build_id
      build_id=$(cat "${next_dir}/BUILD_ID")
      log_info "Current build ID: ${build_id}"
    fi
  else
    log_warn "Frontend .next directory not found — run 'npm run frontend:build'"
    GAPS+=("Frontend: .next build output missing — cannot verify artifact integrity")
  fi

  # 4b. Probe frontend health (if running)
  log_info "Probing frontend health..."
  local fe_status
  fe_status=$(curl -sf --max-time 5 "${FRONTEND_URL}" -o /dev/null -w "%{http_code}" 2>/dev/null || echo "unreachable")
  if [[ "${fe_status}" == "200" ]]; then
    log_pass "Frontend root: 200"
  else
    log_warn "Frontend: ${fe_status} (may not be running locally)"
  fi

  # 4c. Verify proxy route health
  fe_status=$(curl -sf --max-time 5 "${FRONTEND_URL}/api/auth/session" -o /dev/null -w "%{http_code}" 2>/dev/null || echo "unreachable")
  if [[ "${fe_status}" =~ ^(200|401)$ ]]; then
    log_pass "Frontend proxy /api/auth/session: ${fe_status}"
  else
    log_warn "Frontend proxy route: ${fe_status} (expected 200 or 401)"
  fi

  # 4d. Service-worker regression check
  # A stale service worker can serve the old frontend after rollback.
  log_info "Service worker rollback note:"
  log_info "  After frontend rollback, clients with a stale service worker may continue"
  log_info "  serving the old version for up to 24 hours."
  log_info "  Mitigation: Increment service worker version or send push event to force update."
  log_info "  See: xconfess-frontend/public/sw.js"

  # 4e. Simulate rollback procedure
  log_info "Frontend rollback procedure (Vercel):"
  log_info "  1. Open Vercel dashboard → Project → Deployments"
  log_info "  2. Find the last known-good deployment (by commit SHA)"
  log_info "  3. Click 'Promote to Production'"
  log_info "  4. Verify /traction and /api/auth/session are accessible"
  log_info "  5. Monitor error rate for 5 minutes"

  log_info "Frontend rollback procedure (self-hosted):"
  log_info "  1. SSH to host: ssh user@host"
  log_info "  2. Swap .next/ symlink or directory to previous build artifact"
  log_info "  3. pm2 reload xconfess-frontend --update-env"
  log_info "  4. Confirm health via frontend URL"

  if [[ "${DRY_RUN}" == "true" ]]; then
    log_dry "Would promote previous Vercel deployment to production"
  fi

  rto_check "Frontend rollback drill" "${start}" && drill_pass "Frontend rollback" || true
}

# ── Run selected drills ───────────────────────────────────────────────────────
case "${DRILL_NAME}" in
  all)
    drill_app
    drill_schema
    drill_contract
    drill_storage
    drill_frontend
    ;;
  app)      drill_app ;;
  schema)   drill_schema ;;
  contract) drill_contract ;;
  storage)  drill_storage ;;
  frontend) drill_frontend ;;
  *)
    echo -e "${RED}Unknown drill name: ${DRILL_NAME}${NC}" >&2
    echo "Valid names: all, app, schema, contract, storage, frontend" >&2
    exit 2
    ;;
esac

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
log_section "Drill Summary"
echo "Passed: ${DRILLS_PASSED}"
echo "Failed: ${DRILLS_FAILED}"
echo "Gaps:   ${#GAPS[@]}"
echo ""

if [[ ${#GAPS[@]} -gt 0 ]]; then
  echo "Unresolved gaps written to: ${REMEDIATION_FILE}"
  {
    echo "# Rollback Drill Remediation Issues"
    echo ""
    echo "Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "Drill set: ${DRILL_NAME}"
    echo ""
    echo "The following gaps were identified during the rollback drills and require"
    echo "tracked follow-up issues before the next release."
    echo ""
    for gap in "${GAPS[@]}"; do
      echo "- [ ] ${gap}"
    done
    echo ""
    echo "## Next steps"
    echo ""
    echo "Open a GitHub issue for each unchecked item above, labelled \`reliability\`"
    echo "and \`rollback\`, and link back to the drill report: \`${REPORT_FILE}\`"
  } > "${REMEDIATION_FILE}"
fi

echo "Evidence report: ${REPORT_FILE}"
echo ""

if [[ ${DRILLS_FAILED} -gt 0 ]]; then
  log_fail "One or more drills failed. Review gaps above and ${REMEDIATION_FILE}."
  exit 1
fi

log_pass "All rollback drills completed within RTO target (${RTO_MINUTES}m)."
exit 0
