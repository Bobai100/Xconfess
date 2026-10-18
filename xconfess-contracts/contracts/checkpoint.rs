use soroban_sdk::{contracttype, Env, Vec};
use crate::confession::Confession;
use crate::reaction::Reaction;
use crate::report::Report;

/// Current on-chain storage layout version.
///
/// Bump this whenever the persisted storage layout changes in a way that
/// requires a migration. The pre-release compatibility report reads this
/// value as the deterministic source of truth for the storage version.
pub const STORAGE_VERSION: u32 = 1;

/// Minimum storage version that can be upgraded in place without a migration.
pub const MIN_COMPATIBLE_STORAGE_VERSION: u32 = 1;

/// Snapshot summaries for indexer consumption
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CheckpointSummary {
    pub total_confessions: u64,
    pub total_reactions: u64,
    pub total_reports: u64,
    pub latest_confession_id: u64,
    pub latest_reaction_id: u64,
    pub latest_report_id: u64,
    pub version_marker: u32, // allows backward-compatible upgrades
    /// Storage layout version the snapshot was produced from.
    pub storage_version: u32,
    /// Whether an upgrade from the previous release requires a migration.
    pub migration_required: bool,
}

/// Returns whether a migration is required to move from `from_version` to
/// `to_version`.
///
/// Semantics:
/// - Identical versions never require a migration.
/// - Downgrades are rejected (treated as requiring a migration) because the
///   on-chain layout cannot be safely rolled back in place.
/// - Upgrades require a migration whenever the source version is below
///   [`MIN_COMPATIBLE_STORAGE_VERSION`] or the target version is newer than
///   the source.
pub fn migration_required(from_version: u32, to_version: u32) -> bool {
    if from_version == to_version {
        return false;
    }
    if to_version < from_version {
        return true;
    }
    from_version < MIN_COMPATIBLE_STORAGE_VERSION || to_version > from_version
}

/// Snapshot page for paginated reading
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SnapshotPage<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<u64>, // next starting id for pagination
}

/// ===========================================
/// API: deterministic checkpoint reads
/// ===========================================
pub fn get_checkpoint_summary(
    env: &Env,
    confessions: &Vec<Confession>,
    reactions: &Vec<Reaction>,
    reports: &Vec<Report>,
) -> CheckpointSummary {
    let total_confessions = confessions.len() as u64;
    let total_reactions = reactions.len() as u64;
    let total_reports = reports.len() as u64;

    let latest_confession_id = confessions.last().map(|c| c.id).unwrap_or(0);
    let latest_reaction_id = reactions.last().map(|r| r.id).unwrap_or(0);
    let latest_report_id = reports.last().map(|rep| rep.id).unwrap_or(0);

    CheckpointSummary {
        total_confessions,
        total_reactions,
        total_reports,
        latest_confession_id,
        latest_reaction_id,
        latest_report_id,
        version_marker: 1,
        storage_version: STORAGE_VERSION,
        migration_required: migration_required(MIN_COMPATIBLE_STORAGE_VERSION, STORAGE_VERSION),
    }
}

/// ===========================================
/// API: deterministic paginated snapshot reads
/// ===========================================
pub fn get_snapshot_page<T: Clone>(
    items: &Vec<T>,
    start_id: u64,
    page_size: u64,
    get_id: impl Fn(&T) -> u64,
) -> SnapshotPage<T> {
    let mut page_items = Vec::new(items.env());
    let mut next_cursor: Option<u64> = None;

    for item in items.iter() {
        let id = get_id(&item);
        if id > start_id && page_items.len() < page_size as usize {
            page_items.push(item.clone());
        } else if id > start_id {
            next_cursor = Some(id);
            break;
        }
    }

    SnapshotPage {
        items: page_items,
        next_cursor,
    }
}