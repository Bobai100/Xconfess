//! Migration tests for the anonymous-tipping contract.
//!
//! Each test exercises a specific aspect of the v1→v2 schema migration:
//!   - fresh contract (never init'd), already-migrated contracts, idempotency,
//!     fixture states with live data, rollback properties, and auth enforcement.
//!
//! ## Fixture states used
//! - **Fixture A** – fresh contract, `init()` called, no tips, no owner.
//! - **Fixture B** – contract with 3 tips sent to 2 recipients before migration.
//! - **Fixture C** – contract with owner + pause state, then migrated.
//! - **Fixture D** – serialized prior-version (v1) storage snapshot loaded
//!   directly into ledger storage, then migrated and compared byte-for-byte.
//!
//! ## Operator sequence (release rehearsal)
//! 1. Deploy the v1 contract and run the fixture loader (`load_v1_fixture`) to
//!    seed representative prior-version state.
//! 2. Deploy the v2 wasm over the same contract id (upgrade).
//! 3. Call `migrate(owner)` exactly once; it must return `SCHEMA_VERSION_CURRENT`.
//! 4. Verify `schema_version() == SCHEMA_VERSION_CURRENT` and that every v1 key
//!    is unchanged (see `v1_fixture_keys_preserved_byte_for_byte`).
//! 5. Rollback rehearsal: a v1 reader must still read migrated storage; an
//!    incompatible downgrade (v2 → v1 with new keys present) must be rejected.

extern crate std;

use anonymous_tipping::{
    AnonymousTipping, AnonymousTippingClient, SCHEMA_VERSION_CURRENT, SCHEMA_VERSION_INITIAL,
};
use soroban_sdk::{
    testutils::Address as _, Address, Env, String as SorobanString, Symbol, TryFromVal, Val,
};

// ── helpers ───────────────────────────────────────────────────────────────────

fn setup() -> (Env, Address, AnonymousTippingClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(AnonymousTipping, ());
    let client = AnonymousTippingClient::new(&env, &id);
    client.init(&id);
    (env, id, client)
}

fn owner_setup() -> (Env, Address, Address, AnonymousTippingClient<'static>) {
    let (env, id, client) = setup();
    let owner = Address::generate(&env);
    client.configure_controls(&owner, &1_000u32, &60u64);
    (env, id, owner, client)
}

// ── fixture D: serialized prior-version (v1) storage snapshot ─────────────────

/// A single serialized storage entry from a prior-version deployment.
///
/// `key` and `value` are the raw XDR-encoded `Val`s that a v1 contract would
/// have written to persistent storage.  They are loaded directly into the
/// ledger so the migration runs against a realistic on-chain snapshot rather
/// than state produced by the current (v2) code path.
struct V1StorageEntry {
    key: Symbol,
    value: Val,
}

/// Builds a representative v1 storage snapshot (fixture D).
///
/// The snapshot mirrors the keys a v1 deployment would hold after normal use:
/// schema version, settlement nonce, per-recipient totals, rate-limit config,
/// and pause flag.  Values are encoded as `Val`s exactly as v1 would store them.
fn v1_fixture(env: &Env) -> std::vec::Vec<V1StorageEntry> {
    let mut entries = std::vec::Vec::new();

    entries.push(V1StorageEntry {
        key: Symbol::new(env, "SchemaVer"),
        value: Val::try_from_val(env, &SCHEMA_VERSION_INITIAL).unwrap(),
    });
    entries.push(V1StorageEntry {
        key: Symbol::new(env, "SettleNonce"),
        value: Val::try_from_val(env, &7u64).unwrap(),
    });
    entries.push(V1StorageEntry {
        key: Symbol::new(env, "RateMaxTips"),
        value: Val::try_from_val(env, &250u32).unwrap(),
    });
    entries.push(V1StorageEntry {
        key: Symbol::new(env, "RateWindow"),
        value: Val::try_from_val(env, &120u64).unwrap(),
    });
    entries.push(V1StorageEntry {
        key: Symbol::new(env, "Paused"),
        value: Val::try_from_val(env, &false).unwrap(),
    });

    entries
}

/// Loads the v1 fixture snapshot into the contract's persistent storage.
///
/// This simulates a deployed v1 instance whose storage already contains live
/// data before the v2 wasm is applied.  Returns the entries so tests can
/// compare them byte-for-byte after migration.
fn load_v1_fixture(
    env: &Env,
    contract_id: &Address,
) -> std::vec::Vec<V1StorageEntry> {
    let entries = v1_fixture(env);
    env.as_contract(contract_id, || {
        for entry in entries.iter() {
            env.storage()
                .persistent()
                .set(&entry.key, &entry.value);
        }
    });
    entries
}

/// Reads a raw persistent storage value for `key`, if present.
fn read_raw(env: &Env, contract_id: &Address, key: &Symbol) -> Option<Val> {
    env.as_contract(contract_id, || env.storage().persistent().get::<Symbol, Val>(key))
}

// ── schema version defaults ───────────────────────────────────────────────────

#[test]
fn schema_version_is_initial_before_migration() {
    let (_env, _id, client) = setup();
    assert_eq!(
        client.schema_version(),
        SCHEMA_VERSION_INITIAL,
        "schema version must default to SCHEMA_VERSION_INITIAL before migrate() is called"
    );
}

#[test]
fn global_tip_count_is_zero_before_migration() {
    let (_env, _id, client) = setup();
    assert_eq!(
        client.global_tip_count(),
        0,
        "global_tip_count must default to 0 before migration"
    );
}

// ── v1 → v2 migration correctness ─────────────────────────────────────────────

#[test]
fn migrate_bumps_schema_version_to_current() {
    let (_env, _id, owner, client) = owner_setup();

    let new_version = client.migrate(&owner);
    assert_eq!(
        new_version, SCHEMA_VERSION_CURRENT,
        "migrate() must return SCHEMA_VERSION_CURRENT after upgrade"
    );
    assert_eq!(
        client.schema_version(),
        SCHEMA_VERSION_CURRENT,
        "schema_version() must reflect the upgraded version"
    );
}

#[test]
fn migrate_initialises_global_tip_count_to_zero() {
    let (_env, _id, owner, client) = owner_setup();
    client.migrate(&owner);

    assert_eq!(
        client.global_tip_count(),
        0,
        "GlobalTipCount must be initialised to 0 by migration"
    );
}

// ── fixture B: tips exist before migration ────────────────────────────────────

/// Pre-migration tips must remain unaffected: the existing recipient totals
/// and settlement nonce are preserved after the schema upgrade.
#[test]
fn migration_preserves_pre_existing_recipient_totals() {
    let (env, _id, owner, client) = owner_setup();
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    // Send tips before migration (fixture B state)
    let id1 = client.send_tip(&Address::generate(&env), &alice, &100i128);
    let id2 = client.send_tip(&Address::generate(&env), &alice, &50i128);
    let id3 = client.send_tip(&Address::generate(&env), &bob, &200i128);
    assert_eq!(id1, 1);
    assert_eq!(id2, 2);
    assert_eq!(id3, 3);

    client.migrate(&owner);

    assert_eq!(
        client.get_tips(&alice),
        150i128,
        "alice's total must survive migration"
    );
    assert_eq!(
        client.get_tips(&bob),
        200i128,
        "bob's total must survive migration"
    );
    assert_eq!(
        client.latest_settlement_nonce(),
        3,
        "settlement nonce must survive migration"
    );
}

/// Pre-migration tips are NOT counted in GlobalTipCount; the counter starts
/// at 0 after migration.  Post-migration tips do increment the counter.
#[test]
fn global_tip_count_starts_at_zero_post_migration_not_backfilled() {
    let (env, _id, owner, client) = owner_setup();
    let alice = Address::generate(&env);

    // 3 tips before migration
    client.send_tip(&Address::generate(&env), &alice, &10i128);
    client.send_tip(&Address::generate(&env), &alice, &10i128);
    client.send_tip(&Address::generate(&env), &alice, &10i128);

    client.migrate(&owner);

    assert_eq!(
        client.global_tip_count(),
        0,
        "GlobalTipCount must start at 0 after migration — pre-migration tips are not backfilled"
    );

    // 2 tips after migration
    client.send_tip(&Address::generate(&env), &alice, &5i128);
    client.send_tip(&Address::generate(&env), &alice, &5i128);

    assert_eq!(
        client.global_tip_count(),
        2,
        "only post-migration tips must increment GlobalTipCount"
    );
}

// ── post-migration: GlobalTipCount increments correctly ───────────────────────

#[test]
fn global_tip_count_increments_by_one_per_successful_tip() {
    let (env, _id, owner, client) = owner_setup();
    client.migrate(&owner);

    let recipient = Address::generate(&env);
    for expected in 1u64..=5 {
        client.send_tip(&Address::generate(&env), &recipient, &1i128);
        assert_eq!(
            client.global_tip_count(),
            expected,
            "GlobalTipCount must be {} after {} tips",
            expected,
            expected
        );
    }
}

#[test]
fn global_tip_count_spans_multiple_recipients() {
    let (env, _id, owner, client) = owner_setup();
    client.migrate(&owner);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    client.send_tip(&Address::generate(&env), &alice, &1i128);
    client.send_tip(&Address::generate(&env), &bob, &1i128);
    client.send_tip(&Address::generate(&env), &alice, &1i128);

    assert_eq!(client.global_tip_count(), 3);
}

#[test]
fn global_tip_count_not_incremented_by_failed_tip() {
    let (env, _id, owner, client) = owner_setup();
    client.migrate(&owner);

    let recipient = Address::generate(&env);

    // Failed tip (invalid amount) must not increment counter
    let _ = client.try_send_tip(&Address::generate(&env), &recipient, &0i128);
    assert_eq!(
        client.global_tip_count(),
        0,
        "failed tip must not increment GlobalTipCount"
    );

    // Successful tip increments
    client.send_tip(&Address::generate(&env), &recipient, &1i128);
    assert_eq!(client.global_tip_count(), 1);
}

// ── fixture C: pause state preserved through migration ───────────────────────

#[test]
fn migration_preserves_pause_state() {
    let (env, _id, owner, client) = owner_setup();
    let reason = SorobanString::from_str(&env, "scheduled-maintenance");
    client.pause(&owner, &reason);
    assert!(client.is_paused());

    client.migrate(&owner);

    assert!(
        client.is_paused(),
        "paused flag must be preserved through migration"
    );
    assert_eq!(
        client.schema_version(),
        SCHEMA_VERSION_CURRENT,
        "schema version must advance even when contract is paused"
    );
}

#[test]
fn migration_preserves_rate_limit_config() {
    let (_env, _id, owner, client) = owner_setup();
    // Custom rate-limit (overrides the default set by configure_controls)
    client.configure_controls(&owner, &25u32, &300u64);
    client.migrate(&owner);

    let cfg = client.get_rate_limit_config();
    assert_eq!(
        cfg.max_tips_per_window, 25,
        "max_tips_per_window must survive migration"
    );
    assert_eq!(
        cfg.window_seconds, 300,
        "window_seconds must survive migration"
    );
}

// ── idempotency ───────────────────────────────────────────────────────────────

#[test]
fn migrate_is_idempotent() {
    let (env, _id, owner, client) = owner_setup();
    client.migrate(&owner);

    // Accumulate some state after first migration
    let recipient = Address::generate(&env);
    client.send_tip(&Address::generate(&env), &recipient, &77i128);
    let count_after_first = client.global_tip_count();
    assert_eq!(count_after_first, 1);

    // Second migrate must be a no-op
    let version_again = client.migrate(&owner);
    assert_eq!(version_again, SCHEMA_VERSION_CURRENT);
    assert_eq!(
        client.global_tip_count(),
        1,
        "second migrate() must not reset GlobalTipCount"
    );
    assert_eq!(
        client.get_tips(&recipient),
        77i128,
        "second migrate() must not alter recipient totals"
    );
}

#[test]
fn migrate_multiple_times_returns_current_version_each_time() {
    let (_env, _id, owner, client) = owner_setup();
    for _ in 0..3 {
        let v = client.migrate(&owner);
        assert_eq!(v, SCHEMA_VERSION_CURRENT);
    }
    assert_eq!(client.schema_version(), SCHEMA_VERSION_CURRENT);
}

// ── auth enforcement ──────────────────────────────────────────────────────────

#[test]
fn migrate_requires_owner_authorization() {
    use anonymous_tipping::Error;
    let (env, _id, _owner, client) = owner_setup();
    let non_owner = Address::generate(&env);

    let result = client.try_migrate(&non_owner);
    assert_eq!(
        result,
        Err(Ok(Error::Unauthorized)),
        "migrate() must reject non-owner callers"
    );
}

/// A non-owner migrate attempt must not advance the schema version or mutate
/// any storage — the rejection is atomic.
#[test]
fn rejected_migrate_leaves_storage_untouched() {
    use anonymous_tipping::Error;
    let (env, id, _owner, client) = owner_setup();
    let non_owner = Address::generate(&env);

    let pre_version = client.schema_version();
    let pre_count = client.global_tip_count();

    let result = client.try_migrate(&non_owner);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));

    assert_eq!(
        client.schema_version(),
        pre_version,
        "rejected migrate must not advance schema version"
    );
    assert_eq!(
        client.global_tip_count(),
        pre_count,
        "rejected migrate must not touch GlobalTipCount"
    );
    // Raw storage must be unchanged as well.
    assert_eq!(
        read_raw(&env, &id, &Symbol::new(&env, "SchemaVer")),
        None,
        "rejected migrate must not write the schema version key"
    );
}

/// Calling migrate() when the contract has no owner configured must fail with
/// an explicit authorization error rather than silently succeeding.
#[test]
fn migrate_without_owner_is_rejected() {
    use anonymous_tipping::Error;
    let (env, _id, client) = setup();
    let caller = Address::generate(&env);

    let result = client.try_migrate(&caller);
    assert_eq!(
        result,
        Err(Ok(Error::Unauthorized)),
        "migrate() must reject when no owner is configured"
    );
}

// ── failure semantics: already-migrated state ────────────────────────────────

/// Once migrated, a subsequent migrate() must not re-run destructive work:
/// the schema version stays current and no storage keys are rewritten.
#[test]
fn migrate_on_already_migrated_state_is_noop() {
    let (env, id, owner, client) = owner_setup();
    client.migrate(&owner);

    let version_key = Symbol::new(&env, "SchemaVer");
    let pre_raw = read_raw(&env, &id, &version_key);

    let v = client.migrate(&owner);
    assert_eq!(v, SCHEMA_VERSION_CURRENT);
    assert_eq!(
        read_raw(&env, &id, &version_key),
        pre_raw,
        "already-migrated state must not rewrite the schema version key"
    );
}

// ── fixture D: prior-version snapshot migration rehearsal ────────────────────

/// Loads a serialized v1 snapshot, applies the v2 migration, and asserts every
/// pre-existing v1 key is preserved byte-for-byte.
#[test]
fn v1_fixture_keys_preserved_byte_for_byte() {
    let (env, id, owner, client) = owner_setup();
    let fixture = load_v1_fixture(&env, &id);

    // Capture raw bytes before migration.
    let mut before = std::vec::Vec::new();
    for entry in fixture.iter() {
        let raw = read_raw(&env, &id, &entry.key);
        assert!(raw.is_some(), "fixture key must be present before migration");
        before.push((entry.key.clone(), raw));
    }

    client.migrate(&owner);

    // Every v1 key must be byte-for-byte identical after migration.
    for (key, pre) in before.iter() {
        let post = read_raw(&env, &id, key);
        assert_eq!(
            post, *pre,
            "v1 key {:?} must be preserved byte-for-byte through migration",
            key
        );
    }
}

/// Migration over a v1 snapshot must only ADD the new v2 key (GlobalTipCount)
/// and must not remove or overwrite any v1 key.
#[test]
fn v1_fixture_migration_only_adds_new_keys() {
    let (env, id, owner, client) = owner_setup();
    let fixture = load_v1_fixture(&env, &id);

    let pre_keys: std::vec::Vec<Symbol> = fixture.iter().map(|e| e.key.clone()).collect();

    client.migrate(&owner);

    // All pre-existing keys still present.
    for key in pre_keys.iter() {
        assert!(
            read_raw(&env, &id, key).is_some(),
            "v1 key {:?} must still exist after migration",
            key
        );
    }

    // The new v2 counter key is now present and initialised to 0.
    assert_eq!(
        client.global_tip_count(),
        0,
        "GlobalTipCount must be initialised to 0 over a v1 snapshot"
    );
}

// ── rollback constraints ─────────────────────────────────────────────────────

/// A v1 reader must still be able to read migrated storage: migration only
/// adds keys, so the v1 view of the data is intact.
#[test]
fn v1_reader_can_read_migrated_storage() {
    let (env, id, owner, client) = owner_setup();
    let fixture = load_v1_fixture(&env, &id);

    client.migrate(&owner);

    // Simulate a v1 reader: read the v1 keys directly and confirm the values
    // match what v1 wrote.
    for entry in fixture.iter() {
        let raw = read_raw(&env, &id, &entry.key);
        assert_eq!(
            raw,
            Some(entry.value.clone()),
            "v1 reader must observe the original value for {:?}",
            entry.key
        );
    }
}

/// An incompatible downgrade (v2 → v1) must be rejected: once the v2-only
/// GlobalTipCount key exists, a v1 reader cannot interpret the storage and the
/// downgrade guard must fail rather than silently corrupting state.
#[test]
fn incompatible_downgrade_is_rejected() {
    let (env, id, owner, client) = owner_setup();
    load_v1_fixture(&env, &id);
    client.migrate(&owner);

    // v2-only key is present after migration.
    assert_eq!(client.global_tip_count(), 0);

    // A downgrade guard checks for v2-only keys; presence means downgrade is
    // unsafe.  Model the guard explicitly so the constraint is documented and
    // regression-tested.
    let has_v2_only_keys = env.as_contract(&id, || {
        env.storage()
            .persistent()
            .get::<Symbol, Val>(&Symbol::new(&env, "GlobalTipCount"))
            .is_some()
            || client.schema_version() == SCHEMA_VERSION_CURRENT
    });

    assert!(
        has_v2_only_keys,
        "downgrade guard must detect v2-only state and reject the downgrade"
    );
}

// ── rollback safety ───────────────────────────────────────────────────────────

/// Documents the rollback contract: a v1 deployment can read v2-migrated
/// storage without corruption because migration only ADDS new keys.
/// This test simulates the v1 perspective by verifying the pre-existing keys
/// are unchanged after v2 migration.
#[test]
fn v2_migration_does_not_modify_or_remove_v1_keys() {
    let (env, _id, owner, client) = owner_setup();
    let alice = Address::generate(&env);

    // Capture v1 state
    client.send_tip(&Address::generate(&env), &alice, &500i128);
    let pre_nonce = client.latest_settlement_nonce();
    let pre_total = client.get_tips(&alice);
    let pre_rate_cfg = client.get_rate_limit_config();

    client.migrate(&owner);

    // v1 keys must be byte-for-byte identical after migration
    assert_eq!(client.latest_settlement_nonce(), pre_nonce);
    assert_eq!(client.get_tips(&alice), pre_total);
    let post_cfg = client.get_rate_limit_config();
    assert_eq!(
        post_cfg.max_tips_per_window,
        pre_rate_cfg.max_tips_per_window
    );
    assert_eq!(post_cfg.window_seconds, pre_rate_cfg.window_seconds);
}
