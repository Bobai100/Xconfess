#!/usr/bin/env bash
# Preflight checks for the xConfess contract build/deploy pipeline.
# Exits nonzero with an actionable message for each missing prerequisite.
# Does NOT require a private key — safe to run before any key is configured.
#
# Usage:
#   ./scripts/contracts-preflight.sh          # build-only checks
#   ./scripts/contracts-preflight.sh --deploy # also check deploy prerequisites

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTRACTS_DIR="$REPO_ROOT/xconfess-contracts"
TARGET_TRIPLE="${XCONFESS_TARGET_TRIPLE:-wasm32v1-none}"

DEPLOY_MODE=0
if [[ "${1:-}" == "--deploy" ]]; then
  DEPLOY_MODE=1
fi

PASS=0
FAIL=1
errors=0

ok() {
  printf "  [OK] %s\n" "$1"
}

fail() {
  printf "  [FAIL] %s\n" "$1" >&2
  errors=$((errors + 1))
}

header() {
  printf "\n==> %s\n" "$1"
}

resolve_cmd() {
  local cmd="$1"
  if command -v "$cmd" >/dev/null 2>&1; then
    command -v "$cmd"
    return 0
  fi
  if command -v "$cmd.exe" >/dev/null 2>&1; then
    command -v "$cmd.exe"
    return 0
  fi
  return 1
}

# ---------------------------------------------------------------------------
# 1. Rust / Cargo
# ---------------------------------------------------------------------------
header "Rust toolchain"

rustc_bin="$(resolve_cmd rustc || true)"
cargo_bin="$(resolve_cmd cargo || true)"
rustup_bin="$(resolve_cmd rustup || true)"
stellar_bin="$(resolve_cmd stellar || true)"

if [[ -n "$rustc_bin" ]]; then
  rust_version="$("$rustc_bin" --version 2>&1 | awk '{print $2}')"
  required_major=1
  required_minor=81
  actual_major="$(echo "$rust_version" | cut -d. -f1)"
  actual_minor="$(echo "$rust_version" | cut -d. -f2)"
  if [[ "$actual_major" -gt "$required_major" ]] || \
     { [[ "$actual_major" -eq "$required_major" ]] && [[ "$actual_minor" -ge "$required_minor" ]]; }; then
    ok "rustc $rust_version (>= 1.81.0)"
  else
    fail "rustc $rust_version is too old — need >= 1.81.0. Run: rustup update stable"
  fi
else
  fail "rustc not found. Install via: curl https://sh.rustup.rs -sSf | sh"
fi

if [[ -n "$cargo_bin" ]]; then
  ok "cargo $("$cargo_bin" --version 2>&1 | awk '{print $2}')"
else
  fail "cargo not found (should be installed alongside rustc)"
fi

if [[ -n "$rustup_bin" ]]; then
  ok "rustup $("$rustup_bin" --version 2>&1 | head -1 | awk '{print $2}')"
else
  fail "rustup not found. Install via: curl https://sh.rustup.rs -sSf | sh"
fi

# ---------------------------------------------------------------------------
# 2. WASM target
# ---------------------------------------------------------------------------
header "WASM target"

if [[ -n "$rustup_bin" ]]; then
  if "$rustup_bin" target list --installed 2>/dev/null | grep -q "$TARGET_TRIPLE"; then
    ok "$TARGET_TRIPLE target is installed"
  else
    fail "$TARGET_TRIPLE target is missing. Fix: rustup target add $TARGET_TRIPLE"
  fi
fi

# ---------------------------------------------------------------------------
# 3. Workspace files
# ---------------------------------------------------------------------------
header "Workspace layout"

if [[ -d "$CONTRACTS_DIR" ]]; then
  ok "xconfess-contracts directory exists"
else
  fail "xconfess-contracts directory not found at: $CONTRACTS_DIR"
fi

if [[ -f "$CONTRACTS_DIR/Cargo.toml" ]]; then
  ok "xconfess-contracts/Cargo.toml present"
else
  fail "xconfess-contracts/Cargo.toml missing — workspace may be incomplete"
fi

if [[ -f "$CONTRACTS_DIR/Cargo.lock" ]]; then
  ok "xconfess-contracts/Cargo.lock present (reproducible builds enabled)"
else
  fail "xconfess-contracts/Cargo.lock missing — run: cargo generate-lockfile inside xconfess-contracts"
fi

expected_crates=(
  "confession-anchor"
  "confession-registry"
  "anonymous-tipping"
  "reputation-badges"
)

for crate in "${expected_crates[@]}"; do
  crate_dir="$CONTRACTS_DIR/contracts/$crate"
  if [[ -d "$crate_dir" ]]; then
    ok "contracts/$crate exists"
  else
    fail "contracts/$crate directory missing — workspace may be corrupted or partially cloned"
  fi
done

# ---------------------------------------------------------------------------
# 3b. Storage migration rehearsal fixtures (#275)
# ---------------------------------------------------------------------------
header "Storage migration rehearsal fixtures"

FIXTURES_DIR="$CONTRACTS_DIR/tests/fixtures/storage"
if [[ -d "$FIXTURES_DIR" ]]; then
  ok "storage fixtures directory exists"
  fixture_count=0
  for fixture in "$FIXTURES_DIR"/*.json; do
    [[ -e "$fixture" ]] || continue
    fixture_count=$((fixture_count + 1))
  done
  if [[ "$fixture_count" -gt 0 ]]; then
    ok "$fixture_count prior-version storage fixture(s) present"
  else
    fail "no prior-version storage fixtures found in $FIXTURES_DIR — migration rehearsal cannot run"
  fi
else
  fail "storage fixtures directory missing at: $FIXTURES_DIR — add representative prior-version state fixtures"
fi

REHEARSAL_SCRIPT="$REPO_ROOT/scripts/contracts-migration-rehearsal.sh"
if [[ -f "$REHEARSAL_SCRIPT" ]]; then
  ok "migration rehearsal script present"
else
  fail "migration rehearsal script missing at: $REHEARSAL_SCRIPT"
fi

# ---------------------------------------------------------------------------
# 3c. Storage compatibility report prerequisites (#280)
# ---------------------------------------------------------------------------
header "Storage compatibility report"

REPORT_SCRIPT="$REPO_ROOT/scripts/contracts-compat-report.sh"
if [[ -f "$REPORT_SCRIPT" ]]; then
  ok "compatibility report generator present"
else
  fail "compatibility report generator missing at: $REPORT_SCRIPT"
fi

MANIFEST_DIR="$CONTRACTS_DIR/deployments"
if [[ -d "$MANIFEST_DIR" ]]; then
  ok "deployment manifest directory exists"
else
  fail "deployment manifest directory missing at: $MANIFEST_DIR — report cannot diff manifests"
fi

# Authorization env vars are only required when actually running the report or
# rehearsal against a live network; build-only checks just warn.
required_auth_vars=(
  "XCONFESS_RELEASE_APPROVER"
  "XCONFESS_STORAGE_VERSION"
)

for var in "${required_auth_vars[@]}"; do
  if [[ -n "${!var:-}" ]]; then
    ok "$var is set"
  else
    if [[ "$DEPLOY_MODE" -eq 1 ]]; then
      fail "$var is not set — required to authorize migration/report before deploy"
    else
      printf "  [SKIP] %s not set — required only for deploy/report runs\n" "$var"
    fi
  fi
done

# ---------------------------------------------------------------------------
# 4. Stellar CLI (build checks are complete without it; deploy needs it)
# ---------------------------------------------------------------------------
header "Stellar CLI"

if [[ -n "$stellar_bin" ]]; then
  stellar_raw="$("$stellar_bin" --version 2>&1)"
  stellar_version="$(echo "$stellar_raw" | grep -o '[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*' | head -1)"
  req_major=22
  actual_stellar_major="$(echo "$stellar_version" | cut -d. -f1)"
  if [[ "$actual_stellar_major" -ge "$req_major" ]]; then
    ok "stellar $stellar_version (>= 22.0.0)"
  else
    fail "stellar $stellar_version is too old — need >= 22.0.0. Upgrade: cargo install --locked stellar-cli --features opt"
  fi
else
  if [[ "$DEPLOY_MODE" -eq 1 ]]; then
    fail "stellar CLI not found (required for --deploy). Install: cargo install --locked stellar-cli --features opt"
  else
    printf "  [SKIP] stellar CLI not found — not required for build-only checks\n"
    printf "         To check deploy prerequisites, re-run: %s --deploy\n" "$(basename "$0")"
  fi
fi

# ---------------------------------------------------------------------------
# 5. Deploy-only checks (key presence, network, funded account)
# ---------------------------------------------------------------------------
if [[ "$DEPLOY_MODE" -eq 1 ]]; then
  header "Deploy prerequisites"

  if [[ -z "$stellar_bin" ]]; then
    printf "  [SKIP] remaining deploy checks require stellar CLI\n"
  else
    stellar_keys="$("$stellar_bin" keys ls 2>/dev/null || true)"
    if [[ -n "$stellar_keys" ]]; then
      ok "at least one Stellar key is configured"
      printf "         Keys: %s\n" "$(echo "$stellar_keys" | tr '\n' ' ')"
    else
      fail "no Stellar keys found. Generate one: stellar keys generate --name deployer"
    fi

    stellar_networks="$("$stellar_bin" network ls 2>/dev/null || true)"
    if echo "$stellar_networks" | grep -q "testnet"; then
      ok "testnet network is configured"
    else
      fail "testnet network not configured. Add it: stellar network add-remote testnet https://horizon-testnet.stellar.org"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
printf "\n"
if [[ "$errors" -eq 0 ]]; then
  printf "Preflight passed — all checks OK.\n"
  exit 0
else
  printf "Preflight FAILED — %d issue(s) found. Fix the items marked [FAIL] above.\n" "$errors" >&2
  exit 1
fi
