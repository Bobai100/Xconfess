#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const POLICY_PATH = path.join(ROOT, 'dependency-license-policy.json');
const ALLOWED_LICENSES = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
]);

function parseArgs(argv) {
  const options = { base: null, output: path.join(ROOT, 'dependency-policy-report.json') };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base') {
      options.base = argv[++index];
      if (!options.base || options.base.startsWith('--')) throw new Error('--base requires a Git ref.');
    } else if (arg === '--output') {
      const output = argv[++index];
      if (!output || output.startsWith('--')) throw new Error('--output requires a file path.');
      options.output = path.resolve(ROOT, output);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function packageNameFromLockPath(lockPath) {
  const marker = lockPath.lastIndexOf('node_modules/');
  if (marker < 0) return null;
  const parts = lockPath.slice(marker + 'node_modules/'.length).split('/');
  return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

function runtimePackages(lock) {
  const packages = new Map();
  for (const [lockPath, entry] of Object.entries(lock.packages || {})) {
    if (!lockPath || !lockPath.includes('node_modules/') || entry.dev === true || entry.devOptional === true) continue;
    const name = packageNameFromLockPath(lockPath);
    if (!name || !entry.version) continue;
    const identity = `${name}@${entry.version}`;
    if (!packages.has(identity)) {
      packages.set(identity, {
        name,
        version: entry.version,
        license: typeof entry.license === 'string' ? entry.license : null,
      });
    }
  }
  return packages;
}

function directRuntimeNames(lock) {
  const names = new Set();
  for (const [lockPath, entry] of Object.entries(lock.packages || {})) {
    if (lockPath.includes('node_modules/')) continue;
    for (const field of ['dependencies', 'optionalDependencies']) {
      for (const name of Object.keys(entry[field] || {})) names.add(name);
    }
  }
  return names;
}

function splitTopLevel(expression, operator) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index <= expression.length - operator.length; index += 1) {
    if (expression[index] === '(') depth += 1;
    else if (expression[index] === ')') depth -= 1;
    else if (depth === 0 && expression.startsWith(operator, index)) {
      parts.push(expression.slice(start, index).trim());
      start = index + operator.length;
      index += operator.length - 1;
    }
  }
  if (parts.length === 0) return [expression.trim()];
  parts.push(expression.slice(start).trim());
  return parts;
}

function stripOuterParentheses(expression) {
  let value = expression.trim();
  while (value.startsWith('(') && value.endsWith(')')) {
    let depth = 0;
    let wrapsAll = true;
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] === '(') depth += 1;
      else if (value[index] === ')') depth -= 1;
      if (depth === 0 && index < value.length - 1) {
        wrapsAll = false;
        break;
      }
    }
    if (!wrapsAll) break;
    value = value.slice(1, -1).trim();
  }
  return value;
}

function licenseIsAllowed(expression) {
  if (typeof expression !== 'string' || !expression.trim()) return false;
  const value = stripOuterParentheses(expression);
  const alternatives = splitTopLevel(value, ' OR ');
  if (alternatives.length > 1) return alternatives.some(licenseIsAllowed);
  const requirements = splitTopLevel(value, ' AND ');
  if (requirements.length > 1) return requirements.every(licenseIsAllowed);
  return ALLOWED_LICENSES.has(value);
}

function activeRecord(records, pkg, changeClass, now) {
  return records.find((record) =>
    record.package === pkg.name &&
    record.version === pkg.version &&
    record.changeClass === changeClass &&
    record.license === pkg.license &&
    record.reason &&
    record.issue &&
    Number.isFinite(Date.parse(record.expires)) &&
    Date.parse(record.expires) >= now,
  );
}

function classifyChanges(currentLock, baseLock, policy, now = Date.now()) {
  const current = runtimePackages(currentLock);
  const previous = runtimePackages(baseLock);
  const directNames = directRuntimeNames(currentLock);
  const previousNames = new Set([...previous.values()].map((pkg) => pkg.name));
  const currentNames = new Set([...current.values()].map((pkg) => pkg.name));
  const findings = [];
  const changes = [];

  for (const [identity, pkg] of current) {
    const oldPackage = previous.get(identity);
    let changeClass = null;
    if (!oldPackage) {
      changeClass = previousNames.has(pkg.name)
        ? 'runtime-version-change'
        : directNames.has(pkg.name)
          ? 'runtime-direct-added'
          : 'runtime-transitive-added';
    } else if (oldPackage.license !== pkg.license) {
      changeClass = 'runtime-license-change';
    }

    const licenseException = (policy.licenseExceptions || []).find((record) =>
      record.package === pkg.name &&
      record.version === pkg.version &&
      record.license === pkg.license &&
      record.reason &&
      record.issue &&
      Number.isFinite(Date.parse(record.expires)) &&
      Date.parse(record.expires) >= now,
    );
    const licenseAllowed = licenseIsAllowed(pkg.license) || Boolean(licenseException);
    const changeApproval = changeClass
      ? activeRecord(policy.changeApprovals || [], pkg, changeClass, now)
      : null;

    if (changeClass) {
      changes.push({
        ...pkg,
        changeClass,
        approved: Boolean(changeApproval),
        approval: changeApproval
          ? { issue: changeApproval.issue, reason: changeApproval.reason, expires: changeApproval.expires }
          : null,
      });
    }

    if (!licenseAllowed && changeClass) {
      findings.push({
        code: 'disallowed-or-unknown-license',
        package: pkg.name,
        version: pkg.version,
        license: pkg.license,
        remediation: 'Use an allowed license or add a package/version/license-specific exception with a reason, issue, and future expiry after legal review.',
      });
    } else if (!licenseAllowed) {
      findings.push({
        code: 'preexisting-license-review',
        package: pkg.name,
        version: pkg.version,
        license: pkg.license,
        blocking: false,
        remediation: 'Review this unchanged baseline dependency and add an exact, time-limited license exception after legal review, or replace it.',
      });
    }
    if (changeClass && !changeApproval) {
      findings.push({
        code: 'unreviewed-runtime-change',
        package: pkg.name,
        version: pkg.version,
        license: pkg.license,
        changeClass,
        remediation: 'Review the production dependency change and add an exact package/version/license/change-class approval with a reason, tracking issue, and future expiry.',
      });
    }
  }

  for (const pkg of previous.values()) {
    if (!currentNames.has(pkg.name)) {
      findings.push({
        code: 'runtime-package-removed',
        package: pkg.name,
        version: pkg.version,
        license: pkg.license,
        changeClass: 'runtime-removed',
        blocking: false,
      });
      changes.push({
        ...pkg,
        changeClass: 'runtime-removed',
        approved: true,
        approval: null,
      });
    }
  }

  return {
    packages: [...current.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)),
    changes: changes.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)),
    findings,
  };
}

function readBaseLock(ref) {
  try {
    return JSON.parse(execFileSync('git', ['show', `${ref}:package-lock.json`], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
  } catch {
    throw new Error(`Cannot read package-lock.json at base ref "${ref}". Fetch the base branch or pass a valid --base ref.`);
  }
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const currentLock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const policy = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
  const base = options.base || 'HEAD^';
  const result = classifyChanges(currentLock, readBaseLock(base), policy);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    baseRef: base,
    policy: path.basename(POLICY_PATH),
    allowedLicenses: [...ALLOWED_LICENSES].sort(),
    runtimePackageCount: result.packages.length,
    packages: result.packages,
    changes: result.changes,
    findings: result.findings,
    status: result.findings.some((finding) => finding.blocking !== false) ? 'blocked' : 'passed',
  };

  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Dependency policy report: ${path.relative(ROOT, options.output)}`);
  console.log(`Runtime dependencies: ${report.runtimePackageCount}`);
  console.log(`Policy findings: ${report.findings.filter((finding) => finding.blocking !== false).length}`);
  if (report.status === 'blocked') {
    for (const finding of report.findings.filter((item) => item.blocking !== false)) {
      console.error(`- ${finding.package}@${finding.version}: ${finding.code}. ${finding.remediation}`);
    }
    return 1;
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { classifyChanges, licenseIsAllowed, parseArgs };