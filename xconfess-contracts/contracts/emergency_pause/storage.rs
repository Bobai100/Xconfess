use soroban_sdk::contracttype;

/// Current storage layout version for the emergency_pause contract.
///
/// Bump this whenever the persisted `DataKey` layout or value encoding changes
/// in a way that requires a migration. The pre-release compatibility report
/// reads this constant to compare against the deployed manifest.
pub const STORAGE_VERSION: u32 = 1;

/// Describes whether a storage migration is required when moving to
/// `STORAGE_VERSION` from a previously deployed version.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum MigrationRequirement {
    /// No migration needed; layout is compatible with prior versions.
    None,
    /// A migration entry point must be invoked before the contract is usable.
    Required,
}

/// Migration requirement for the current `STORAGE_VERSION`.
///
/// The compatibility report surfaces this value and treats
/// `MigrationRequirement::Required` as a blocking condition unless a
/// corresponding migration step is present in the release plan.
pub const MIGRATION_REQUIREMENT: MigrationRequirement = MigrationRequirement::None;

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    Paused,
}