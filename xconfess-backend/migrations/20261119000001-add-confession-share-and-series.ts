import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddConfessionShareAndSeries20261119000001
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "anonymous_confessions"
        ADD COLUMN IF NOT EXISTS "publish_timezone" varchar(64),
        ADD COLUMN IF NOT EXISTS "share_token" varchar(64),
        ADD COLUMN IF NOT EXISTS "share_revoked" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "series_handle" varchar(64);
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_anonymous_confessions_share_token"
        ON "anonymous_confessions" ("share_token")
        WHERE "share_token" IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_anonymous_confessions_share_token";
      ALTER TABLE "anonymous_confessions"
        DROP COLUMN IF EXISTS "series_handle",
        DROP COLUMN IF EXISTS "share_revoked",
        DROP COLUMN IF EXISTS "share_token",
        DROP COLUMN IF EXISTS "publish_timezone";
    `);
  }
}
