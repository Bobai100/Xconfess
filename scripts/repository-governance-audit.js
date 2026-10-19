#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SUPPORTED = {
  node: 22,
  postgres: 16,
  redis: 7,
};

const HIGH_RISK_AREAS = [
  ['backend source', 'backend/src/'],
    ['frontend source', 'frontend/src/'],
  ['backend auth', 'xconfess-backend/src/auth/'],
  ['backend admin', 'xconfess-backend/src/admin/'],
  ['backend encryption', 'xconfess-backend/src/encryption/'],
  ['backend key rotation', 'xconfess-backend/src/key-rotation/'],
  ['backend database', 'xconfess-backend/src/database/'],
  ['backend migrations', 'xconfess-backend/migrations/'],
  ['backend nested migrations', 'xconfess-backend/src/migrations/'],
  ['backend Stellar', 'xconfess-backend/src/stellar/'],
  ['backend data export', 'xconfess-backend/src/data-export/'],
  ['backend export', 'xconfess-backend/src/export/'],
  ['frontend auth', 'xconfess-frontend/app/(auth)/'],
  ['frontend API', 'xconfess-frontend/app/api/'],
  ['frontend admin', 'xconfess-frontend/app/(dashboard)/'],
  ['frontend wallet', 'xconfess-frontend/components/wallet/'],
  ['frontend wallet hook', 'xconfess-frontend/hooks/useStellarWallet.ts'],
  ['contracts', 'xconfess-contracts/'],
  ['deployment manifests', 'deployments/'],
  ['GitHub workflows', '.github/workflows/'],
];

function readText(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function codeownersPatternToRegExp(pattern) {
  const directoryPattern = pattern.endsWith('/');
  const normalized = pattern.replace(/^\/+/, '').replace(/\/+$/, '');
  const glob = directoryPattern ? `${normalized}/**` : normalized;
  let source = '^';

  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === '*' && glob[index + 1] === '*') {
      if (glob[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
    } else if (character === '*') {
      source += '[^/]*';
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }

  return new RegExp(`${source}$`);
}

function parseCodeowners(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const [pattern, ...owners] = line.split(/\s+/);
      return { pattern, owners, matcher: codeownersPatternToRegExp(pattern) };
    });
}

function validateCodeowners(failures) {
  let trackedFiles;
  try {
    trackedFiles = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean);
  } catch (error) {
    failures.push(`Unable to list tracked paths for CODEOWNERS audit: ${error.message}`);
    return;
  }

  const rules = parseCodeowners(readText('.github/CODEOWNERS'));
  let coveredCount = 0;

  for (const [area, pathPrefix] of HIGH_RISK_AREAS) {
    const files = trackedFiles.filter((file) => file.startsWith(pathPrefix));
    for (const file of files) {
      const explicitRule = rules
        .filter((rule) => rule.pattern !== '*' && rule.matcher.test(file))
        .at(-1);
      if (!explicitRule || explicitRule.owners.length === 0) {
        failures.push(`High-risk ${area} path has no explicit CODEOWNERS rule: ${file}`);
      } else {
        coveredCount += 1;
      }
    }
  }

  if (coveredCount > 0) {
    console.log(`CODEOWNERS audit: ${coveredCount} tracked high-risk paths have explicit owners.`);
  }
}

function requireMatch(relativePath, expression, description, failures) {
  if (!expression.test(readText(relativePath))) {
    failures.push(`${relativePath} does not declare supported ${description}.`);
  }
}

function validateSupportedVersions(failures) {
  if (Number(process.versions.node.split('.')[0]) !== SUPPORTED.node) {
    failures.push(`Deploy preflight requires Node.js ${SUPPORTED.node}.x; found ${process.version}.`);
  }

  requireMatch('compose.yaml', new RegExp(`image:\\s*postgres:${SUPPORTED.postgres}-alpine`), `PostgreSQL ${SUPPORTED.postgres}`, failures);
  requireMatch('compose.yaml', new RegExp(`image:\\s*redis:${SUPPORTED.redis}-alpine`), `Redis ${SUPPORTED.redis}`, failures);
  requireMatch('compose.yaml', new RegExp(`image:\\s*node:${SUPPORTED.node}-alpine`), `Node.js ${SUPPORTED.node}`, failures);
  requireMatch('Dockerfile.backend', new RegExp(`FROM node:${SUPPORTED.node}-alpine`), `Node.js ${SUPPORTED.node}`, failures);
  requireMatch('Dockerfile.frontend', new RegExp(`FROM node:${SUPPORTED.node}-alpine`), `Node.js ${SUPPORTED.node}`, failures);
  requireMatch('.github/workflows/ci.yml', new RegExp(`node-version:\\s*${SUPPORTED.node}\\b`), `Node.js ${SUPPORTED.node}`, failures);
  requireMatch('.github/workflows/ci.yml', new RegExp(`image:\\s*postgres:${SUPPORTED.postgres}-alpine`), `PostgreSQL ${SUPPORTED.postgres}`, failures);
  requireMatch('.github/workflows/ci.yml', new RegExp(`image:\\s*redis:${SUPPORTED.redis}-alpine`), `Redis ${SUPPORTED.redis}`, failures);
  requireMatch('render.yaml', new RegExp(`postgresMajorVersion:\\s*["']${SUPPORTED.postgres}["']`), `PostgreSQL ${SUPPORTED.postgres}`, failures);
  requireMatch('render.yaml', /buildCommand:\s*node scripts\/check-node-version\.js &&/, 'a Node.js preflight before install', failures);
}

module.exports = function validateRepositoryGovernance() {
  const failures = [];
  validateSupportedVersions(failures);
  validateCodeowners(failures);
  return failures;
};