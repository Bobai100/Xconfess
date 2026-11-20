import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTopicsWebhooksAndSearchOutbox20261120000001 implements MigrationInterface {
  name = 'AddTopicsWebhooksAndSearchOutbox20261120000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Webhook Subscriptions & Deliveries
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "webhook_subscriptions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" integer NOT NULL,
        "target_url" varchar(2048) NOT NULL,
        "secret" varchar(255) NOT NULL,
        "events" text NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "description" varchar(255),
        "rotated_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_webhook_subscriptions" PRIMARY KEY ("id")
      );
      CREATE INDEX IF NOT EXISTS "IDX_webhook_subscriptions_user_created"
        ON "webhook_subscriptions" ("user_id", "created_at");

      CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "subscription_id" uuid NOT NULL,
        "event_id" varchar(128) NOT NULL,
        "event_type" varchar(128) NOT NULL,
        "payload" jsonb NOT NULL,
        "status_code" integer,
        "status" varchar(32) NOT NULL DEFAULT 'PENDING',
        "attempts" integer NOT NULL DEFAULT 0,
        "max_attempts" integer NOT NULL DEFAULT 3,
        "next_retry_at" timestamptz,
        "last_error" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "completed_at" timestamptz,
        CONSTRAINT "PK_webhook_deliveries" PRIMARY KEY ("id"),
        CONSTRAINT "FK_webhook_deliveries_subscription"
          FOREIGN KEY ("subscription_id") REFERENCES "webhook_subscriptions"("id") ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_webhook_delivery_sub_event"
        ON "webhook_deliveries" ("subscription_id", "event_id");
      CREATE INDEX IF NOT EXISTS "IDX_webhook_deliveries_status_retry"
        ON "webhook_deliveries" ("status", "next_retry_at");
    `);

    // 2. API Deprecation Metrics (RFC 8594 Observability)
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "api_deprecation_metrics" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "endpoint_path" varchar(255) NOT NULL,
        "method" varchar(16) NOT NULL,
        "call_count" bigint NOT NULL DEFAULT 1,
        "first_seen_at" timestamptz NOT NULL,
        "last_seen_at" timestamptz NOT NULL,
        "sample_client_family" varchar(128),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_api_deprecation_metrics" PRIMARY KEY ("id")
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_api_deprecation_metric_method_path"
        ON "api_deprecation_metrics" ("method", "endpoint_path");
    `);

    // 3. Topics and Topic Aliases
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "topics" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "slug" varchar(100) NOT NULL UNIQUE,
        "name" varchar(150) NOT NULL,
        "description" text,
        "status" varchar(32) NOT NULL DEFAULT 'ACTIVE',
        "merged_into_topic_id" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_topics" PRIMARY KEY ("id")
      );
      CREATE INDEX IF NOT EXISTS "IDX_topics_status" ON "topics" ("status");

      CREATE TABLE IF NOT EXISTS "topic_aliases" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "alias" varchar(100) NOT NULL UNIQUE,
        "topic_id" uuid NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_topic_aliases" PRIMARY KEY ("id"),
        CONSTRAINT "FK_topic_aliases_topic"
          FOREIGN KEY ("topic_id") REFERENCES "topics"("id") ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS "IDX_topic_aliases_topic_id" ON "topic_aliases" ("topic_id");
    `);

    // 4. Search Index Outbox
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "search_index_outbox" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "entity_type" varchar(64) NOT NULL,
        "entity_id" varchar(128) NOT NULL,
        "action" varchar(32) NOT NULL DEFAULT 'INDEX_UPSERT',
        "payload" jsonb NOT NULL,
        "status" varchar(32) NOT NULL DEFAULT 'PENDING',
        "attempts" integer NOT NULL DEFAULT 0,
        "max_attempts" integer NOT NULL DEFAULT 5,
        "last_error" text,
        "next_retry_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "processed_at" timestamptz,
        CONSTRAINT "PK_search_index_outbox" PRIMARY KEY ("id")
      );
      CREATE INDEX IF NOT EXISTS "IDX_search_outbox_status_retry"
        ON "search_index_outbox" ("status", "next_retry_at");
      CREATE INDEX IF NOT EXISTS "IDX_search_outbox_entity"
        ON "search_index_outbox" ("entity_type", "entity_id");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "search_index_outbox"');
    await queryRunner.query('DROP TABLE IF EXISTS "topic_aliases"');
    await queryRunner.query('DROP TABLE IF EXISTS "topics"');
    await queryRunner.query('DROP TABLE IF EXISTS "api_deprecation_metrics"');
    await queryRunner.query('DROP TABLE IF EXISTS "webhook_deliveries"');
    await queryRunner.query('DROP TABLE IF EXISTS "webhook_subscriptions"');
  }
}
