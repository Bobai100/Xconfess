#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

contracts_dir="$tmpdir/xconfess-contracts"
target_dir="$contracts_dir/target/wasm32-unknown-unknown/release"
manifest_file="$tmpdir/contract-wasm-manifest.json"

crates=(
  "confession-anchor"
  "confession-registry"
  "anonymous-tipping"
  "reputation-badges"
)

mkdir -p "$target_dir"
for crate in "${crates[@]}"; do
  mkdir -p "$contracts_dir/contracts/$crate"
  printf '[package]\nname = "%s"\nversion = "1.2.3"\n' "$crate" \
    > "$contracts_dir/contracts/$crate/Cargo.toml"
  printf 'fixture wasm bytes for %s\n' "$crate" \
    > "$target_dir/${crate//-/_}.wasm"
done

export XCONFESS_CONTRACTS_DIR="$contracts_dir"
export XCONFESS_TARGET_DIR="$target_dir"

source "$REPO_ROOT/scripts/contracts-release.sh"

verify_wasm_outputs
write_manifest "$manifest_file"

python3 - "$contracts_dir" "$manifest_file" "${crates[@]}" <<'PY'
import hashlib
import json
import pathlib
import sys

contracts_dir = pathlib.Path(sys.argv[1])
manifest_file = pathlib.Path(sys.argv[2])
crates = sys.argv[3:]

payload = json.loads(manifest_file.read_text(encoding="utf-8"))
contracts = payload.get("contracts", {})

missing = [crate for crate in crates if crate not in contracts]
if missing:
    raise SystemExit(f"Manifest is missing contract entries: {', '.join(missing)}")

for crate in crates:
    entry = contracts[crate]
    wasm_file = entry.get("wasm_file")
    sha256 = entry.get("sha256")
    if not wasm_file:
        raise SystemExit(f"{crate} is missing wasm_file metadata")
    if not isinstance(sha256, str) or len(sha256) != 64:
        raise SystemExit(f"{crate} has invalid sha256 metadata: {sha256!r}")
    wasm_path = contracts_dir / wasm_file
    expected = hashlib.sha256(wasm_path.read_bytes()).hexdigest()
    if sha256 != expected:
        raise SystemExit(f"{crate} sha256 mismatch: expected {expected}, got {sha256}")

print("contract release metadata hash coverage passed")
PY

rm "$target_dir/confession_registry.wasm"
if (verify_wasm_outputs) 2>"$tmpdir/missing.log"; then
  echo "verify_wasm_outputs succeeded despite a missing artifact" >&2
  exit 1
fi

if ! grep -q "Missing artifact: .*confession_registry.wasm" "$tmpdir/missing.log"; then
  echo "missing artifact failure did not name confession_registry.wasm" >&2
  cat "$tmpdir/missing.log" >&2
  exit 1
fi

echo "missing artifact failure coverage passed"

# --- Pre-release contract storage compatibility report coverage ---

report_script="$REPO_ROOT/scripts/contract-release-report.sh"
if [[ ! -f "$report_script" ]]; then
  echo "missing pre-release compatibility report script: $report_script" >&2
  exit 1
fi

report_root="$tmpdir/report"
mkdir -p "$report_root/current" "$report_root/previous"

write_abi() {
  local file="$1"
  local version="$2"
  local extra="${3:-}"
  cat > "$file" <<JSON
{
  "schema_version": 1,
  "contract": "confession-registry",
  "abi_version": "$version",
  "functions": [
    {"name": "create_confession", "inputs": [], "outputs": []},
    {"name": "get_confession", "inputs": [], "outputs": []}$extra
  ]
}
JSON
}

write_storage() {
  local file="$1"
  local version="$2"
  local migration="$3"
  cat > "$file" <<JSON
{
  "schema_version": 1,
  "contract": "confession-registry",
  "storage_version": $version,
  "migration_required": $migration,
  "keys": ["Confession", "Counter"]
}
JSON
}

write_manifest_fixture() {
  local file="$1"
  local wasm_sha="$2"
  local abi_sha="$3"
  cat > "$file" <<JSON
{
  "schema_version": 1,
  "contracts": {
    "confession-registry": {
      "wasm_file": "confession_registry.wasm",
      "sha256": "$wasm_sha",
      "abi_sha256": "$abi_sha"
    }
  }
}
JSON
}

# Compatible case: same ABI, same storage version, no migration, identical manifest.
write_abi "$report_root/previous/abi.json" "1.0.0"
write_abi "$report_root/current/abi.json" "1.0.0"
write_storage "$report_root/previous/storage.json" 1 false
write_storage "$report_root/current/storage.json" 1 false
write_manifest_fixture "$report_root/previous/manifest.json" "$(printf 'a%.0s' {1..64})" "$(printf 'b%.0s' {1..64})"
write_manifest_fixture "$report_root/current/manifest.json" "$(printf 'a%.0s' {1..64})" "$(printf 'b%.0s' {1..64})"

compatible_report="$tmpdir/compatible-report.json"
if ! "$report_script" \
  --previous-dir "$report_root/previous" \
  --current-dir "$report_root/current" \
  --output "$compatible_report" 2>"$tmpdir/compatible.log"; then
  echo "compatibility report failed for a compatible release" >&2
  cat "$tmpdir/compatible.log" >&2
  exit 1
fi

python3 - "$compatible_report" <<'PY'
import json
import pathlib
import sys

report = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
for section in ("abi", "storage", "migration", "deployment_manifest"):
    if section not in report:
        raise SystemExit(f"compatible report is missing section: {section}")
if report["abi"].get("compatible") is not True:
    raise SystemExit("compatible report should mark ABI as compatible")
if report["storage"].get("version") != 1:
    raise SystemExit("compatible report should record storage version 1")
if report["migration"].get("required") is not False:
    raise SystemExit("compatible report should record no migration requirement")
if report["deployment_manifest"].get("changed") is not False:
    raise SystemExit("compatible report should record no manifest diff")
if report.get("blocking"):
    raise SystemExit(f"compatible report should not be blocking: {report.get('blocking')}")
print("compatible release report coverage passed")
PY

# Incompatible case: ABI removal, storage version bump with migration, manifest drift.
write_abi "$report_root/current/abi.json" "2.0.0"
write_storage "$report_root/current/storage.json" 2 true
write_manifest_fixture "$report_root/current/manifest.json" "$(printf 'c%.0s' {1..64})" "$(printf 'd%.0s' {1..64})"

incompatible_report="$tmpdir/incompatible-report.json"
set +e
"$report_script" \
  --previous-dir "$report_root/previous" \
  --current-dir "$report_root/current" \
  --output "$incompatible_report" 2>"$tmpdir/incompatible.log"
incompatible_status=$?
set -e

if [[ "$incompatible_status" -eq 0 ]]; then
  echo "compatibility report exited 0 despite blocking conditions" >&2
  exit 1
fi

python3 - "$incompatible_report" <<'PY'
import json
import pathlib
import sys

report = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
for section in ("abi", "storage", "migration", "deployment_manifest"):
    if section not in report:
        raise SystemExit(f"incompatible report is missing section: {section}")
if report["abi"].get("compatible") is not False:
    raise SystemExit("incompatible report should mark ABI as incompatible")
if report["storage"].get("version") != 2:
    raise SystemExit("incompatible report should record storage version 2")
if report["migration"].get("required") is not True:
    raise SystemExit("incompatible report should record a migration requirement")
if report["deployment_manifest"].get("changed") is not True:
    raise SystemExit("incompatible report should record a manifest diff")
blocking = report.get("blocking") or []
if not blocking:
    raise SystemExit("incompatible report should list blocking conditions")
print("incompatible release report coverage passed")
PY

# Missing manifest case: the report must fail closed and name the missing input.
rm "$report_root/current/manifest.json"
set +e
"$report_script" \
  --previous-dir "$report_root/previous" \
  --current-dir "$report_root/current" \
  --output "$tmpdir/missing-manifest-report.json" 2>"$tmpdir/missing-manifest.log"
missing_manifest_status=$?
set -e

if [[ "$missing_manifest_status" -eq 0 ]]; then
  echo "compatibility report exited 0 despite a missing deployment manifest" >&2
  exit 1
fi

if ! grep -qi "manifest" "$tmpdir/missing-manifest.log"; then
  echo "missing manifest failure did not name the manifest input" >&2
  cat "$tmpdir/missing-manifest.log" >&2
  exit 1
fi

echo "missing manifest failure coverage passed"
