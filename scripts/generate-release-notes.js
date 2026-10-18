#!/usr/bin/env node
/**
 * scripts/generate-release-notes.js
 *
 * Generate a structured release note checklist from:
 *   - Git commit messages since the last release tag
 *   - TypeORM migration filenames (schema changes)
 *   - Contract deployment manifest (Soroban changes)
 *   - Conventional commit labels (breaking, feat, fix, etc.)
 *
 * Usage:
 *   node scripts/generate-release-notes.js [options]
 *
 * Options:
 *   --from <ref>       Git ref to start from (default: last semver tag or first commit)
 *   --to <ref>         Git ref to end at (default: HEAD)
 *   --format <fmt>     Output format: markdown (default) | json | checklist
 *   --output <file>    Write to file instead of stdout
 *   --check-unreleased Fail with exit 1 if there are unreleased entries with no tag
 *   --sbom <file>      Path to SBOM/provenance manifest to validate and reference
 *   --previous-manifest <file>  Previous deployment manifest for diffing
 *   --previous-abi <file>       Previous ABI artifact for diffing
 *   --check-storage    Fail with exit 1 if contract storage compatibility has
 *                      blocking conditions (ABI removals/changes, storage
 *                      version migration required, irreversible migrations)
 *
 * Acceptance criteria (issue #134):
 *   - Notes identify breaking changes, flags, migrations, rollback constraints,
 *     and support actions
 *   - Unreleased entries are detectable (--check-unreleased flag)
 *
 * Acceptance criteria (issue #280):
 *   - Release report includes a contract storage compatibility section
 *     combining ABI diff, storage version, migration requirements, and
 *     deployment manifest differences with explicit blocking conditions
 *
 * Exit codes:
 *   0  Success
 *   1  --check-unreleased: unreleased entries found
 *   1  --sbom: malformed or missing provenance metadata
 *   1  --check-storage: blocking storage compatibility conditions found
 *   2  Usage error
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

// ── Argument parsing ─────────────────────────────────────────────────────────
function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    from: null,
    to: 'HEAD',
    format: 'markdown',
    output: null,
    checkUnreleased: false,
    sbom: null,
    previousManifest: null,
    previousAbi: null,
    checkStorage: false,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--from':           opts.from = argv[++i]; break;
      case '--to':             opts.to   = argv[++i]; break;
      case '--format':         opts.format = argv[++i]; break;
      case '--output':         opts.output = argv[++i]; break;
      case '--check-unreleased': opts.checkUnreleased = true; break;
      case '--sbom':           opts.sbom = argv[++i]; break;
      case '--previous-manifest': opts.previousManifest = argv[++i]; break;
      case '--previous-abi':   opts.previousAbi = argv[++i]; break;
      case '--check-storage':  opts.checkStorage = true; break;
      case '--help': case '-h':
        console.log(fs.readFileSync(__filename, 'utf8').split('\n')
          .filter(l => l.startsWith(' *')).map(l => l.replace(/^ \* ?/, '')).join('\n'));
        process.exit(0);
    }
  }
  return opts;
}

// ── Git helpers ──────────────────────────────────────────────────────────────
function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { cwd: REPO_ROOT, encoding: 'utf8', ...opts }).trim();
  } catch {
    return '';
  }
}

function getLastReleaseTag() {
  // Find the most recent semver tag (vX.Y.Z or X.Y.Z)
  const tags = run('git tag --sort=-version:refname').split('\n').filter(Boolean);
  return tags.find(t => /^v?\d+\.\d+\.\d+/.test(t)) || null;
}

function getCommitsSince(from, to) {
  const range = from ? `${from}..${to}` : to;
  const log = run(`git log ${range} --pretty=format:"%H|%s|%an|%ae|%aI" --no-merges`);
  if (!log) return [];
  return log.split('\n').filter(Boolean).map(line => {
    const [hash, subject, author, email, date] = line.split('|');
    return { hash: hash?.trim(), subject: subject?.trim(), author: author?.trim(), email: email?.trim(), date: date?.trim() };
  });
}

function getUnreleasedCommits() {
  // Commits on HEAD that have no tag pointing at them
  const lastTag = getLastReleaseTag();
  if (!lastTag) return getCommitsSince(null, 'HEAD');
  const tagCommit = run(`git rev-list -n1 ${lastTag}`);
  const headCommit = run('git rev-parse HEAD');
  if (tagCommit === headCommit) return [];
  return getCommitsSince(lastTag, 'HEAD');
}

// ── Conventional commit parser ───────────────────────────────────────────────
function parseConventionalCommit(subject) {
  // Match: type(scope)!: description  or  type!: description
  const match = subject.match(/^(\w+)(\([^)]+\))?(!)?\s*:\s*(.+)$/);
  if (!match) return { type: 'other', scope: null, breaking: false, description: subject };
  const [, type, scope, bang, description] = match;
  return {
    type: type.toLowerCase(),
    scope: scope ? scope.slice(1, -1) : null,
    breaking: bang === '!',
    description,
  };
}

function categorizeCommits(commits) {
  const categories = {
    breaking: [],
    feat: [],
    fix: [],
    security: [],
    perf: [],
    refactor: [],
    docs: [],
    chore: [],
    other: [],
  };

  for (const commit of commits) {
    const parsed = parseConventionalCommit(commit.subject);
    const entry = { ...commit, ...parsed };

    if (parsed.breaking || parsed.type === 'breaking') {
      categories.breaking.push(entry);
      continue;
    }
    if (parsed.type === 'feat' || parsed.type === 'feature') {
      categories.feat.push(entry);
    } else if (parsed.type === 'fix' || parsed.type === 'bugfix') {
      categories.fix.push(entry);
    } else if (parsed.type === 'security' || parsed.type === 'sec') {
      categories.security.push(entry);
    } else if (parsed.type === 'perf' || parsed.type === 'performance') {
      categories.perf.push(entry);
    } else if (parsed.type === 'refactor') {
      categories.refactor.push(entry);
    } else if (parsed.type === 'docs') {
      categories.docs.push(entry);
    } else if (parsed.type === 'chore' || parsed.type === 'ci' || parsed.type === 'build') {
      categories.chore.push(entry);
    } else {
      categories.other.push(entry);
    }
  }
  return categories;
}

// ── SBOM / provenance metadata ───────────────────────────────────────────────
const SBOM_REQUIRED_TARGETS = ['backend', 'frontend', 'contracts', 'container'];

function validateSbom(sbomPath) {
  const errors = [];
  if (!sbomPath) {
    return { ok: false, errors: ['No SBOM path provided (--sbom <file>)'] };
  }
  const abs = path.isAbsolute(sbomPath) ? sbomPath : path.join(REPO_ROOT, sbomPath);
  if (!fs.existsSync(abs)) {
    return { ok: false, errors: [`SBOM file not found: ${sbomPath}`] };
  }
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (err) {
    return { ok: false, errors: [`SBOM is not valid JSON: ${err.message}`] };
  }
  if (!doc || typeof doc !== 'object') {
    return { ok: false, errors: ['SBOM root must be an object'] };
  }
  if (!doc.spdxVersion && !doc.bomFormat && !doc.sbomVersion) {
    errors.push('SBOM missing spdxVersion, bomFormat, or sbomVersion field');
  }
  if (!doc.provenance || typeof doc.provenance !== 'object') {
    errors.push('SBOM missing provenance metadata block');
  } else {
    if (!doc.provenance.generator) errors.push('provenance.generator is required');
    if (!doc.provenance.commit) errors.push('provenance.commit is required');
    if (!doc.provenance.checksum) errors.push('provenance.checksum is required');
  }
  const targets = Array.isArray(doc.targets) ? doc.targets : [];
  const present = new Set(targets.map(t => (t && t.name) || t));
  for (const required of SBOM_REQUIRED_TARGETS) {
    if (!present.has(required)) {
      errors.push(`SBOM missing required target: ${required}`);
    }
  }
  for (const t of targets) {
    if (!t || typeof t !== 'object') continue;
    if (!Array.isArray(t.dependencies)) {
      errors.push(`target "${t.name}" missing dependencies array`);
    }
    if (!t.checksum) {
      errors.push(`target "${t.name}" missing checksum`);
    }
  }
  return { ok: errors.length === 0, errors, doc, path: abs };
}

function summarizeSbom(sbom) {
  if (!sbom || !sbom.doc) return null;
  const doc = sbom.doc;
  const targets = Array.isArray(doc.targets) ? doc.targets : [];
  return {
    path: path.relative(REPO_ROOT, sbom.path),
    generator: doc.provenance?.generator || null,
    commit: doc.provenance?.commit || null,
    checksum: doc.provenance?.checksum || null,
    targets: targets.map(t => ({
      name: t.name,
      checksum: t.checksum || null,
      dependencyCount: Array.isArray(t.dependencies) ? t.dependencies.length : 0,
    })),
  };
}

// ── Migration metadata ───────────────────────────────────────────────────────
function getMigrationMetadata() {
  const migrationsDir = path.join(REPO_ROOT, 'xconfess-backend', 'migrations');
  if (!fs.existsSync(migrationsDir)) return [];

  return fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
    .sort()
    .map(filename => {
      const fullPath = path.join(migrationsDir, filename);
      const content = fs.readFileSync(fullPath, 'utf8');
      const hasDown = /async\s+down/.test(content);
      const hasNotNull = /NOT NULL/.test(content) || /isNullable:\s*false/.test(content);
      const hasDefault = /DEFAULT\s+/.test(content) || /default:\s*/.test(content);
      const addedTables = (content.match(/createTable\(['"`]([^'"`]+)['"`]/g) || [])
        .map(m => m.match(/createTable\(['"`]([^'"`]+)['"`]/)?.[1]).filter(Boolean);
      const droppedTables = (content.match(/dropTable\(['"`]([^'"`]+)['"`]/g) || [])
        .map(m => m.match(/dropTable\(['"`]([^'"`]+)['"`]/)?.[1]).filter(Boolean);
      const addedColumns = (content.match(/addColumn\(['"`]([^'"`]+)['"`]/g) || [])
        .map(m => m.match(/addColumn\(['"`]([^'"`]+)['"`]/)?.[1]).filter(Boolean);

      return {
        filename,
        hasDown,
        hasNotNull,
        hasDefault,
        addedTables,
        droppedTables,
        addedColumns,
        rollbackRisk: hasNotNull && !hasDefault && addedColumns.length > 0,
        rollbackNote: !hasDown ? 'No down() method — migration is irreversible' : null,
      };
    });
}

// ── Contract metadata ─────────────────────────────────────────────────────────
function getContractMetadata() {
  const manifestPath = path.join(REPO_ROOT, 'deployments', 'testnet.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

// ── Contract storage compatibility report ────────────────────────────────────
// Combines ABI diff, storage version, migration requirements, and deployment
// manifest differences into a single pre-release report with explicit
// blocking conditions. Inputs are read from the deployment manifest and the
// generated ABI artifacts; missing inputs are reported as blocking so a
// release cannot silently ship without storage compatibility evidence.
const CONTRACT_ARTIFACTS_DIR = path.join(REPO_ROOT, 'contracts', 'artifacts');
const CONTRACT_STORAGE_VERSION_FILE = path.join(REPO_ROOT, 'contracts', 'storage-version.json');

function readJsonIfExists(absPath) {
  if (!fs.existsSync(absPath)) return { exists: false, doc: null, error: null };
  try {
    return { exists: true, doc: JSON.parse(fs.readFileSync(absPath, 'utf8')), error: null };
  } catch (err) {
    return { exists: true, doc: null, error: err.message };
  }
}

function normalizeAbiEntries(abi) {
  // Accept either a raw array of entries or an object with an `entries` field.
  const entries = Array.isArray(abi) ? abi : (abi && Array.isArray(abi.entries) ? abi.entries : []);
  return entries
    .filter(e => e && typeof e === 'object')
    .map(e => ({
      kind: e.kind || e.type || 'unknown',
      name: e.name || null,
      inputs: Array.isArray(e.inputs) ? e.inputs.map(i => `${i.name || ''}:${i.type || ''}`) : [],
      outputs: Array.isArray(e.outputs) ? e.outputs.map(o => o.type || '') : [],
    }))
    .sort((a, b) => `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`));
}

function diffAbi(previousAbi, currentAbi) {
  const prev = normalizeAbiEntries(previousAbi);
  const curr = normalizeAbiEntries(currentAbi);
  const key = e => `${e.kind}:${e.name}`;
  const prevMap = new Map(prev.map(e => [key(e), e]));
  const currMap = new Map(curr.map(e => [key(e), e]));

  const added = [];
  const removed = [];
  const changed = [];
  for (const [k, e] of currMap) {
    if (!prevMap.has(k)) {
      added.push(e);
    } else {
      const before = prevMap.get(k);
      if (JSON.stringify(before.inputs) !== JSON.stringify(e.inputs) ||
          JSON.stringify(before.outputs) !== JSON.stringify(e.outputs)) {
        changed.push({ before, after: e });
      }
    }
  }
  for (const [k, e] of prevMap) {
    if (!currMap.has(k)) removed.push(e);
  }
  return { added, removed, changed, hasChanges: added.length + removed.length + changed.length > 0 };
}

function diffManifests(previousManifest, currentManifest) {
  const prevContracts = (previousManifest && previousManifest.contracts) || {};
  const currContracts = (currentManifest && currentManifest.contracts) || {};
  const added = [];
  const removed = [];
  const changed = [];
  for (const name of Object.keys(currContracts)) {
    if (!(name in prevContracts)) {
      added.push(name);
    } else if (JSON.stringify(prevContracts[name]) !== JSON.stringify(currContracts[name])) {
      changed.push(name);
    }
  }
  for (const name of Object.keys(prevContracts)) {
    if (!(name in currContracts)) removed.push(name);
  }
  const networkChanged = (previousManifest?.network || null) !== (currentManifest?.network || null);
  return { added, removed, changed, networkChanged, hasChanges: added.length + removed.length + changed.length > 0 || networkChanged };
}

function buildContractStorageReport(opts = {}) {
  const blocking = [];
  const warnings = [];

  const currentManifest = getContractMetadata();
  if (!currentManifest) {
    blocking.push('Deployment manifest `deployments/testnet.json` is missing or unreadable.');
  }

  const previousManifestPath = opts.previousManifest
    ? (path.isAbsolute(opts.previousManifest) ? opts.previousManifest : path.join(REPO_ROOT, opts.previousManifest))
    : null;
  let previousManifest = null;
  if (previousManifestPath) {
    const read = readJsonIfExists(previousManifestPath);
    if (read.error) {
      blocking.push(`Previous deployment manifest is not valid JSON: ${read.error}`);
    } else if (!read.exists) {
      blocking.push(`Previous deployment manifest not found: ${opts.previousManifest}`);
    } else {
      previousManifest = read.doc;
    }
  } else {
    warnings.push('No previous deployment manifest supplied (--previous-manifest <file>); manifest diff skipped.');
  }

  const manifestDiff = previousManifest && currentManifest
    ? diffManifests(previousManifest, currentManifest)
    : null;

  // Storage version
  const storageRead = readJsonIfExists(CONTRACT_STORAGE_VERSION_FILE);
  let storageVersion = null;
  let previousStorageVersion = null;
  if (storageRead.error) {
    blocking.push(`Storage version file is not valid JSON: ${storageRead.error}`);
  } else if (!storageRead.exists) {
    blocking.push('Storage version file `contracts/storage-version.json` is missing.');
  } else {
    storageVersion = storageRead.doc?.version ?? null;
    previousStorageVersion = storageRead.doc?.previousVersion ?? null;
    if (storageVersion === null) {
      blocking.push('Storage version file is missing a `version` field.');
    }
    if (previousStorageVersion !== null && storageVersion !== null && previousStorageVersion !== storageVersion) {
      const migrationRequired = storageRead.doc?.migrationRequired !== false;
      if (migrationRequired) {
        blocking.push(
          `Storage version changed (${previousStorageVersion} → ${storageVersion}) and requires a migration. ` +
          'Provide a migration plan and set `migrationRequired: false` only after it is applied.'
        );
      } else {
        warnings.push(`Storage version changed (${previousStorageVersion} → ${storageVersion}) with migrationRequired=false.`);
      }
    }
  }

  // ABI diff
  const currentAbiPath = path.join(CONTRACT_ARTIFACTS_DIR, 'abi.json');
  const previousAbiPath = opts.previousAbi
    ? (path.isAbsolute(opts.previousAbi) ? opts.previousAbi : path.join(REPO_ROOT, opts.previousAbi))
    : path.join(CONTRACT_ARTIFACTS_DIR, 'abi.previous.json');

  const currentAbiRead = readJsonIfExists(currentAbiPath);
  if (currentAbiRead.error) {
    blocking.push(`Current ABI artifact is not valid JSON: ${currentAbiRead.error}`);
  } else if (!currentAbiRead.exists) {
    blocking.push('Current ABI artifact `contracts/artifacts/abi.json` is missing.');
  }

  let abiDiff = null;
  if (currentAbiRead.exists && !currentAbiRead.error) {
    const previousAbiRead = readJsonIfExists(previousAbiPath);
    if (previousAbiRead.error) {
      blocking.push(`Previous ABI artifact is not valid JSON: ${previousAbiRead.error}`);
    } else if (!previousAbiRead.exists) {
      warnings.push('No previous ABI artifact found; ABI diff skipped.');
    } else {
      abiDiff = diffAbi(previousAbiRead.doc, currentAbiRead.doc);
      if (abiDiff.removed.length > 0) {
        blocking.push(
          `ABI removed ${abiDiff.removed.length} entry(ies): ` +
          abiDiff.removed.map(e => `${e.kind}:${e.name || '(anonymous)'}`).join(', ')
        );
      }
      if (abiDiff.changed.length > 0) {
        blocking.push(
          `ABI changed ${abiDiff.changed.length} entry(ies): ` +
          abiDiff.changed.map(c => `${c.after.kind}:${c.after.name || '(anonymous)'}`).join(', ')
        );
      }
    }
  }

  // Migration requirements
  const migrations = getMigrationMetadata();
  const irreversible = migrations.filter(m => m.rollbackNote);
  const risky = migrations.filter(m => m.rollbackRisk);
  if (irreversible.length > 0) {
    blocking.push(
      `${irreversible.length} migration(s) have no down() method: ` +
      irreversible.map(m => m.filename).join(', ')
    );
  }
  if (risky.length > 0) {
    warnings.push(
      `${risky.length} migration(s) add NOT NULL columns without defaults: ` +
      risky.map(m => m.filename).join(', ')
    );
  }

  return {
    ok: blocking.length === 0,
    blocking,
    warnings,
    storageVersion,
    previousStorageVersion,
    abiDiff,
    manifestDiff,
    migrations: {
      total: migrations.length,
      irreversible: irreversible.map(m => m.filename),
      risky: risky.map(m => m.filename),
    },
  };
}

function renderContractStorageReport(report) {
  const lines = [];
  lines.push(`## 🧱 Contract Storage Compatibility`);
  lines.push('');
  lines.push(`Status: ${report.ok ? '✅ no blocking conditions' : '❌ BLOCKING conditions present'}`);
  lines.push('');

  lines.push('### Storage version');
  if (report.storageVersion === null) {
    lines.push('- _unknown (storage-version.json missing or invalid)_');
  } else {
    lines.push(`- Current: \`${report.storageVersion}\``);
    lines.push(`- Previous: \`${report.previousStorageVersion ?? '(none)'}\``);
  }
  lines.push('');

  lines.push('### ABI diff');
  if (!report.abiDiff) {
    lines.push('- _ABI diff unavailable (missing previous or current artifact)_');
  } else if (!report.abiDiff.hasChanges) {
    lines.push('- No ABI changes detected.');
  } else {
    if (report.abiDiff.added.length) {
      lines.push(`- Added: ${report.abiDiff.added.map(e => `\`${e.kind}:${e.name || '(anonymous)'}\``).join(', ')}`);
    }
    if (report.abiDiff.removed.length) {
      lines.push(`- Removed: ${report.abiDiff.removed.map(e => `\`${e.kind}:${e.name || '(anonymous)'}\``).join(', ')} ⚠️`);
    }
    if (report.abiDiff.changed.length) {
      lines.push(`- Changed: ${report.abiDiff.changed.map(c => `\`${c.after.kind}:${c.after.name || '(anonymous)'}\``).join(', ')} ⚠️`);
    }
  }
  lines.push('');

  lines.push('### Migration requirements');
  lines.push(`- Total migrations: ${report.migrations.total}`);
  if (report.migrations.irreversible.length) {
    lines.push(`- Irreversible (no down()): ${report.migrations.irreversible.map(f => `\`${f}\``).join(', ')}`);
  }
  if (report.migrations.risky.length) {
    lines.push(`- Rollback risk (NOT NULL without default): ${report.migrations.risky.map(f => `\`${f}\``).join(', ')}`);
  }
  lines.push('');

  lines.push('### Deployment manifest diff');
  if (!report.manifestDiff) {
    lines.push('- _Manifest diff unavailable (no previous manifest supplied)_');
  } else if (!report.manifestDiff.hasChanges) {
    lines.push('- No manifest changes detected.');
  } else {
    if (report.manifestDiff.networkChanged) lines.push('- Network changed ⚠️');
    if (report.manifestDiff.added.length) lines.push(`- Added contracts: ${report.manifestDiff.added.join(', ')}`);
    if (report.manifestDiff.removed.length) lines.push(`- Removed contracts: ${report.manifestDiff.removed.join(', ')} ⚠️`);
    if (report.manifestDiff.changed.length) lines.push(`- Changed contracts: ${report.manifestDiff.changed.join(', ')}`);
  }
  lines.push('');

  lines.push('### Blocking conditions');
  if (report.blocking.length === 0) {
    lines.push('- None.');
  } else {
    for (const b of report.blocking) lines.push(`- [ ] ${b}`);
  }
  if (report.warnings.length > 0) {
    lines.push('');
    lines.push('### Warnings');
    for (const w of report.warnings) lines.push(`- ${w}`);
  }
  lines.push('');
  return lines.join('\n');
}

// ── Feature flag scan ─────────────────────────────────────────────────────────
function getFeatureFlags() {
  // Scan for feature flag references in the codebase
  const flags = new Set();
  const searchDirs = [
    path.join(REPO_ROOT, 'xconfess-backend', 'src'),
    path.join(REPO_ROOT, 'xconfess-frontend', 'app'),
  ];
  function scan(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && !['node_modules', 'dist', '.next', '__tests__'].includes(entry.name)) {
        scan(full);
      } else if (entry.isFile() && /\.(ts|tsx|js)$/.test(entry.name) && !entry.name.includes('.spec.')) {
        try {
          const content = fs.readFileSync(full, 'utf8');
          // Match feature flag reads: isEnabled('flag-name') or featureFlags.flag_name
          const matches = [
            ...content.matchAll(/isEnabled\(['"`]([^'"`]+)['"`]\)/g),
            ...content.matchAll(/STELLAR_FEATURES_ENABLED/g),
          ];
          for (const m of matches) {
            flags.add(m[1] || 'STELLAR_FEATURES_ENABLED');
          }
        } catch { /* ignore unreadable files */ }
      }
    }
  }
  searchDirs.forEach(scan);
  return [...flags];
}

// ── Report generation ─────────────────────────────────────────────────────────
function generateMarkdown(opts, commits, categories, migrations, contractMeta, featureFlags, sbom, storageReport) {
  const lines = [];
  const now = new Date().toISOString().split('T')[0];
  const lastTag = getLastReleaseTag();
  const commitCount = commits.length;

  lines.push(`# Release Notes`);
  lines.push(`\nGenerated: ${now}`);
  lines.push(`Base ref: ${opts.from || lastTag || '(first commit)'}`);
  lines.push(`Head ref: ${opts.to}`);
  lines.push(`Commits: ${commitCount}`);
  lines.push('');

  // ── Breaking changes ──────────────────────────────────────────────────────
  lines.push(`## ⚠️ Breaking Changes`);
  if (categories.breaking.length > 0) {
    for (const c of categories.breaking) {
      lines.push(`- **${c.scope ? `${c.scope}: ` : ''}${c.description}** (\`${c.hash?.slice(0,8)}\`)`);
    }
    lines.push('');
    lines.push('> **Support action required:** Notify users and update integration documentation before deployment.');
  } else {
    lines.push('_No breaking changes in this range._');
  }
  lines.push('');

  // ── Feature flags ─────────────────────────────────────────────────────────
  lines.push(`## 🚩 Feature Flags`);
  if (featureFlags.length > 0) {
    lines.push('The following feature flags are referenced in this codebase:');
    for (const flag of featureFlags) {
      lines.push(`- [ ] \`${flag}\` — verify flag state matches deployment intent`);
    }
  } else {
    lines.push('_No feature flags detected._');
  }
  lines.push('');

  // ── Schema migrations ─────────────────────────────────────────────────────
  lines.push(`## 🗄️ Database Migrations`);
  if (migrations.length > 0) {
    lines.push(`${migrations.length} migration file(s) in \`xconfess-backend/migrations/\`:`);
    lines.push('');
    for (const m of migrations) {
      const risk = m.rollbackRisk ? ' ⚠️ **rollback risk**' : '';
      const irreversible = m.rollbackNote ? ` 🔒 ${m.rollbackNote}` : '';
      lines.push(`- \`${m.filename}\`${risk}${irreversible}`);
      if (m.addedTables.length) lines.push(`  - Creates tables: ${m.addedTables.join(', ')}`);
      if (m.droppedTables.length) lines.push(`  - Drops tables: ${m.droppedTables.join(', ')} ⚠️ irreversible data loss`);
      if (m.addedColumns.length) lines.push(`  - Adds columns on: ${m.addedColumns.join(', ')}`);
    }
    lines.push('');
    lines.push('**Rollback constraints:**');
    lines.push('- Dropped tables cannot be recreated without a DB restore');
    lines.push('- NOT NULL columns without DEFAULT prevent rollback to previous app version');
    lines.push('- Run `npm run backend:migration:show` to verify migration state before deploy');
  } else {
    lines.push('_No migrations detected._');
  }
  lines.push('');

  // ── Contract changes ──────────────────────────────────────────────────────
  lines.push(`## ⛓️ Contract Changes`);
  if (contractMeta) {
    lines.push(`Network: \`${contractMeta.network || 'testnet'}\``);
    lines.push(`Deployed at: ${contractMeta.deployedAt || 'unknown'}`);
    if (contractMeta.contracts) {
      for (const [name, info] of Object.entries(contractMeta.contracts)) {
        lines.push(`- \`${name}\`: ${typeof info === 'string' ? info : JSON.stringify(info)}`);
      }
    }
    lines.push('');
    lines.push('**Rollback constraint:** Soroban contracts are immutable. Rollback = forward-fix upgrade.');
  } else {
    lines.push('_No contract deployment manifest found at `deployments/testnet.json`._');
  }
  lines.push('');

  // ── Contract storage compatibility ────────────────────────────────────────
  if (storageReport) {
    lines.push(renderContractStorageReport(storageReport));
  }

  // ── SBOM / provenance ─────────────────────────────────────────────────────
  lines.push(`## 📦 SBOM & Provenance`);
  if (sbom && sbom.doc) {
    const summary = summarizeSbom(sbom);
    lines.push(`Manifest: \`${summary.path}\``);
    lines.push(`Generator: \`${summary.generator}\``);
    lines.push(`Commit: \`${summary.commit}\``);
    lines.push(`Checksum: \`${summary.checksum}\``);
    lines.push('');
    lines.push('Artifacts covered:');
    for (const t of summary.targets) {
      lines.push(`- \`${t.name}\` — ${t.dependencyCount} transitive dep(s), checksum \`${t.checksum}\``);
    }
    lines.push('');
    lines.push('> Attach the SBOM artifact to the GitHub release alongside these notes.');
  } else {
    lines.push('_No SBOM manifest provided. Pass `--sbom <file>` to include provenance._');
  }
  lines.push('');

  // ── Features ──────────────────────────────────────────────────────────────
  if (categories.feat.length > 0) {
    lines.push(`## ✨ New Features`);
    for (const c of categories.feat) {
      lines.push(`- ${c.scope ? `**${c.scope}:** ` : ''}${c.description} (\`${c.hash?.slice(0,8)}\`)`);
    }
    lines.push('');
  }

  // ── Bug fixes ─────────────────────────────────────────────────────────────
  if (categories.fix.length > 0) {
    lines.push(`## 🐛 Bug Fixes`);
    for (const c of categories.fix) {
      lines.push(`- ${c.scope ? `**${c.scope}:** ` : ''}${c.description} (\`${c.hash?.slice(0,8)}\`)`);
    }
    lines.push('');
  }

  // ── Security ──────────────────────────────────────────────────────────────
  if (categories.security.length > 0) {
    lines.push(`## 🔒 Security`);
    for (const c of categories.security) {
      lines.push(`- ${c.description} (\`${c.hash?.slice(0,8)}\`)`);
    }
    lines.push('');
  }

  // ── Release checklist ─────────────────────────────────────────────────────
  lines.push(`## ✅ Release Checklist`);
  lines.push('');
  lines.push('Before shipping:');
  lines.push('- [ ] `npm run ci` passes (lint, typecheck, build, tests)');
  lines.push('- [ ] `npm run readiness:test` passes');
  lines.push('- [ ] `npm run secret-scan` passes');
  lines.push('- [ ] All breaking changes documented above');
  lines.push('- [ ] Migration `down()` methods verified for each migration above');
  lines.push('- [ ] Feature flags set correctly for target environment');
  lines.push('- [ ] Contract deployment manifest updated if contracts changed');
  lines.push('- [ ] Support team notified of any user-visible changes');
  lines.push('- [ ] Rollback procedure confirmed (see `docs/disaster-recovery-runbook.md`)');
  lines.push('- [ ] SBOM artifact generated, validated, and attached to the release');
  if (storageReport) {
    if (storageReport.ok) {
      lines.push('- [ ] Contract storage compatibility report reviewed (no blocking conditions)');
    } else {
      lines.push('- [ ] **BLOCKING**: Contract storage compatibility conditions resolved');
      for (const b of storageReport.blocking) lines.push(`  - [ ] ${b}`);
    }
  }
  if (categories.breaking.length > 0) {
    lines.push('- [ ] **BREAKING**: Customer notification sent before deploy');
    lines.push('- [ ] **BREAKING**: Integration documentation updated');
  }
  lines.push('');

  // ── Unreleased detection ──────────────────────────────────────────────────
  const unreleased = getUnreleasedCommits();
  if (unreleased.length > 0 && opts.checkUnreleased) {
    lines.push(`## 🔖 Unreleased Entries`);
    lines.push(`${unreleased.length} commit(s) not yet covered by a release tag:`);
    for (const c of unreleased.slice(0, 10)) {
      lines.push(`- \`${c.hash?.slice(0,8)}\` ${c.subject}`);
    }
    if (unreleased.length > 10) lines.push(`  ...and ${unreleased.length - 10} more`);
    lines.push('');
  }

  return lines.join('\n');
}

function generateJson(opts, commits, categories, migrations, contractMeta, featureFlags, sbom, storageReport) {
  return JSON.stringify({
    generated: new Date().toISOString(),
    from: opts.from,
    to: opts.to,
    commitCount: commits.length,
    breaking: categories.breaking.map(c => ({ hash: c.hash, description: c.description, scope: c.scope })),
    features: categories.feat.map(c => ({ hash: c.hash, description: c.description, scope: c.scope })),
    fixes: categories.fix.map(c => ({ hash: c.hash, description: c.description, scope: c.scope })),
    migrations: migrations.map(m => ({
      filename: m.filename,
      rollbackRisk: m.rollbackRisk,
      rollbackNote: m.rollbackNote,
      addedTables: m.addedTables,
      droppedTables: m.droppedTables,
    })),
    contracts: contractMeta,
    featureFlags,
    sbom: summarizeSbom(sbom),
    contractStorage: storageReport
      ? {
          ok: storageReport.ok,
          blocking: storageReport.blocking,
          warnings: storageReport.warnings,
          storageVersion: storageReport.storageVersion,
          previousStorageVersion: storageReport.previousStorageVersion,
          abiDiff: storageReport.abiDiff,
          manifestDiff: storageReport.manifestDiff,
          migrations: storageReport.migrations,
        }
      : null,
    hasUnreleased: getUnreleasedCommits().length > 0,
  }, null, 2);
}

function generateChecklist(opts, commits, categories, migrations, contractMeta, featureFlags, sbom, storageReport) {
  const checks = [];
  const hasBreaking = categories.breaking.length > 0;
  const hasMigrations = migrations.length > 0;
  const hasContracts = !!contractMeta;
  const hasRiskyMigrations = migrations.some(m => m.rollbackRisk);
  const hasIrreversibleMigrations = migrations.some(m => m.rollbackNote);
  const hasUnreleased = getUnreleasedCommits().length > 0;

  checks.push(`Release checklist (generated ${new Date().toISOString().split('T')[0]})`);
  checks.push('');
  checks.push('[ ] npm run ci passes');
  checks.push('[ ] npm run readiness:test passes');
  checks.push('[ ] npm run secret-scan passes');
  if (hasBreaking) {
    checks.push('[!] BREAKING CHANGES present — notify customers before deploy');
    checks.push('[!] Integration docs updated for breaking changes');
    for (const c of categories.breaking) {
      checks.push(`    [ ] ${c.description}`);
    }
  }
  if (hasMigrations) {
    checks.push(`[ ] ${migrations.length} migration(s) reviewed`);
    if (hasRiskyMigrations) checks.push('[!] Risky NOT NULL migrations — verify backfill or accept rollback constraint');
    if (hasIrreversibleMigrations) checks.push('[!] Irreversible migrations present — no down() method');
    checks.push('[ ] npm run backend:migration:show confirms expected state');
  }
  if (hasContracts) {
    checks.push('[ ] Contract manifest reviewed');
    checks.push('[!] Soroban contracts are irreversible — forward-fix only');
  }
  if (storageReport) {
    if (storageReport.ok) {
      checks.push('[ ] Contract storage compatibility report reviewed (no blocking conditions)');
    } else {
      checks.push('[!] BLOCKING: contract storage compatibility conditions must be resolved');
      for (const b of storageReport.blocking) checks.push(`    [ ] ${b}`);
    }
    for (const w of storageReport.warnings) checks.push(`    [~] ${w}`);
  }
  if (featureFlags.length > 0) {
    checks.push(`[ ] Feature flags verified for target environment: ${featureFlags.join(', ')}`);
  }
  if (sbom && sbom.doc) {
    checks.push(`[ ] SBOM validated (${summarizeSbom(sbom).targets.length} target(s))`);
    checks.push('[ ] SBOM artifact attached to release');
  } else {
    checks.push('[!] SBOM missing — pass --sbom <file> before shipping');
  }
  if (hasUnreleased) {
    checks.push('[!] Unreleased commits detected — create a release tag before shipping');
  }
  checks.push('[ ] Rollback procedure confirmed (docs/disaster-recovery-runbook.md)');
  return checks.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  const opts = parseArgs();

  const lastTag = getLastReleaseTag();
  if (!opts.from) opts.from = lastTag;

  const commits = getCommitsSince(opts.from, opts.to);
  const categories = categorizeCommits(commits);
  const migrations = getMigrationMetadata();
  const contractMeta = getContractMetadata();
  const featureFlags = getFeatureFlags();

  let sbom = null;
  if (opts.sbom) {
    sbom = validateSbom(opts.sbom);
    if (!sbom.ok) {
      console.error('FAIL: SBOM provenance validation failed:');
      for (const err of sbom.errors) console.error(`  - ${err}`);
      process.exit(1);
    }
  }

  const storageReport = buildContractStorageReport({
    previousManifest: opts.previousManifest,
    previousAbi: opts.previousAbi,
  });

  let output;
  switch (opts.format) {
    case 'json':
      output = generateJson(opts, commits, categories, migrations, contractMeta, featureFlags, sbom, storageReport);
      break;
    case 'checklist':
      output = generateChecklist(opts, commits, categories, migrations, contractMeta, featureFlags, sbom, storageReport);
      break;
    case 'markdown':
    default:
      output = generateMarkdown(opts, commits, categories, migrations, contractMeta, featureFlags, sbom, storageReport);
      break;
  }

  if (opts.output) {
    fs.mkdirSync(path.dirname(opts.output), { recursive: true });
    fs.writeFileSync(opts.output, output, 'utf8');
    console.error(`Release notes written to: ${opts.output}`);
  } else {
    console.log(output);
  }

  // --check-unreleased: fail if commits exist that aren't tagged
  if (opts.checkUnreleased) {
    const unreleased = getUnreleasedCommits();
    if (unreleased.length > 0) {
      console.error(`\nFAIL: ${unreleased.length} unreleased commit(s) detected. Create a release tag before shipping.`);
      process.exit(1);
    }
  }

  // --check-storage: fail if contract storage compatibility has blocking conditions
  if (opts.checkStorage) {
    if (!storageReport.ok) {
      console.error('\nFAIL: contract storage compatibility has blocking conditions:');
      for (const b of storageReport.blocking) console.error(`  - ${b}`);
      process.exit(1);
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  parseConventionalCommit,
  categorizeCommits,
  validateSbom,
  summarizeSbom,
  getMigrationMetadata,
  getContractMetadata,
  diffAbi,
  diffManifests,
  buildContractStorageReport,
  renderContractStorageReport,
  generateMarkdown,
  generateJson,
  generateChecklist,
};
