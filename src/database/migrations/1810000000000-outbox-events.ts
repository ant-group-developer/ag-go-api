import { MigrationInterface, QueryRunner } from 'typeorm';

export class OutboxEvents1810000000000 implements MigrationInterface {
  name = 'OutboxEvents1810000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE outbox_events (
        id uuid PRIMARY KEY,
        event_type varchar(120) NOT NULL,
        aggregate_type varchar(80) NOT NULL,
        aggregate_id uuid NOT NULL,
        payload jsonb NOT NULL,
        status varchar(20) NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'published', 'failed')),
        attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        available_at timestamptz NOT NULL DEFAULT now(),
        published_at timestamptz NULL,
        last_error text NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX outbox_events_dispatch_idx
      ON outbox_events(status, available_at, created_at)
      WHERE status IN ('pending', 'failed')
    `);
    await queryRunner.query(`
      CREATE INDEX outbox_events_aggregate_idx
      ON outbox_events(aggregate_type, aggregate_id, created_at DESC)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS outbox_events`);
  }
}
