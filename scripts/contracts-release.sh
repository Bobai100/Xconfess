#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${XCONFESS_REPO_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
CONTRACTS_DIR="${XCONFESS_CONTRACTS_DIR:-$REPO_ROOT/xconfess-contracts}"
TARGET_TRIPLE="${XCONFESS_TARGET_TRIPLE:-wasm32v1-none}"
TARGET_DIR="${XCONFESS_TARGET_DIR:-$CONTRACTS_DIR/target/$TARGET_TRIPLE/release}"
if [[ -z "${PYTHON_BIN:-}" ]]; then
  if command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="python3"
  else
    PYTHON_BIN="python"
  fi
fi

CONTRACT_CRATES=(
  "confession-anchor"
  "confession-registry"
  "anonymous-tipping"
  "reputation-badges"
)

# Migration rehearsal fixtures represent the last released on-chain storage
# layout. They must be refreshed whenever a storage schema change ships.
MIGRATION_FIXTURES_DIR="${XCONFESS_MIGRATION_FIXTURES_DIR:-$CONTRACTS_DIR/tests/fixtures/storage-migrations}"
MIGRATION_TEST_TARGET="${XCONFESS_MIGRATION_TEST_TARGET:-storage_migration_rehearsal}"
ROLLBACK_TEST_TARGET="${XCONFESS_ROLLBACK_TEST_TARGET:-storage_rollback_constraints}"
COMPAT_REPORT_FILE="${XCONFESS_COMPAT_REPORT_FILE:-$REPO_ROOT/deployments/contract-compatibility-report.json}"
# Explicit operator authorization is required to rehearse or release against a
# storage layout that has not been signed off by the migration owner.
RELEASE_AUTHORIZATION_ENV="${XCONFESS_RELEASE_AUTHORIZATION:-}"
REQUIRED_AUTHORIZATION_TOKEN="${XCONFESS_REQUIRED_AUTHORIZATION_TOKEN:-storage-migration-approved}"
=======

timestamp_utc() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

require_cmd() {
  local cmd="$1"
  local exe="${2:-$cmd}"
  if ! command -v "$exe" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
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

stellar_arg_path() {
  local path="$1"
  local stellar_bin="$2"
  if [[ "$stellar_bin" == *.exe ]] && command -v wslpath >/dev/null 2>&1; then
    wslpath -w "$path"
    return 0
  fi
  echo "$path"
}

crate_to_wasm_name() {
  local crate="$1"
  echo "${crate//-/_}.wasm"
}

require_release_authorization() {
  local action="$1"
  if [[ -z "$RELEASE_AUTHORIZATION_ENV" ]]; then
    echo "Authorization required for '$action': set XCONFESS_RELEASE_AUTHORIZATION to the migration sign-off token." >&2
    echo "Expected token: $REQUIRED_AUTHORIZATION_TOKEN" >&2
    exit 1
  fi
  if [[ "$RELEASE_AUTHORIZATION_ENV" != "$REQUIRED_AUTHORIZATION_TOKEN" ]]; then
    echo "Authorization rejected for '$action': XCONFESS_RELEASE_AUTHORIZATION does not match the required sign-off token." >&2
    exit 1
  fi
}

require_migration_fixtures() {
  if [[ ! -d "$MIGRATION_FIXTURES_DIR" ]]; then
    echo "Missing migration fixtures directory: $MIGRATION_FIXTURES_DIR" >&2
    echo "Prior-version storage fixtures are required to rehearse upgrades." >&2
    exit 1
  fi
  local fixture_count
  fixture_count="$(find "$MIGRATION_FIXTURES_DIR" -type f -name '*.json' | wc -l | tr -d '[:space:]')"
  if [[ "$fixture_count" -eq 0 ]]; then
    echo "No prior-version storage fixtures (*.json) found in $MIGRATION_FIXTURES_DIR" >&2
    exit 1
  fi
}

rehearse_migration() {
  local cargo_bin
  cargo_bin="$(resolve_cmd cargo)" || {
    echo "Missing required command: cargo" >&2
    exit 1
  }
  require_release_authorization "migration rehearsal"
  require_migration_fixtures

  echo "Rehearsing storage migration against prior-version fixtures in $MIGRATION_FIXTURES_DIR..."
  pushd "$CONTRACTS_DIR" >/dev/null
  if ! "$cargo_bin" test --locked --workspace --test "$MIGRATION_TEST_TARGET" -- --nocapture; then
    popd >/dev/null
    echo "Migration rehearsal failed: prior-version storage could not be transformed safely." >&2
    exit 1
  fi
  echo "Rehearsing rollback constraints..."
  if ! "$cargo_bin" test --locked --workspace --test "$ROLLBACK_TEST_TARGET" -- --nocapture; then
    popd >/dev/null
    echo "Rollback constraint check failed: migration is not reversible under the documented constraints." >&2
    exit 1
  fi
  popd >/dev/null
  echo "Migration rehearsal and rollback constraints passed."
}

generate_compatibility_report() {
  local report_script="$REPO_ROOT/scripts/contract-storage-compat-report.mjs"
  if [[ ! -f "$report_script" ]]; then
    echo "Missing compatibility report generator: $report_script" >&2
    exit 1
  fi
  local node_bin
  node_bin="$(resolve_cmd node)" || {
    echo "Missing required command: node" >&2
    exit 1
  }
  [[ -d "$REPO_ROOT/deployments" ]] || mkdir -p "$REPO_ROOT/deployments"
  echo "Generating pre-release storage compatibility report..."
  if ! "$node_bin" "$report_script" --output "$COMPAT_REPORT_FILE"; then
    echo "Compatibility report generation failed." >&2
    exit 1
  fi
  echo "Compatibility report written to: $COMPAT_REPORT_FILE"
}

check_compatibility_report() {
  if [[ ! -f "$COMPAT_REPORT_FILE" ]]; then
    echo "Missing compatibility report: $COMPAT_REPORT_FILE" >&2
    echo "Run the compatibility report step before releasing." >&2
    exit 1
  fi
  local blocking
  blocking="$("$PYTHON_BIN" - "$COMPAT_REPORT_FILE" <<'PY'
import json
import sys

path = sys.argv[1]
try:
    with open(path, encoding="utf-8") as handle:
        report = json.load(handle)
except (OSError, ValueError) as exc:
    print(f"unreadable:{exc}")
    sys.exit(0)

blocking = report.get("blocking_conditions") or []
if not isinstance(blocking, list):
    print("malformed:blocking_conditions")
    sys.exit(0)
if blocking:
    for item in blocking:
        code = item.get("code", "unknown") if isinstance(item, dict) else str(item)
        message = item.get("message", "") if isinstance(item, dict) else ""
        print(f"{code}: {message}".strip())
PY
)"
  if [[ -n "$blocking" ]]; then
    echo "Release blocked by storage compatibility report conditions:" >&2
    while IFS= read -r line; do
      [[ -n "$line" ]] && echo "  - $line" >&2
    done <<< "$blocking"
    exit 1
  fi
  echo "Compatibility report contains no blocking conditions."
}

preflight_release() {
  local action="$1"
  require_release_authorization "$action"
  rehearse_migration
  generate_compatibility_report
  check_compatibility_report
}

verify_wasm_outputs() {
  local missing=0
  for crate in "${CONTRACT_CRATES[@]}"; do
    local wasm_file
    wasm_file="$(crate_to_wasm_name "$crate")"
    if [[ ! -f "$TARGET_DIR/$wasm_file" ]]; then
      echo "Missing artifact: $TARGET_DIR/$wasm_file" >&2
      missing=1
    fi
  done

  if [[ "$missing" -ne 0 ]]; then
    exit 1
  fi
}

write_manifest() {
  local output_file="$1"
  local generated_at
  generated_at="$(timestamp_utc)"

  require_cmd sha256sum

  {
    printf '{\n'
    printf '  "contracts": {\n'

    local idx=0
    local count=${#CONTRACT_CRATES[@]}
    for crate in "${CONTRACT_CRATES[@]}"; do
      local wasm_name
      wasm_name="$(crate_to_wasm_name "$crate")"
      local wasm_path="$TARGET_DIR/$wasm_name"
      local cargo_toml="$CONTRACTS_DIR/contracts/$crate/Cargo.toml"
      local version
      version="$(sed -n 's/^version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$cargo_toml" | head -n 1)"
      if [[ -z "$version" ]]; then
        echo "No version found in $cargo_toml" >&2
        exit 1
      fi

      local sha256
      sha256="$(sha256sum "$wasm_path" | awk '{print $1}')"
      local bytes
      bytes="$(wc -c < "$wasm_path" | tr -d '[:space:]')"
      local wasm_file="target/$TARGET_TRIPLE/release/$wasm_name"

      printf '    "%s": {\n' "$crate"
      printf '      "bytes": %s,\n' "$bytes"
      printf '      "sha256": "%s",\n' "$sha256"
      printf '      "version": "%s",\n' "$version"
      printf '      "wasm_file": "%s"\n' "$wasm_file"
      if [[ $idx -lt $((count - 1)) ]]; then
        printf '    },\n'
      else
        printf '    }\n'
      fi
      idx=$((idx + 1))
    done

    printf '  },\n'
    printf '  "generated_at_utc": "%s",\n' "$generated_at"
    printf '  "profile": "release",\n'
    printf '  "target": "%s"\n' "$TARGET_TRIPLE"
    printf '}\n'
  } > "$output_file"
}

build_all() {
  preflight_release "release build"
  local cargo_bin
  local rustup_bin
  cargo_bin="$(resolve_cmd cargo)" || {
    echo "Missing required command: cargo" >&2
    exit 1
  }
  rustup_bin="$(resolve_cmd rustup)" || {
    echo "Missing required command: rustup" >&2
    exit 1
  }
  pushd "$CONTRACTS_DIR" >/dev/null
  "$rustup_bin" target add "$TARGET_TRIPLE" >/dev/null
  "$cargo_bin" build --locked --workspace --release --target "$TARGET_TRIPLE"
  popd >/dev/null
  verify_wasm_outputs

  [[ -d "$REPO_ROOT/deployments" ]] || mkdir -p "$REPO_ROOT/deployments"
  local manifest_file="$REPO_ROOT/deployments/contract-wasm-manifest.json"
  write_manifest "$manifest_file"
  echo "Build complete. Manifest: $manifest_file"
}

verify_only() {
  preflight_release "release verification"
  verify_wasm_outputs
  [[ -d "$REPO_ROOT/deployments" ]] || mkdir -p "$REPO_ROOT/deployments"
  local manifest_file="$REPO_ROOT/deployments/contract-wasm-manifest.json"
  write_manifest "$manifest_file"
  echo "Verification complete. Manifest: $manifest_file"
}

deploy_all() {
  local network="$1"
  local source_key="$2"
  local dry_run="$3"
  local force="$4"

  local stellar_bin
  stellar_bin="$(resolve_cmd stellar)" || {
    echo "Missing required command: stellar" >&2
    exit 1
  }
  preflight_release "deployment to $network"
  verify_only

  local output_file="$REPO_ROOT/deployments/${network}.json"
  if [[ "$dry_run" != "true" && ! -f "$output_file" && "$force" != "true" ]]; then
    echo "Rollback guard: no previous deployment metadata found for network '$network'." >&2
    echo "If this is an intentional first-time deployment, re-run with --force to proceed." >&2
    exit 1
  fi

  if [[ "$dry_run" == "true" ]]; then
    if [[ ! -f "$output_file" ]]; then
      echo "Dry-run mode enabled. Build artifacts are verified, but no prior deployment metadata was found for network '$network'."
      echo "If this is the first deployment, the actual run requires --force to bypass rollback safety."
    else
      echo "Dry-run mode enabled. Build artifacts are verified and deployment metadata path is: $output_file"
    fi
    echo "No contracts were deployed. To execute the deployment, rerun without --dry-run."
    return 0
  fi

  local generated_at
  generated_at="$(timestamp_utc)"
  local ids_file
  ids_file="$(mktemp)"

  for crate in "${CONTRACT_CRATES[@]}"; do
    local wasm_file
    wasm_file="$(crate_to_wasm_name "$crate")"
    local wasm_path="$TARGET_DIR/$wasm_file"
    local stellar_wasm_path
    stellar_wasm_path="$(stellar_arg_path "$wasm_path" "$stellar_bin")"
    echo "Deploying $crate ($wasm_file) to $network..."
    local contract_id
    contract_id="$("$stellar_bin" contract deploy --wasm "$stellar_wasm_path" --network "$network" --source "$source_key")"
    echo "$crate=$contract_id" >> "$ids_file"
  done

  local output_file="$REPO_ROOT/deployments/${network}.json"
  "$PYTHON_BIN" - "$CONTRACTS_DIR" "$TARGET_DIR" "$output_file" "$generated_at" "$network" "$source_key" "$ids_file" "${CONTRACT_CRATES[@]}" <<'PY'
import hashlib
import json
import pathlib
import re
import sys

contracts_dir = pathlib.Path(sys.argv[1])
target_dir = pathlib.Path(sys.argv[2])
output_file = pathlib.Path(sys.argv[3])
generated_at = sys.argv[4]
network = sys.argv[5]
source_key = sys.argv[6]
ids_file = pathlib.Path(sys.argv[7])
crates = sys.argv[8:]

ids = {}
for line in ids_file.read_text(encoding="utf-8").splitlines():
    crate, contract_id = line.split("=", 1)
    ids[crate] = contract_id.strip()

def crate_version(crate: str) -> str:
    cargo_toml = contracts_dir / "contracts" / crate / "Cargo.toml"
    text = cargo_toml.read_text(encoding="utf-8")
    match = re.search(r'(?m)^version\s*=\s*"([^"]+)"\s*$', text)
    if not match:
        raise RuntimeError(f"No version found in {cargo_toml}")
    return match.group(1)

contracts = {}
for crate in crates:
    wasm_name = crate.replace("-", "_") + ".wasm"
    wasm_path = target_dir / wasm_name
    content = wasm_path.read_bytes()
    contracts[crate] = {
        "contract_id": ids[crate],
        "source": source_key,
        "version": crate_version(crate),
        "wasm_file": str(wasm_path.relative_to(contracts_dir)),
        "sha256": hashlib.sha256(content).hexdigest(),
    }

payload = {
    "generated_at_utc": generated_at,
    "network": network,
    "target": target_dir.parent.name,
    "contracts": contracts,
}

output_file.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

  rm -f "$ids_file"
  echo "Deployment metadata written to: $output_file"
}

print_help() {
  cat <<'EOF'
Usage:
  ./scripts/contracts-release.sh rehearse
  ./scripts/contracts-release.sh build
  ./scripts/contracts-release.sh verify
  ./scripts/contracts-release.sh deploy --network <network> --source <stellar-key-name> [--dry-run] [--force]

Commands:
  rehearse  Run the storage migration rehearsal and rollback-constraint checks only
  build     Rehearse migration, generate the compatibility report, then build and manifest
  verify    Rehearse migration, generate the compatibility report, then verify artifacts
  deploy    Rehearse migration, generate the compatibility report, then deploy

Every command requires explicit authorization via XCONFESS_RELEASE_AUTHORIZATION
(must equal XCONFESS_REQUIRED_AUTHORIZATION_TOKEN, default "storage-migration-approved").
Release is blocked when the compatibility report lists blocking conditions.

Options:
  --dry-run  Verify build artifacts and deployment readiness without deploying contracts
  --force    Allow deploy to proceed even when no prior deployment metadata exists
EOF
}

main() {
  if [[ ! -d "$CONTRACTS_DIR" ]]; then
    echo "Could not find contracts directory: $CONTRACTS_DIR" >&2
    exit 1
  fi

  local cmd="${1:-}"
  case "$cmd" in
    rehearse)
      rehearse_migration
      ;;
    build)
      build_all
      ;;
    verify)
      verify_only
      ;;
    deploy)
      shift || true
      local network=""
      local source_key=""
      local dry_run="false"
      local force="false"
      while [[ $# -gt 0 ]]; do
        case "$1" in
          --network)
            network="${2:-}"
            shift 2
            ;;
          --source)
            source_key="${2:-}"
            shift 2
            ;;
          --dry-run)
            dry_run="true"
            shift
            ;;
          --force)
            force="true"
            shift
            ;;
          *)
            echo "Unknown argument: $1" >&2
            print_help
            exit 1
            ;;
        esac
      done
      if [[ -z "$network" || -z "$source_key" ]]; then
        echo "deploy requires --network and --source" >&2
        print_help
        exit 1
      fi
      deploy_all "$network" "$source_key" "$dry_run" "$force"
      ;;
    -h|--help|help|"")
      print_help
      ;;
    *)
      echo "Unknown command: $cmd" >&2
      print_help
      exit 1
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
