import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateSorobanEventCheckpoints20260905000002
  implements MigrationInterface
{
  name = 'CreateSorobanEventCheckpoints20260905000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "soroban_event_checkpoints" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "network" varchar(16) NOT NULL,
        "contract_id" varchar(56) NOT NULL,
        "last_ledger" bigint NOT NULL DEFAULT 0,
        "last_cursor" varchar(256),
        "indexed_events" integer NOT NULL DEFAULT 0,
        "failed_events" integer NOT NULL DEFAULT 0,
        "last_error_code" varchar(64),
        "last_error_at" timestamptz,
        "last_indexed_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uq_soroban_event_checkpoint_network_contract"
          UNIQUE ("network", "contract_id")
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_soroban_event_checkpoints_last_indexed"
        ON "soroban_event_checkpoints" ("last_indexed_at");
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "pending_transaction_submissions" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "intent_key" varchar(128) NOT NULL,
        "operation_type" varchar(64) NOT NULL,
        "network" varchar(16) NOT NULL,
        "status" varchar(32) NOT NULL DEFAULT 'pending',
        "tx_hash" varchar(64),
        "attempts" integer NOT NULL DEFAULT 0,
        "last_error_code" varchar(64),
        "last_error_message" text,
        "submitted_at" timestamptz,
        "last_attempt_at" timestamptz,
        "resolved_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uq_pending_transaction_submission_intent"
          UNIQUE ("intent_key")
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_pending_transaction_submissions_status"
        ON "pending_transaction_submissions" ("status");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_pending_transaction_submissions_tx_hash"
        ON "pending_transaction_submissions" ("tx_hash");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_pending_transaction_submissions_network_status"
        ON "pending_transaction_submissions" ("network", "status");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP TABLE IF EXISTS "pending_transaction_submissions";',
    );
    await queryRunner.query('DROP TABLE IF EXISTS "soroban_event_checkpoints";');
  }
}