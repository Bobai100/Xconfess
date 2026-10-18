import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * Aggregate-only storage for ranking quality drift detection.
 *
 * Privacy contract: this table MUST NOT contain user-level identifiers
 * (no user ids, confession ids, session ids, IPs, or raw query strings).
 * Only cohort-level aggregates and counts are persisted, and each row
 * carries a retention timestamp so aggregates can be purged on schedule.
 */
export class CreateRankingQualityAggregates20260910000002 implements MigrationInterface {
  name = 'CreateRankingQualityAggregates20260910000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'ranking_quality_aggregates',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            default: 'gen_random_uuid()',
          },
          {
            name: 'ranking_version',
            type: 'varchar',
            length: '64',
            isNullable: false,
          },
          {
            name: 'cohort_key',
            type: 'varchar',
            length: '128',
            isNullable: false,
            comment:
              'Non-identifying cohort bucket (e.g. surface + coarse segment). Must never encode a user id.',
          },
          {
            name: 'window_start',
            type: 'timestamptz',
            isNullable: false,
          },
          {
            name: 'window_end',
            type: 'timestamptz',
            isNullable: false,
          },
          {
            name: 'sample_size',
            type: 'integer',
            isNullable: false,
            default: 0,
            comment: 'Number of impressions/events aggregated into this row.',
          },
          {
            name: 'engagement_rate',
            type: 'double precision',
            isNullable: true,
          },
          {
            name: 'satisfaction_rate',
            type: 'double precision',
            isNullable: true,
          },
          {
            name: 'report_rate',
            type: 'double precision',
            isNullable: true,
          },
          {
            name: 'drift_score',
            type: 'double precision',
            isNullable: true,
          },
          {
            name: 'drift_status',
            type: 'varchar',
            length: '16',
            isNullable: false,
            default: "'ok'",
            comment: 'ok | watch | breached',
          },
          {
            name: 'retention_expires_at',
            type: 'timestamptz',
            isNullable: false,
            comment: 'Aggregates past this timestamp are purged by the retention job.',
          },
          {
            name: 'created_at',
            type: 'timestamptz',
            isNullable: false,
            default: 'now()',
          },
          {
            name: 'updated_at',
            type: 'timestamptz',
            isNullable: false,
            default: 'now()',
          },
        ],
      }),
      true,
    );

    await queryRunner.createIndex(
      'ranking_quality_aggregates',
      new TableIndex({
        name: 'IDX_ranking_quality_aggregates_version_window',
        columnNames: ['ranking_version', 'window_start'],
      }),
    );

    await queryRunner.createIndex(
      'ranking_quality_aggregates',
      new TableIndex({
        name: 'IDX_ranking_quality_aggregates_retention',
        columnNames: ['retention_expires_at'],
      }),
    );

    await queryRunner.createIndex(
      'ranking_quality_aggregates',
      new TableIndex({
        name: 'UQ_ranking_quality_aggregates_cohort_window',
        columnNames: ['ranking_version', 'cohort_key', 'window_start', 'window_end'],
        isUnique: true,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('ranking_quality_aggregates', true);
  }
}