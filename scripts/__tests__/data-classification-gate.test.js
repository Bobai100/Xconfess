'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  changedColumnNames,
  columnNames,
  migrationColumns,
  hasOwner,
  hasClassification,
} = require('../data-classification-gate');

describe('data classification gate parsers', () => {
  it('finds decorated entity properties, including multiline column options', () => {
    const entity = `
      @Column({
        name: 'email_encrypted',
        type: 'text',
      })
      emailEncrypted!: string;
      @Column()
      username!: string;
    `;

    assert.deepEqual(columnNames(entity), ['emailEncrypted', 'username']);
  });

  it('detects changed field definitions as well as added fields', () => {
    const before = `
      @Column({ type: 'text' })
      privateNote!: string;
    `;
    const after = `
      @Column({ type: 'text', select: false })
      privateNote!: string;
      @PrimaryGeneratedColumn('uuid')
      id!: string;
    `;

    assert.deepEqual(changedColumnNames(before, after), [
      'privateNote',
      'id',
    ]);
  });

  it('finds added and created table columns in migration SQL', () => {
    const migration = `
      ALTER TABLE "users" ADD COLUMN "support_flag" boolean;
      CREATE TABLE "sample_cases" (
        "id" uuid PRIMARY KEY,
        "label" varchar(32) NOT NULL,
        CONSTRAINT "sample_cases_pk" PRIMARY KEY ("id")
      );
    `;

    assert.deepEqual(migrationColumns(migration), [
      'support_flag',
      'id',
      'label',
    ]);
  });

  it('requires a non-empty owning module', () => {
    assert.equal(hasOwner({ owner: 'moderation' }), true);
    assert.equal(hasOwner({ owner: ' ' }), false);
    assert.equal(hasOwner(undefined), undefined);
    assert.equal(hasClassification('sensitive'), true);
    assert.equal(hasClassification('uncategorized'), false);
  });
});
