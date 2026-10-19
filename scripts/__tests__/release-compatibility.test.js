'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { compareContractManifests, parseArgs } = require('../release-compatibility');

test('contract compatibility requires identical manifest sets and versions', () => {
  const abi = { alpha: { version: '1.0.0' }, beta: { version: '2.0.0' } };
  const wasm = { beta: { version: '2.0.0' }, alpha: { version: '1.0.0' } };
  assert.deepEqual(compareContractManifests(abi, wasm), {
    names: ['alpha', 'beta'],
    namesMatch: true,
    versionsMatch: true,
  });
});

test('contract compatibility blocks a missing contract and a version mismatch', () => {
  assert.equal(compareContractManifests({ alpha: { version: '1.0.0' } }, {}).namesMatch, false);
  assert.equal(compareContractManifests(
    { alpha: { version: '1.0.0' } },
    { alpha: { version: '2.0.0' } },
  ).versionsMatch, false);
});

test('release compatibility report output can be selected explicitly', () => {
  assert.equal(parseArgs(['--output', 'tmp/report.json']).output.endsWith('/tmp/report.json'), true);
});