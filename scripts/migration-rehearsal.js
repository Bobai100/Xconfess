#!/usr/bin/env node
/**
 * migration-rehearsal.js
 *
 * Historical migration rehearsal for the repository. This script does a
 * lightweight dry-run pass over historical migrations to confirm that they are
 * parseable and ordered in a deterministic way before a release, without
 * invoking the actual database schema engine.
 *
 * It intentionally avoids running database migrations. It is meant to be used as
 * a safe pre-flight check for release notes, auditing, and change reviews.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIGRATION_DIRS = [
  'xconfess-backend/migrations',
  'xconfess-backend/src/migrations',
];
const DRY_RUN = process.argv.includes('--dry-run');

function isMigrationFile(name) {
  return /\.(ts|js)$/.test(name) && !name.endsWith('.spec.ts') && !name.endsWith('.spec.js');
}

function extractTimestamp(filename) {
  const match = path.basename(filename).match(/^(\d+)/);
  return match ? match[1] : '0000000000000';
}

function extractMethodOverrides(source, methodName) {
  const pattern = new RegExp(`(?:public\\s+)?(?:async\\s+)?${methodName}\\s*\\([^)]*\\)\\s*\\{`, 'm');
  return pattern.test(source);
}

function collectMigrations() {
  const migrations = [];

  for (const dir of MIGRATION_DIRS) {
    const absolute = path.join(ROOT, dir);
    if (!fs.existsSync(absolute)) continue;

    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const fileName = entry.name;
      if (!isMigrationFile(fileName)) continue;
      migrations.push({
        dir,
        fileName,
        absolute: path.join(absolute, fileName),
        timestamp: extractTimestamp(fileName),
      });
    }
  }

  migrations.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return migrations;
}

function auditMigration(migration) {
  const source = fs.readFileSync(migration.absolute, 'utf8');
  const findings = [];
  const hasUp = extractMethodOverrides(source, 'up');
  const hasDown = extractMethodOverrides(source, 'down');

  if (!hasUp) findings.push('missing up() method');
  if (!hasDown) findings.push('missing down() method');

  const rawBody = source.replace(/\/\*[\s\S]*?\*\//g, '');
  if (/DROP\s+TABLE\b|DROP\s+COLUMN\b|TRUNCATE\b/i.test(rawBody) && !rawBody.includes('@unsafe-migration-acknowledged')) {
    findings.push('destructive DDL without explicit @unsafe-migration-acknowledged mark');
  }

  if (source.includes('execute("DROP')) {
    findings.push('raw SQL drop statement present; confirm rollback/expand-contract plan');
  }

  return findings;
}

function main() {
  const migrations = collectMigrations();
  if (migrations.length === 0) {
    console.log('migration-rehearsal: no migration files found. No historical rehearsal required.');
    return;
  }

  const errors = [];
  let rehearsalCount = 0;

  for (const migration of migrations) {
    rehearsalCount += 1;
    const findings = auditMigration(migration);
    if (findings.length > 0) {
      errors.push({ migration: `${migration.dir}/${migration.fileName}`, findings });
    }
  }

  console.log(`migration-rehearsal: checked ${rehearsalCount} historical migration file(s).`);

  if (errors.length > 0) {
    console.error('\nHistorical migration rehearsal failed:');
    for (const entry of errors) {
      console.error(`  - ${entry.migration}`);
      for (const item of entry.findings) console.error(`      • ${item}`);
    }

    if (DRY_RUN) {
      console.warn('migration-rehearsal: --dry-run mode; review only, no failing exit.');
      return;
    }

    process.exitCode = 1;
    return;
  }

  console.log('migration-rehearsal: all historical migrations pass the rehearsal checks.');
}

main();
