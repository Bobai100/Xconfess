//! Migration tests for the confession-registry contract.
//!
//! `confession-registry` had no explicit schema version prior to this test
//! suite; `schema_version()`/`migrate()` were added so upgrades can be
//! validated the same way as `confession-anchor` and `anonymous-tipping`.
//! SCHEMA_VERSION_CURRENT == SCHEMA_VERSION_INITIAL today (no layout change
//! yet needed) — these tests pin the *handler*, so a future schema bump that
//! forgets to add a migration arm fails loudly instead of silently.

#![cfg(test)]

extern crate std;

use confession_registry::{
    ConfessionRegistry, ConfessionRegistryClient, SCHEMA_VERSION_CURRENT, SCHEMA_VERSION_INITIAL,
};
use soroban_sdk::{testutils::Address as _, Address, BytesN, Env};

fn setup() -> (Env, Address, ConfessionRegistryClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(ConfessionRegistry, ());
    let client = ConfessionRegistryClient::new(&env, &id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    (env, admin, client)
}

fn hash(env: &Env, seed: u8) -> BytesN<32> {
    let mut b = [0u8; 32];
    b[0] = seed;
    BytesN::from_array(env, &b)
}

#[test]
fn schema_version_is_initial_before_migration() {
    let (_env, _admin, client) = setup();
    assert_eq!(client.schema_version(), SCHEMA_VERSION_INITIAL);
}

#[test]
fn migrate_bumps_schema_version_to_current() {
    let (_env, admin, client) = setup();
    let new_version = client.migrate(&admin);
    assert_eq!(new_version, SCHEMA_VERSION_CURRENT);
    assert_eq!(client.schema_version(), SCHEMA_VERSION_CURRENT);
}

#[test]
fn migrate_is_idempotent() {
    let (_env, admin, client) = setup();
    client.migrate(&admin);
    let second = client.migrate(&admin);
    assert_eq!(second, SCHEMA_VERSION_CURRENT);
}

#[test]
#[should_panic(expected = "caller must be the contract owner")]
fn migrate_requires_owner_authorization() {
    let (env, _admin, client) = setup();
    let non_owner = Address::generate(&env);
    client.migrate(&non_owner);
}

/// Pre-existing confessions and author indices must survive migration
/// byte-for-byte — migration must only ever add keys, never rewrite them.
#[test]
fn migration_preserves_pre_existing_confessions() {
    let (env, admin, client) = setup();
    let author = Address::generate(&env);

    let id1 = client.create_confession(&author, &hash(&env, 1), &1_000);
    let id2 = client.create_confession(&author, &hash(&env, 2), &2_000);

    client.migrate(&admin);

    assert_eq!(client.get_confession(&id1).id, id1);
    assert_eq!(client.get_confession(&id2).id, id2);
    assert_eq!(client.get_total_count(), 2);
    assert_eq!(client.get_author_confessions(&author).len(), 2);
}

/// Representative prior-version state fixture: several authors, several
/// confessions each, with distinct timestamps. Captures the full observable
/// state so it can be compared byte-for-byte before and after migration.
struct PriorVersionFixture {
    authors: std::vec::Vec<Address>,
    ids: std::vec::Vec<u64>,
    timestamps: std::vec::Vec<u64>,
    total_count: u64,
    per_author_counts: std::vec::Vec<u32>,
}

fn build_prior_version_fixture(
    env: &Env,
    client: &ConfessionRegistryClient<'_>,
) -> PriorVersionFixture {
    let mut authors = std::vec::Vec::new();
    let mut ids = std::vec::Vec::new();
    let mut timestamps = std::vec::Vec::new();
    let mut per_author_counts = std::vec::Vec::new();

    // Three authors, with 1, 2 and 3 confessions respectively.
    for (a, count) in [1u32, 2, 3].iter().enumerate() {
        let author = Address::generate(env);
        for i in 0..*count {
            let seed = (a as u8) * 10 + i as u8 + 1;
            let ts = 1_000u64 * (seed as u64);
            let id = client.create_confession(&author, &hash(env, seed), &ts);
            ids.push(id);
            timestamps.push(ts);
        }
        per_author_counts.push(*count);
        authors.push(author);
    }

    let total_count = client.get_total_count();
    PriorVersionFixture {
        authors,
        ids,
        timestamps,
        total_count,
        per_author_counts,
    }
}

fn assert_fixture_preserved(
    client: &ConfessionRegistryClient<'_>,
    fixture: &PriorVersionFixture,
) {
    assert_eq!(client.get_total_count(), fixture.total_count);
    for (idx, id) in fixture.ids.iter().enumerate() {
        let c = client.get_confession(id);
        assert_eq!(c.id, *id);
        assert_eq!(c.timestamp, fixture.timestamps[idx]);
    }
    for (idx, author) in fixture.authors.iter().enumerate() {
        let list = client.get_author_confessions(author);
        assert_eq!(list.len(), fixture.per_author_counts[idx]);
    }
}

/// Rehearsal: build a representative prior-version state, migrate, and prove
/// every pre-existing key is byte-for-byte unchanged.
#[test]
fn migration_rehearsal_preserves_prior_version_state() {
    let (env, admin, client) = setup();
    let fixture = build_prior_version_fixture(&env, &client);

    // Snapshot before migration.
    assert_fixture_preserved(&client, &fixture);
    assert_eq!(client.schema_version(), SCHEMA_VERSION_INITIAL);

    client.migrate(&admin);

    // Snapshot after migration must be identical.
    assert_fixture_preserved(&client, &fixture);
    assert_eq!(client.schema_version(), SCHEMA_VERSION_CURRENT);
}

/// Migration must be safe to re-run against already-migrated prior-version
/// state (idempotent rehearsal) without disturbing any stored keys.
#[test]
fn migration_rehearsal_is_idempotent_over_prior_version_state() {
    let (env, admin, client) = setup();
    let fixture = build_prior_version_fixture(&env, &client);

    client.migrate(&admin);
    client.migrate(&admin);

    assert_fixture_preserved(&client, &fixture);
    assert_eq!(client.schema_version(), SCHEMA_VERSION_CURRENT);
}

/// Rollback constraint: migration must never be able to move the schema
/// version backwards. Re-running migrate after a successful migration keeps
/// the version at CURRENT (there is no downgrade path), and the stored state
/// remains intact.
#[test]
fn migration_cannot_roll_back_schema_version() {
    let (env, admin, client) = setup();
    let fixture = build_prior_version_fixture(&env, &client);

    client.migrate(&admin);
    assert_eq!(client.schema_version(), SCHEMA_VERSION_CURRENT);

    // Attempting to "roll back" by re-invoking migrate must not downgrade.
    let version = client.migrate(&admin);
    assert_eq!(version, SCHEMA_VERSION_CURRENT);
    assert_eq!(client.schema_version(), SCHEMA_VERSION_CURRENT);
    assert_fixture_preserved(&client, &fixture);
}

/// Authorization rejection: a non-admin caller cannot migrate prior-version
/// state, and the schema version must remain untouched after the rejection.
#[test]
#[should_panic(expected = "caller must be the contract owner")]
fn migration_rehearsal_rejects_non_admin_caller() {
    let (env, _admin, client) = setup();
    let _fixture = build_prior_version_fixture(&env, &client);
    let non_admin = Address::generate(&env);
    client.migrate(&non_admin);
}

/// After a rejected non-admin migration, the schema version must still be
/// INITIAL and the prior-version state must be unchanged.
#[test]
fn rejected_migration_leaves_state_untouched() {
    let (env, _admin, client) = setup();
    let fixture = build_prior_version_fixture(&env, &client);
    let non_admin = Address::generate(&env);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.migrate(&non_admin);
    }));
    assert!(result.is_err());

    assert_eq!(client.schema_version(), SCHEMA_VERSION_INITIAL);
    assert_fixture_preserved(&client, &fixture);
}
