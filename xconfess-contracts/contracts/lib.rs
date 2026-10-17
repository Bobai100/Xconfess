use soroban_sdk::{Address, Env, Symbol};

pub mod events;
pub mod pagination;
pub mod report;

// Define deterministic errors
pub const ERR_DUPLICATE_REPORT: &str = "duplicate_report";
pub const ERR_COOLDOWN_ACTIVE: &str = "cooldown_active";
pub const ERR_REASON_EMPTY: &str = "reason_empty";
pub const ERR_REASON_TOO_LONG: &str = "reason_too_long";

// Storage layout versioning.
//
// Bump `CURRENT_STORAGE_VERSION` whenever the persistent storage layout changes
// in a way that requires an explicit migration. The compatibility report
// generator and the migration rehearsal tooling read these constants directly
// (without invoking contract functions) to decide whether a release is
// blocked on a pending migration.
pub const CURRENT_STORAGE_VERSION: u32 = 1;

// The oldest storage version that can be migrated in place. Anything older
// must be handled by an offline/manual migration before deployment.
pub const MIN_SUPPORTED_STORAGE_VERSION: u32 = 1;

// Deterministic migration step identifiers, ordered by execution sequence.
pub const MIGRATION_STEP_INITIALIZE: &str = "initialize_storage";
pub const MIGRATION_STEP_REINDEX_REPORTS: &str = "reindex_report_keys";
pub const MIGRATION_STEP_REBUILD_EVENT_NONCES: &str = "rebuild_event_nonces";

/// Returns the storage version this build of the contract writes.
pub fn current_storage_version() -> u32 {
    CURRENT_STORAGE_VERSION
}

/// Returns the oldest storage version this build can migrate in place.
pub fn min_supported_storage_version() -> u32 {
    MIN_SUPPORTED_STORAGE_VERSION
}

/// Describes the migration requirements for moving from `from_version` to the
/// current storage version.
///
/// The result is a deterministic list of migration step identifiers that must
/// be executed, in order, before the release can be considered compatible.
/// An empty list means no migration is required.
///
/// # Failure semantics
/// Returns `Err` when `from_version` is newer than the current version (a
/// downgrade, which is never supported) or older than the minimum supported
/// version (requires an offline migration).
pub fn required_migration_steps(from_version: u32) -> Result<Vec<&'static str>, &'static str> {
    if from_version > CURRENT_STORAGE_VERSION {
        return Err("storage_version_downgrade_unsupported");
    }
    if from_version < MIN_SUPPORTED_STORAGE_VERSION {
        return Err("storage_version_too_old_for_in_place_migration");
    }
    if from_version == CURRENT_STORAGE_VERSION {
        return Ok(Vec::new());
    }

    // Version 0 -> 1: initialize storage and rebuild derived indexes.
    let mut steps: Vec<&'static str> = Vec::new();
    if from_version < 1 {
        steps.push(MIGRATION_STEP_INITIALIZE);
        steps.push(MIGRATION_STEP_REINDEX_REPORTS);
        steps.push(MIGRATION_STEP_REBUILD_EVENT_NONCES);
    }
    Ok(steps)
}

/// Convenience predicate used by the compatibility report to flag a release as
/// blocked on a pending migration.
pub fn migration_required(from_version: u32) -> bool {
    match required_migration_steps(from_version) {
        Ok(steps) => !steps.is_empty(),
        Err(_) => true,
    }
}

// Helper for generating a key for actor-confession mapping
pub fn report_key(actor: &Symbol, confession_id: &Symbol) -> Vec<u8> {
    [actor.as_bytes(), confession_id.as_bytes()].concat()
}

// Read helpers for indexer reconciliation.
pub fn latest_confession_event_nonce(env: &Env, confession_id: u64) -> u64 {
    events::latest_confession_nonce(env, confession_id)
}

pub fn latest_reaction_event_nonce(env: &Env, confession_id: u64) -> u64 {
    events::latest_reaction_nonce(env, confession_id)
}

pub fn latest_report_event_nonce(env: &Env, confession_id: u64) -> u64 {
    events::latest_report_nonce(env, confession_id)
}

pub fn latest_role_event_nonce(env: &Env, user: Address, role: Symbol) -> u64 {
    events::latest_role_nonce(env, user, role)
}

pub fn latest_governance_event_nonce(env: &Env, stream: Symbol) -> u64 {
    events::latest_governance_nonce(env, stream)
}

pub fn latest_badge_event_nonce(env: &Env, badge_id: u64) -> u64 {
    events::latest_badge_nonce(env, badge_id)
}