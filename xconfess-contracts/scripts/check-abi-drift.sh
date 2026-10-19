#!/usr/bin/env bash
# check-abi-drift.sh — Verify committed abi.json files match contract source code
# and emit a pre-release contract storage compatibility report.
#
# The report combines:
#   - ABI diff (source vs committed abi.json)
#   - storage version declared by each contract
#   - migration requirements (migration entrypoints / migration notes)
#   - deployment manifest differences (committed manifest vs current source)
# and lists explicit blocking conditions.
#
# Exit codes:
#   0 — all abi.json files are in sync and no blocking conditions
#   1 — drift detected, blocking conditions present, or script error
#
# Environment:
#   ABI_REPORT_PATH  — where to write the JSON report
#                      (default: <contracts-dir>/abi-compat-report.json)
#   ABI_REPORT_STRICT — if "1", any warning is promoted to a blocker
#
# Usage:
#   ./scripts/check-abi-drift.sh           # from xconfess-contracts/
#   bash scripts/check-abi-drift.sh        # from repo root
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DRIFT=0

REPORT_PATH="${ABI_REPORT_PATH:-$CONTRACTS_DIR/abi-compat-report.json}"
REPORT_STRICT="${ABI_REPORT_STRICT:-0}"

# Per-contract report fragments are accumulated here (one JSON object per line).
REPORT_FRAGMENTS="$(mktemp)"
trap 'rm -f "$REPORT_FRAGMENTS"' EXIT

# Extract the storage version declared by a contract.
# Looks for `const STORAGE_VERSION: u32 = N;` (or similar) in src/lib.rs.
extract_storage_version() {
  local lib_file="$1"
  if [[ ! -f "$lib_file" ]]; then
    echo ""
    return
  fi
  grep -oP 'STORAGE_VERSION\s*:\s*u32\s*=\s*\K[0-9]+' "$lib_file" | head -n1 || true
}

# Detect whether the contract exposes a migration entrypoint.
extract_migration_entrypoints() {
  local lib_file="$1"
  if [[ ! -f "$lib_file" ]]; then
    echo ""
    return
  fi
  grep -oP 'pub\s+fn\s+\K(migrate|upgrade)[a-z_0-9]*' "$lib_file" | sort -u || true
}

# Read the storage version recorded in a committed deployment manifest, if any.
# Supported manifest locations (first match wins):
#   <contract>/deployment-manifest.json
#   <contract>/manifest.json
read_manifest_storage_version() {
  local contract_dir="$1"
  local manifest=""
  for candidate in "$contract_dir/deployment-manifest.json" "$contract_dir/manifest.json"; do
    if [[ -f "$candidate" ]]; then
      manifest="$candidate"
      break
    fi
  done
  if [[ -z "$manifest" ]]; then
    echo ""
    return
  fi
  python3 -c "
import json, sys
try:
    with open('$manifest') as f:
        data = json.load(f)
    v = data.get('storage_version', data.get('storageVersion', ''))
    print('' if v is None else v)
except Exception:
    sys.exit(1)
" 2>/dev/null || echo ""
}

# Read the deployment manifest's declared function list (if present) for diffing.
read_manifest_functions() {
  local contract_dir="$1"
  local manifest=""
  for candidate in "$contract_dir/deployment-manifest.json" "$contract_dir/manifest.json"; do
    if [[ -f "$candidate" ]]; then
      manifest="$candidate"
      break
    fi
  done
  if [[ -z "$manifest" ]]; then
    echo ""
    return
  fi
  python3 -c "
import json, sys
try:
    with open('$manifest') as f:
        data = json.load(f)
    funcs = data.get('functions', [])
    for fn in sorted(funcs):
        print(fn)
except Exception:
    sys.exit(1)
" 2>/dev/null || echo ""
}

# Extract function names from a contract's lib.rs by finding pub fn declarations
# inside #[contractimpl] blocks.
extract_functions_from_source() {
  local lib_file="$1"
  if [[ ! -f "$lib_file" ]]; then
    echo ""
    return
  fi
  # Extract all `pub fn <name>` lines, strip the `pub fn ` prefix and trailing parens/params
  # This catches both `pub fn name(...)` and `pub fn name(…)` patterns
  grep -oP 'pub\s+fn\s+\K[a-z_][a-z_0-9]*' "$lib_file" | sort -u
}

# Read functions list from an abi.json file
read_abi_functions() {
  local abi_file="$1"
  if [[ ! -f "$abi_file" ]]; then
    echo ""
    return
  fi
  # Extract function names from the JSON "functions" array
  # Handles both compact and multi-line JSON arrays
  python3 -c "
import json, sys
try:
    with open('$abi_file') as f:
        data = json.load(f)
    funcs = data.get('functions', [])
    for fn in sorted(funcs):
        print(fn)
except Exception:
    sys.exit(1)
" 2>/dev/null || echo ""
}

# Check a single contract directory for ABI drift
check_contract() {
  local contract_dir="$1"
  local contract_name
  contract_name="$(basename "$contract_dir")"
  local lib_file="$contract_dir/src/lib.rs"
  local abi_file="$contract_dir/abi.json"

  echo "─── Checking: $contract_name ───"

  if [[ ! -f "$abi_file" ]]; then
    echo "  ⚠  No abi.json found — skipping"
    return
  fi

  if [[ ! -f "$lib_file" ]]; then
    echo "  ⚠  No src/lib.rs found — skipping"
    return
  fi

  local source_functions
  source_functions="$(extract_functions_from_source "$lib_file")"
  local abi_functions
  abi_functions="$(read_abi_functions "$abi_file")"

  if [[ -z "$source_functions" ]]; then
    echo "  ⚠  No public functions found in source — skipping comparison"
    return
  fi

  # Build temp files for diff
  local tmp_source tmp_abi
  tmp_source="$(mktemp)"
  tmp_abi="$(mktemp)"
  echo "$source_functions" > "$tmp_source"
  echo "$abi_functions" > "$tmp_abi"

  local source_count abi_count
  source_count="$(grep -c '.' "$tmp_source" || echo 0)"
  abi_count="$(grep -c '.' "$tmp_abi" || echo 0)"

  echo "  Source functions: $source_count"
  echo "  ABI functions:    $abi_count"

  local missing_in_abi extra_in_abi
  missing_in_abi="$(comm -23 "$tmp_source" "$tmp_abi")"
  extra_in_abi="$(comm -13 "$tmp_source" "$tmp_abi")"

  local has_drift=0

  if [[ -n "$missing_in_abi" ]]; then
    echo "  ❌ Functions in source but missing from abi.json:"
    echo "$missing_in_abi" | sed 's/^/     - /'
    has_drift=1
  fi

  if [[ -n "$extra_in_abi" ]]; then
    echo "  ❌ Functions in abi.json but not found in source:"
    echo "$extra_in_abi" | sed 's/^/     - /'
    has_drift=1
  fi

  if [[ "$has_drift" -eq 0 ]]; then
    echo "  ✅ ABI in sync"
  else
    DRIFT=1
  fi

  # ── Storage / migration / manifest compatibility analysis ──────────────────
  local storage_version manifest_version
  storage_version="$(extract_storage_version "$lib_file")"
  manifest_version="$(read_manifest_storage_version "$contract_dir")"

  local migration_entrypoints
  migration_entrypoints="$(extract_migration_entrypoints "$lib_file")"

  local manifest_functions
  manifest_functions="$(read_manifest_functions "$contract_dir")"

  local manifest_missing manifest_extra
  manifest_missing=""
  manifest_extra=""
  if [[ -n "$manifest_functions" ]]; then
    local tmp_manifest
    tmp_manifest="$(mktemp)"
    echo "$manifest_functions" > "$tmp_manifest"
    manifest_missing="$(comm -23 "$tmp_source" "$tmp_manifest")"
    manifest_extra="$(comm -13 "$tmp_source" "$tmp_manifest")"
    rm -f "$tmp_manifest"
  fi

  # Determine blocking conditions for this contract.
  local blockers=()
  local warnings=()

  if [[ "$has_drift" -ne 0 ]]; then
    blockers+=("abi_drift")
  fi

  if [[ -z "$storage_version" ]]; then
    warnings+=("storage_version_missing")
  fi

  if [[ -n "$storage_version" && -n "$manifest_version" && "$storage_version" != "$manifest_version" ]]; then
    blockers+=("storage_version_mismatch")
  fi

  # A storage version bump without a migration entrypoint is a blocker.
  if [[ -n "$storage_version" && -n "$manifest_version" && "$storage_version" != "$manifest_version" && -z "$migration_entrypoints" ]]; then
    blockers+=("migration_required")
  fi

  if [[ -n "$manifest_missing" || -n "$manifest_extra" ]]; then
    blockers+=("manifest_drift")
  fi

  if [[ "$REPORT_STRICT" == "1" && ${#warnings[@]} -gt 0 ]]; then
    blockers+=("strict_warnings")
  fi

  if [[ ${#blockers[@]} -gt 0 ]]; then
    DRIFT=1
    echo "  ⛔ Blocking conditions: ${blockers[*]}"
  fi

  # Emit a machine-readable fragment for this contract.
  python3 - "$contract_name" "$storage_version" "$manifest_version" \
    "$migration_entrypoints" "$missing_in_abi" "$extra_in_abi" \
    "$manifest_missing" "$manifest_extra" \
    "${blockers[*]:-}" "${warnings[*]:-}" >> "$REPORT_FRAGMENTS" <<'PY'
import json, sys

(name, storage_version, manifest_version, migration_entrypoints,
 missing_in_abi, extra_in_abi, manifest_missing, manifest_extra,
 blockers, warnings) = sys.argv[1:11]

def lines(value):
    return [ln for ln in value.splitlines() if ln.strip()]

report = {
    "contract": name,
    "abi": {
        "missing_in_abi": lines(missing_in_abi),
        "extra_in_abi": lines(extra_in_abi),
        "in_sync": not lines(missing_in_abi) and not lines(extra_in_abi),
    },
    "storage": {
        "source_version": storage_version or None,
        "manifest_version": manifest_version or None,
        "migration_entrypoints": lines(migration_entrypoints),
    },
    "manifest": {
        "missing_in_manifest": lines(manifest_missing),
        "extra_in_manifest": lines(manifest_extra),
        "in_sync": not lines(manifest_missing) and not lines(manifest_extra),
    },
    "blockers": blockers.split(),
    "warnings": warnings.split(),
    "blocking": bool(blockers.split()),
}
print(json.dumps(report))
PY

  rm -f "$tmp_source" "$tmp_abi"
}

echo "=== Contract ABI Drift Check ==="
echo ""

# Find all contract directories (those containing abi.json)
for abi_path in "$CONTRACTS_DIR"/contracts/*/abi.json; do
  contract_dir="$(dirname "$abi_path")"
  check_contract "$contract_dir"
  echo ""
done

# Assemble the final compatibility report.
python3 - "$REPORT_PATH" "$REPORT_FRAGMENTS" <<'PY'
import json, sys, datetime

report_path, fragments_path = sys.argv[1], sys.argv[2]

contracts = []
with open(fragments_path) as f:
    for line in f:
        line = line.strip()
        if line:
            contracts.append(json.loads(line))

blocking = [c["contract"] for c in contracts if c.get("blocking")]
report = {
    "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "contracts": contracts,
    "summary": {
        "contract_count": len(contracts),
        "blocking_contracts": blocking,
        "has_blockers": bool(blocking),
    },
}

with open(report_path, "w") as f:
    json.dump(report, f, indent=2, sort_keys=True)
    f.write("\n")
PY

echo "📝 Compatibility report written to: $REPORT_PATH"
echo ""

if [[ "$DRIFT" -ne 0 ]]; then
  echo "❌ ABI drift or blocking compatibility conditions detected."
  echo "   Review $REPORT_PATH for details."
  echo "   (See docs/contract-abi-reference.md for manual update instructions)"
  exit 1
else
  echo "✅ All abi.json files are in sync with contract source and no blockers."
  exit 0
fi
