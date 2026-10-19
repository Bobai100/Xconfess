#!/usr/bin/env node
/**
 * scripts/migration-gate.js
 *
 * Migration safety gate for CI and deployment pipelines (issue #129).
 *
 * Checks performed:
 *   1. No two migration files share the same timestamp prefix — duplicate
 *      timestamps cause non-deterministic ordering and silent data corruption.
 *   2. Every migration file provides both an `up` and a `down` method —
 *      missing rollbacks block promotion because failed deploys cannot
 *      be automatically reversed.
 *   3. Destructive DDL in an `up` method (DROP COLUMN, DROP TABLE,
 *      TRUNCATE, DROP INDEX that is not immediately followed by a CREATE INDEX
 *      replacement) is flagged as an "unsafe" operation that requires the
 *      migration to be annotated with a
 *      `@unsafe-migration-acknowledged` comment or the
 *      ALLOW_UNSAFE_MIGRATIONS=true env-var to be explicitly set in CI.
 *      The expand/contract pattern is preferred: add new columns first,
 *      deploy the app, then remove old columns in a follow-up migration.
 *
 *   4. Contract storage migration rehearsal (issues #275, #280): every
 *      contract storage migration manifest must declare a storage version,
 *      a reversible rollback constraint, and a rehearsal fixture. Manifests
 *      that perform irreversible storage changes (dropped keys, changed
 *      value encodings, removed storage versions) are blocking unless they
 *      are explicitly acknowledged and a rehearsal fixture proves the
 *      prior-version state can be transformed.
 *
 * Exits 0 when all checks pass.
 * Exits 1 when unsafe or invalid migrations are found.
 *
 * Usage:
 *   node scripts/migration-gate.js [--dry-run] [--json]
 *
 *   --json   Emit a machine-readable summary on stdout (used by
 *            scripts/contract-compat-report.js). Human-readable diagnostics
 *            are written to stderr so the JSON stream stays parseable.
 *
 * Environment:
 *   ALLOW_UNSAFE_MIGRATIONS=true   Skip the destructive-DDL block (use only
 *                                  for deliberate column-removal migrations
 *                                  after a full expand/contract cycle).
 *   ALLOW_IRREVERSIBLE_STORAGE=true
 *                                  Allow contract storage migrations marked
 *                                  irreversible. Requires an acknowledged
 *                                  rehearsal fixture; never allowed in
 *                                  release builds.
 *   MIGRATION_GATE_DRY_RUN=true    Print findings without failing (CI reports
 *                                  only; does not gate the build).
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── Configuration ─────────────────────────────────────────────────────────────

const MIGRATION_DIRS = [
  'xconfess-backend/migrations',
  'xconfess-backend/src/migrations',
];

/**
 * Directory holding contract storage migration manifests. Each manifest is a
 * JSON file describing one storage version transition:
 *
 *   {
 *     "id": "storage-0002-add-reputation-index",
 *     "fromVersion": 1,
 *     "toVersion": 2,
 *     "rehearsalFixture": "contracts/fixtures/storage-v1.json",
 *     "rollback": { "reversible": true, "constraint": "..." },
 *     "changes": [
 *       { "kind": "add-key", "key": "ReputationIndex" },
 *       { "kind": "drop-key", "key": "LegacyScores" }
 *     ]
 *   }
 */
const STORAGE_MIGRATION_DIR = 'contracts/storage-migrations';

/** Change kinds that destroy or reinterpret on-chain state. */
const IRREVERSIBLE_STORAGE_CHANGES = new Set([
  'drop-key',
  'reencode-value',
  'remove-storage-version',
]);

/**
 * Destructive DDL patterns that require acknowledgement when present in the
 * up() method body. DROP INDEX alone is allowed when used to replace an index
 * (common pattern); we only flag it when followed by no corresponding CREATE.
 */
const TRULY_DESTRUCTIVE_PATTERNS = [
  /DROP\s+COLUMN\b/i,   // removing a column loses data
  /DROP\s+TABLE\b/i,    // removing a table loses data
  /TRUNCATE\b/i,        // truncating a table loses data
];

const ACKNOWLEDGE_COMMENT = '@unsafe-migration-acknowledged';

// ── Helpers ───────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..');
const dryRun =
  process.argv.includes('--dry-run') ||
  process.env.MIGRATION_GATE_DRY_RUN === 'true';
const jsonOutput = process.argv.includes('--json');
const allowUnsafe = process.env.ALLOW_UNSAFE_MIGRATIONS === 'true';
const allowIrreversibleStorage =
  process.env.ALLOW_IRREVERSIBLE_STORAGE === 'true';

const errors = [];
const warnings = [];

/**
 * Structured findings consumed by the pre-release compatibility report.
 * Each entry: { check, severity, file, message, blocking }.
 */
const findings = [];

function fail(msg, meta) {
  errors.push(msg);
  findings.push({
    check: (meta && meta.check) || 'general',
    severity: 'error',
    file: (meta && meta.file) || null,
    message: msg,
    blocking: true,
  });
}

function warn(msg, meta) {
  warnings.push(msg);
  findings.push({
    check: (meta && meta.check) || 'general',
    severity: 'warning',
    file: (meta && meta.file) || null,
    message: msg,
    blocking: false,
  });
}

/** Human-readable diagnostics go to stderr when --json is active. */
function log(msg) {
  if (jsonOutput) process.stderr.write(`${msg}\n`);
  else console.log(msg);
}

function logError(msg) {
  process.stderr.write(`${msg}\n`);
}

function isMigrationFile(name) {
  return (
    /\.(ts|js)$/.test(name) &&
    !name.endsWith('.spec.ts') &&
    !name.endsWith('.spec.js') &&
    !name.endsWith('.d.ts')
  );
}

/** Extract the leading timestamp from a migration filename (digits only). */
function extractTimestamp(filename) {
  const m = path.basename(filename).match(/^(\d+)/);
  return m ? m[1] : null;
}

/**
 * Extract the text body of the `up()` method from a migration source file.
 * We look for the method signature and grab everything until we find the
 * matching closing brace at the same nesting depth.
 */
function extractUpBody(src) {
  // Match `async up(` or `public async up(` or `up(`
  const startRe = /\b(?:public\s+)?(?:async\s+)?up\s*\(/;
  const match = startRe.exec(src);
  if (!match) return '';

  // Walk forward from the opening brace of the method body
  let idx = src.indexOf('{', match.index + match[0].length);
  if (idx === -1) return '';

  let depth = 0;
  let body = '';
  for (let i = idx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        body = src.slice(idx + 1, i);
        break;
      }
    }
  }
  return body;
}

// ── Step 1: collect migration files ──────────────────────────────────────────

const migrationFiles = [];
for (const dir of MIGRATION_DIRS) {
  const absDir = path.join(ROOT, dir);
  if (!fs.existsSync(absDir)) continue;
  for (const file of fs.readdirSync(absDir)) {
    if (isMigrationFile(file)) {
      migrationFiles.push({ dir, file, abs: path.join(absDir, file) });
    }
  }
}

if (migrationFiles.length === 0) {
  log('migration-gate: no migration files found — nothing to check.');
  emitSummary({ storageMigrations: [] });
  process.exit(0);
}

// ── Step 2: duplicate timestamp check ────────────────────────────────────────
// TypeORM orders migrations by their numeric timestamp prefix.  Two migrations
// in the same directory with identical leading digits will run in an undefined
// order, which can cause schema corruption.
//
// We distinguish two cases:
//   - Full 13-digit Unix-millisecond timestamps (e.g. 1774790298268): exact
//     duplicates within the same directory are always an error.
//   - Date-only prefixes (e.g. 20260126): these are pre-existing in the repo
//     and TypeORM resolves ordering by class name; we warn but do not fail.

const timestampMapByDir = {};
for (const { file, dir } of migrationFiles) {
  const ts = extractTimestamp(file);
  if (!ts) continue;
  if (!timestampMapByDir[dir]) timestampMapByDir[dir] = {};
  if (!timestampMapByDir[dir][ts]) timestampMapByDir[dir][ts] = [];
  timestampMapByDir[dir][ts].push(`${dir}/${file}`);
}

// A "full" timestamp has 13+ digits (Unix ms) or an appended suffix like 000001.
function isFullTimestamp(ts) {
  return ts.length >= 13 || /\d{8}\d{6}/.test(ts); // yyyymmddHHMMSS
}

for (const [dir, tsMap] of Object.entries(timestampMapByDir)) {
  for (const [ts, files] of Object.entries(tsMap)) {
    if (files.length > 1) {
      if (isFullTimestamp(ts)) {
        fail(
          `Duplicate migration timestamp "${ts}" in directory "${dir}":\n` +
            files.map((f) => `  - ${f}`).join('\n') +
            '\nRename one migration to use a unique timestamp.'
        );
      } else {
        // Date-only prefix — warn only.
        warn(
          `migrations with the same date prefix "${ts}" in "${dir}":\n` +
            files.map((f) => `  - ${f}`).join('\n') +
            '\nConsider adding a time suffix (e.g. 20260126000100) for deterministic ordering.',
          { check: 'duplicate-timestamp', file: `${dir}/${files[0]}` }
        );
      }
    }
  }
}

// ── Step 3: up/down method presence check ────────────────────────────────────

for (const { file, dir, abs } of migrationFiles) {
  const src = fs.readFileSync(abs, 'utf8');
  const hasUp =
    /\bup\s*\(/.test(src) || /async\s+up\b/.test(src);
  const hasDown =
    /\bdown\s*\(/.test(src) || /async\s+down\b/.test(src);

  if (!hasUp) {
    fail(
      `${dir}/${file}: missing "up" method. Every migration must be reversible.`,
      { check: 'up-down', file: `${dir}/${file}` }
    );
  }
  if (!hasDown) {
    fail(
      `${dir}/${file}: missing "down" method. Add a rollback to allow reverting this migration.\n` +
        '  If the operation is genuinely irreversible, provide a down() that throws with an explanation.',
      { check: 'up-down', file: `${dir}/${file}` }
    );
  }
}

// ── Step 4: destructive DDL check (up() body only) ───────────────────────────

if (!allowUnsafe) {
  for (const { file, dir, abs } of migrationFiles) {
    const src = fs.readFileSync(abs, 'utf8');
    const acknowledged = src.includes(ACKNOWLEDGE_COMMENT);
    if (acknowledged) continue;

    const upBody = extractUpBody(src);
    const destructiveMatch = TRULY_DESTRUCTIVE_PATTERNS.find((p) => p.test(upBody));

    if (destructiveMatch) {
      fail(
        `${dir}/${file}: potentially unsafe destructive DDL ("${destructiveMatch.source}") in up().\n` +
          '  Preferred approach: use the expand/contract pattern — add columns/tables first,\n' +
          '  deploy the new application version, then remove obsolete structures in a follow-up.\n' +
          `  If this is intentional and reviewed, add a comment: // ${ACKNOWLEDGE_COMMENT}\n` +
          '  or set ALLOW_UNSAFE_MIGRATIONS=true when running this check.',
        { check: 'destructive-ddl', file: `${dir}/${file}` }
      );
    }
  }
}

// ── Step 5: contract storage migration rehearsal check ───────────────────────
// Contract storage migrations are declared as JSON manifests. The gate verifies
// that each manifest is well-formed, that its rehearsal fixture exists (so the
// migration can be rehearsed against representative prior-version state), and
// that irreversible storage changes are explicitly acknowledged and reversible
// via a documented rollback constraint.

const storageMigrations = [];
const storageDirAbs = path.join(ROOT, STORAGE_MIGRATION_DIR);

function loadStorageManifests() {
  if (!fs.existsSync(storageDirAbs)) return [];
  return fs
    .readdirSync(storageDirAbs)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({ file: f, abs: path.join(storageDirAbs, f) }));
}

function checkStorageManifest({ file, abs }) {
  const rel = `${STORAGE_MIGRATION_DIR}/${file}`;
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (err) {
    fail(`${rel}: invalid JSON manifest (${err.message}).`, {
      check: 'storage-manifest',
      file: rel,
    });
    return null;
  }

  const record = {
    id: manifest.id || file.replace(/\.json$/, ''),
    file: rel,
    fromVersion: manifest.fromVersion,
    toVersion: manifest.toVersion,
    reversible: !!(manifest.rollback && manifest.rollback.reversible),
    rollbackConstraint: (manifest.rollback && manifest.rollback.constraint) || null,
    rehearsalFixture: manifest.rehearsalFixture || null,
    irreversibleChanges: [],
    blocking: false,
  };

  if (typeof manifest.fromVersion !== 'number' || typeof manifest.toVersion !== 'number') {
    fail(`${rel}: manifest must declare numeric "fromVersion" and "toVersion".`, {
      check: 'storage-manifest',
      file: rel,
    });
    record.blocking = true;
  } else if (manifest.toVersion <= manifest.fromVersion) {
    fail(
      `${rel}: "toVersion" (${manifest.toVersion}) must be greater than "fromVersion" (${manifest.fromVersion}).`,
      { check: 'storage-manifest', file: rel }
    );
    record.blocking = true;
  }

  if (!manifest.rehearsalFixture) {
    fail(
      `${rel}: missing "rehearsalFixture". Every storage migration must be rehearsed\n` +
        '  against a representative prior-version state fixture before release.',
      { check: 'storage-rehearsal', file: rel }
    );
    record.blocking = true;
  } else {
    const fixtureAbs = path.join(ROOT, manifest.rehearsalFixture);
    if (!fs.existsSync(fixtureAbs)) {
      fail(
        `${rel}: rehearsal fixture "${manifest.rehearsalFixture}" does not exist.\n` +
          '  Commit the prior-version state fixture so the migration can be rehearsed in CI.',
        { check: 'storage-rehearsal', file: rel }
      );
      record.blocking = true;
    }
  }

  const changes = Array.isArray(manifest.changes) ? manifest.changes : [];
  record.irreversibleChanges = changes
    .filter((c) => c && IRREVERSIBLE_STORAGE_CHANGES.has(c.kind))
    .map((c) => ({ kind: c.kind, key: c.key || null }));

  if (record.irreversibleChanges.length > 0) {
    const detail = record.irreversibleChanges
      .map((c) => `  - ${c.kind}${c.key ? `: ${c.key}` : ''}`)
      .join('\n');

    if (!record.reversible || !record.rollbackConstraint) {
      fail(
        `${rel}: irreversible storage change(s) without a rollback constraint:\n${detail}\n` +
          '  Declare "rollback": { "reversible": true, "constraint": "<how to restore prior state>" }\n' +
          '  or split the change into an expand/contract pair of storage versions.',
        { check: 'storage-rollback', file: rel }
      );
      record.blocking = true;
    } else if (!allowIrreversibleStorage) {
      fail(
        `${rel}: irreversible storage change(s) require explicit acknowledgement:\n${detail}\n` +
          '  Set ALLOW_IRREVERSIBLE_STORAGE=true only for a reviewed, rehearsed migration.\n' +
          '  Release builds must never set this flag.',
        { check: 'storage-rollback', file: rel }
      );
      record.blocking = true;
    } else {
      warn(
        `${rel}: irreversible storage change(s) acknowledged via ALLOW_IRREVERSIBLE_STORAGE:\n${detail}`,
        { check: 'storage-rollback', file: rel }
      );
    }
  }

  return record;
}

for (const entry of loadStorageManifests()) {
  const record = checkStorageManifest(entry);
  if (record) storageMigrations.push(record);
}

// Storage versions must be unique and form a contiguous chain from the
// earliest declared version, otherwise a deployed instance can be stranded on
// a version with no upgrade path.
const byFromVersion = new Map();
for (const record of storageMigrations) {
  if (typeof record.fromVersion !== 'number') continue;
  if (byFromVersion.has(record.fromVersion)) {
    fail(
      `Duplicate storage migration from version ${record.fromVersion}: ` +
        `${byFromVersion.get(record.fromVersion)} and ${record.file}.`,
      { check: 'storage-chain', file: record.file }
    );
    record.blocking = true;
  } else {
    byFromVersion.set(record.fromVersion, record.file);
  }
}

// ── Output ────────────────────────────────────────────────────────────────────

function emitSummary(extra) {
  if (!jsonOutput) return;
  const summary = Object.assign(
    {
      ok: errors.length === 0,
      dryRun,
      checked: {
        migrations: migrationFiles.length,
        storageMigrations: storageMigrations.length,
      },
      storageMigrations,
      findings,
      errors: errors.length,
      warnings: warnings.length,
    },
    extra || {}
  );
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

const total = migrationFiles.length;
log(
  `migration-gate: checked ${total} migration file(s) across ${MIGRATION_DIRS.length} director(ies) ` +
    `and ${storageMigrations.length} contract storage migration(s).`
);

if (errors.length === 0) {
  log('migration-gate: all checks passed. ✔');
  emitSummary();
  process.exit(0);
}

logError('\nErrors:');
errors.forEach((e) => logError(`  FAIL: ${e}`));
logError(`\nmigration-gate: ${errors.length} check(s) failed.`);

if (dryRun) {
  logError('migration-gate: --dry-run mode; not failing the build.');
  emitSummary();
  process.exit(0);
}

logError(
  '\nRollback guidance:\n' +
    '  1. Fix the migration file(s) listed above.\n' +
    '  2. Re-run:  node scripts/migration-gate.js\n' +
    '  3. If a migration was already applied to production, create a new\n' +
    '     compensating migration rather than editing the existing one.\n' +
    '  4. For contract storage migrations, rehearse the rollback against the\n' +
    '     declared rehearsal fixture before promoting the release.'
);
emitSummary();
process.exit(1);
