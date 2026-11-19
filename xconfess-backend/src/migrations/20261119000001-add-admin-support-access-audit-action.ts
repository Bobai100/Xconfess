import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAdminSupportAccessAuditAction20261119000001
  implements MigrationInterface
{
  name = 'AddAdminSupportAccessAuditAction20261119000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_type WHERE typname = 'audit_logs_action_enum'
        ) THEN
          ALTER TYPE "audit_logs_action_enum"
            ADD VALUE IF NOT EXISTS 'admin_support_access_reviewed';
        END IF;
      END $$;
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // PostgreSQL enum values cannot be removed safely; the unused value is inert.
  }
}
