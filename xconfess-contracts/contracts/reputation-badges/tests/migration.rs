//! Migration tests for the reputation-badges contract.
//!
//! `reputation-badges` had no explicit schema version prior to this test
//! suite; `schema_version()`/`migrate()` were added so upgrades can be
//! validated the same way as `confession-anchor` and `anonymous-tipping`.
//! SCHEMA_VERSION_CURRENT == SCHEMA_VERSION_INITIAL today (no layout change
//! yet needed) — these tests pin the *handler*, so a future schema bump that
//! forgets to add a migration arm fails loudly instead of silently.

#![cfg(test)]

extern crate std;

use reputation_badges::{
    BadgeType, ReputationBadges, ReputationBadgesClient, SCHEMA_VERSION_CURRENT,
    SCHEMA_VERSION_INITIAL,
};
use soroban_sdk::{testutils::Address as _, Address, Env};

fn setup() -> (Env, Address, ReputationBadgesClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(ReputationBadges, ());
    let client = ReputationBadgesClient::new(&env, &id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    (env, admin, client)
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
fn migrate_requires_admin_authorization() {
    use reputation_badges::Error;
    let (env, _admin, client) = setup();
    let non_admin = Address::generate(&env);

    let result = client.try_migrate(&non_admin);
    assert_eq!(result, Err(Ok(Error::NotAuthorized)));
}

/// Pre-existing badges and reputation must survive migration byte-for-byte —
/// migration must only ever add keys, never rewrite them.
#[test]
fn migration_preserves_pre_existing_badges_and_reputation() {
    let (env, admin, client) = setup();
    let user = Address::generate(&env);
    let reason = soroban_sdk::String::from_str(&env, "good confession");

    let badge_id = client.mint_badge(&user, &BadgeType::ConfessionStarter);
    client.adjust_reputation(&user, &42i128, &reason);

    client.migrate(&admin);

    assert_eq!(client.get_badge(&badge_id).unwrap().owner, user);
    assert_eq!(client.get_user_reputation(&user), 42i128);
}

/// Representative prior-version state fixture: several users, several badge
/// types, and non-trivial reputation balances. This mirrors what a real
/// deployed instance would hold when an upgrade is rehearsed.
struct PriorStateFixture {
    users: [Address; 3],
    badge_ids: [u64; 3],
    reputation: [i128; 3],
}

fn seed_prior_state(env: &Env, client: &ReputationBadgesClient<'static>) -> PriorStateFixture {
    let user_a = Address::generate(env);
    let user_b = Address::generate(env);
    let user_c = Address::generate(env);

    let reason = soroban_sdk::String::from_str(env, "prior-version activity");

    let badge_a = client.mint_badge(&user_a, &BadgeType::ConfessionStarter);
    let badge_b = client.mint_badge(&user_b, &BadgeType::ConfessionVeteran);
    let badge_c = client.mint_badge(&user_c, &BadgeType::ConfessionStarter);

    client.adjust_reputation(&user_a, &10i128, &reason);
    client.adjust_reputation(&user_b, &250i128, &reason);
    client.adjust_reputation(&user_c, &-5i128, &reason);

    PriorStateFixture {
        users: [user_a, user_b, user_c],
        badge_ids: [badge_a, badge_b, badge_c],
        reputation: [10i128, 250i128, -5i128],
    }
}

/// Rehearse the full upgrade: seed prior-version state, migrate, and assert
/// every pre-existing key is preserved byte-for-byte.
#[test]
fn rehearsal_migration_preserves_prior_version_fixture() {
    let (env, admin, client) = setup();
    let fixture = seed_prior_state(&env, &client);

    assert_eq!(client.schema_version(), SCHEMA_VERSION_INITIAL);

    let new_version = client.migrate(&admin);
    assert_eq!(new_version, SCHEMA_VERSION_CURRENT);
    assert_eq!(client.schema_version(), SCHEMA_VERSION_CURRENT);

    for i in 0..fixture.users.len() {
        let badge = client.get_badge(&fixture.badge_ids[i]).unwrap();
        assert_eq!(badge.owner, fixture.users[i]);
        assert_eq!(
            client.get_user_reputation(&fixture.users[i]),
            fixture.reputation[i]
        );
    }
}

/// Rollback constraint: migration must be idempotent so a re-run after a
/// failed rollout cannot corrupt or duplicate prior-version state.
#[test]
fn rehearsal_migration_is_replayable_without_state_loss() {
    let (env, admin, client) = setup();
    let fixture = seed_prior_state(&env, &client);

    client.migrate(&admin);
    client.migrate(&admin);

    assert_eq!(client.schema_version(), SCHEMA_VERSION_CURRENT);
    for i in 0..fixture.users.len() {
        let badge = client.get_badge(&fixture.badge_ids[i]).unwrap();
        assert_eq!(badge.owner, fixture.users[i]);
        assert_eq!(
            client.get_user_reputation(&fixture.users[i]),
            fixture.reputation[i]
        );
    }
}

/// Rollback constraint: a non-admin cannot trigger a migration, so an
/// unauthorized operator cannot force a state transition during rollback.
#[test]
fn rehearsal_migration_rejects_unauthorized_operator() {
    use reputation_badges::Error;
    let (env, _admin, client) = setup();
    let fixture = seed_prior_state(&env, &client);
    let rogue = Address::generate(&env);

    let result = client.try_migrate(&rogue);
    assert_eq!(result, Err(Ok(Error::NotAuthorized)));

    // State must be untouched after a rejected migration attempt.
    assert_eq!(client.schema_version(), SCHEMA_VERSION_INITIAL);
    for i in 0..fixture.users.len() {
        let badge = client.get_badge(&fixture.badge_ids[i]).unwrap();
        assert_eq!(badge.owner, fixture.users[i]);
        assert_eq!(
            client.get_user_reputation(&fixture.users[i]),
            fixture.reputation[i]
        );
    }
}
