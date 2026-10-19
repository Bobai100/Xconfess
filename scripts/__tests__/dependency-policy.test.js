'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { classifyChanges, licenseIsAllowed } = require('../dependency-policy');

function lock(packages) {
  return { packages };
}

test('license policy evaluates permissive SPDX alternatives and conjunctions', () => {
  assert.equal(licenseIsAllowed('MIT OR WTFPL'), true);
  assert.equal(licenseIsAllowed('MIT AND ISC'), true);
  assert.equal(licenseIsAllowed('MIT AND GPL-3.0'), false);
  assert.equal(licenseIsAllowed('SEE LICENSE IN LICENSE.md'), false);
});

test('runtime additions are classified and require explicit review', () => {
  const base = lock({ '': { dependencies: {} } });
  const current = lock({
    '': { dependencies: { 'new-runtime': '^1.0.0' } },
    'node_modules/new-runtime': { version: '1.0.0', license: 'MIT' },
    'node_modules/test-only': { version: '1.0.0', license: 'GPL-3.0', dev: true },
  });

  const result = classifyChanges(current, base, { changeApprovals: [], licenseExceptions: [] });
  assert.equal(result.changes[0].changeClass, 'runtime-direct-added');
  assert.equal(result.changes[0].approved, false);
  assert.ok(result.findings.some((finding) => finding.code === 'unreviewed-runtime-change'));
  assert.equal(result.packages.some((pkg) => pkg.name === 'test-only'), false);
});

test('approved change and disallowed-license exception require a live issue-backed record', () => {
  const base = lock({ '': { dependencies: {} } });
  const current = lock({
    '': { dependencies: { 'reviewed-runtime': '^2.0.0' } },
    'node_modules/reviewed-runtime': { version: '2.0.0', license: 'MPL-2.0' },
  });
  const policy = {
    changeApprovals: [{
      package: 'reviewed-runtime',
      version: '2.0.0',
      license: 'MPL-2.0',
      changeClass: 'runtime-direct-added',
      reason: 'Reviewed for this service boundary',
      issue: '#302',
      expires: '2099-01-01',
    }],
    licenseExceptions: [{
      package: 'reviewed-runtime',
      version: '2.0.0',
      license: 'MPL-2.0',
      reason: 'Reviewed for this service boundary',
      issue: '#302',
      expires: '2099-01-01',
    }],
  };

  const result = classifyChanges(current, base, policy, Date.parse('2026-10-19'));
  assert.equal(result.changes[0].approved, true);
  assert.equal(result.findings.length, 0);
});