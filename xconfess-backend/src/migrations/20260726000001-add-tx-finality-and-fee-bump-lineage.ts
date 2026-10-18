import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

export class AddTxFinalityAndFeeBumpLineage20260726000001 implements MigrationInterface {
  name = 'AddTxFinalityAndFeeBumpLineage20260726000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('tips');
    if (!table) {
      throw new Error('Table "tips" does not exist; cannot add finality and fee-bump lineage columns');
    }

    const columnsToAdd: TableColumn[] = [];

    if (!table.findColumnByName('logical_tx_id')) {
      columnsToAdd.push(
        new TableColumn({
          name: 'logical_tx_id',
          type: 'uuid',
          isNullable: true,
        }),
      );
    }

    if (!table.findColumnByName('original_tx_hash')) {
      columnsToAdd.push(
        new TableColumn({
          name: 'original_tx_hash',
          type: 'varchar',
          length: '128',
          isNullable: true,
        }),
      );
    }

    if (!table.findColumnByName('replacement_tx_hash')) {
      columnsToAdd.push(
        new TableColumn({
          name: 'replacement_tx_hash',
          type: 'varchar',
          length: '128',
          isNullable: true,
        }),
      );
    }

    if (!table.findColumnByName('finality_state')) {
      columnsToAdd.push(
        new TableColumn({
          name: 'finality_state',
          type: 'varchar',
          length: '32',
          isNullable: true,
        }),
      );
    }

    if (!table.findColumnByName('finality_ledger')) {
      columnsToAdd.push(
        new TableColumn({
          name: 'finality_ledger',
          type: 'bigint',
          isNullable: true,
        }),
      );
    }

    if (!table.findColumnByName('finality_observed_at')) {
      columnsToAdd.push(
        new TableColumn({
          name: 'finality_observed_at',
          type: 'timestamp with time zone',
          isNullable: true,
        }),
      );
    }

    if (columnsToAdd.length > 0) {
      await queryRunner.addColumns('tips', columnsToAdd);
    }

    // Check constraint restricting finality_state to the known, user-visible states.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'chk_tips_finality_state'
        ) THEN
          ALTER TABLE "tips"
            ADD CONSTRAINT "chk_tips_finality_state"
            CHECK (
              "finality_state" IS NULL OR "finality_state" IN (
                'accepted',
                'included',
                'finalized',
                'failed',
                'unknown'
              )
            );
        END IF;
      END
      $$;
    `);

    // Unique index on logical_tx_id so a logical transaction maps to exactly one ledger record.
    const uniqueLogicalIndex = new TableIndex({
      name: 'uq_tips_logical_tx_id',
      columnNames: ['logical_tx_id'],
      isUnique: true,
    });
    if (!table.indices.some((idx) => idx.name === uniqueLogicalIndex.name)) {
      await queryRunner.createIndex('tips', uniqueLogicalIndex);
    }

    // Index to reconcile original and replacement hashes for fee-bump lineage lookups.
    const lineageIndex = new TableIndex({
      name: 'idx_tips_original_replacement_tx_hash',
      columnNames: ['original_tx_hash', 'replacement_tx_hash'],
      isUnique: false,
    });
    if (!table.indices.some((idx) => idx.name === lineageIndex.name)) {
      await queryRunner.createIndex('tips', lineageIndex);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('tips');
    if (!table) {
      return;
    }

    const lineageIndex = table.indices.find(
      (idx) => idx.name === 'idx_tips_original_replacement_tx_hash',
    );
    if (lineageIndex) {
      await queryRunner.dropIndex('tips', lineageIndex);
    }

    const uniqueLogicalIndex = table.indices.find(
      (idx) => idx.name === 'uq_tips_logical_tx_id',
    );
    if (uniqueLogicalIndex) {
      await queryRunner.dropIndex('tips', uniqueLogicalIndex);
    }

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'chk_tips_finality_state'
        ) THEN
          ALTER TABLE "tips" DROP CONSTRAINT "chk_tips_finality_state";
        END IF;
      END
      $$;
    `);

    const columnsToDrop = [
      'finality_observed_at',
      'finality_ledger',
      'finality_state',
      'replacement_tx_hash',
      'original_tx_hash',
      'logical_tx_id',
    ].filter((name) => table.findColumnByName(name));

    if (columnsToDrop.length > 0) {
      await queryRunner.dropColumns('tips', columnsToDrop);
    }
  }
}