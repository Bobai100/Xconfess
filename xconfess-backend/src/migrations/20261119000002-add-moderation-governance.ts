import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddModerationGovernance20261119000002 implements MigrationInterface {
  name = 'AddModerationGovernance20261119000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "moderation_access_grants" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" integer NOT NULL,
        "granted_by_id" integer NOT NULL,
        "scope" varchar(64) NOT NULL,
        "reason" text NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "expires_at" timestamptz NOT NULL,
        "revoked_at" timestamptz,
        "revoked_by_id" integer,
        CONSTRAINT "PK_moderation_access_grants" PRIMARY KEY ("id")
      );
      CREATE INDEX "IDX_moderation_access_grants_user_scope_expiry"
        ON "moderation_access_grants" ("user_id", "scope", "expires_at");
      CREATE INDEX "IDX_moderation_access_grants_grantor_created"
        ON "moderation_access_grants" ("granted_by_id", "created_at");
    `);

    await queryRunner.query(`
      CREATE TABLE "moderation_policy_runs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_by_id" integer NOT NULL,
        "kind" varchar(16) NOT NULL,
        "status" varchar(16) NOT NULL,
        "details" jsonb NOT NULL,
        "result" jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "expires_at" timestamptz,
        "committed_at" timestamptz,
        "rolled_back_at" timestamptz,
        CONSTRAINT "PK_moderation_policy_runs" PRIMARY KEY ("id")
      );
      CREATE INDEX "IDX_moderation_policy_runs_creator_kind_created"
        ON "moderation_policy_runs" ("created_by_id", "kind", "created_at");
      CREATE INDEX "IDX_moderation_policy_runs_status_expiry"
        ON "moderation_policy_runs" ("status", "expires_at");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "moderation_policy_runs"');
    await queryRunner.query('DROP TABLE "moderation_access_grants"');
  }
}
