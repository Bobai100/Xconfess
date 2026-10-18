use soroban_sdk::contracttype;

/// Current storage layout version for the governance contract.
///
/// Bump this whenever the persisted `DataKey` layout or value encoding changes
/// in a way that requires a migration. The pre-release compatibility report
/// reads this constant to compare against the deployed manifest.
pub const STORAGE_VERSION: u32 = 1;

/// Describes whether a migration is required when moving to `STORAGE_VERSION`.
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MigrationRequirement {
    /// No migration needed; storage layout is compatible.
    None,
    /// A migration entrypoint must be run before the contract is usable.
    Required,
    /// Storage layout is incompatible; a fresh deployment is required.
    Breaking,
}

/// Migration requirement for the current `STORAGE_VERSION`.
///
/// The compatibility report surfaces this value alongside the storage version
/// so maintainers can see explicit blocking conditions before release.
pub const MIGRATION_REQUIREMENT: MigrationRequirement = MigrationRequirement::None;

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    GovernanceConfig,
    Proposal(u64),
    NextProposalId,
}