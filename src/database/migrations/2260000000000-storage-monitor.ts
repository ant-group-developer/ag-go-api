import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * R2 storage monitor (System > R2 storage).
 *
 * `storage_snapshots`: one row per hour (`slot`, unique so only one outbox host takes it) with the
 * bucket size Cloudflare reports, the bytes the database knows of and the operations of the last
 * 24 hours. Comparing them shows storage nobody accounts for, for example a leaked key used to
 * store files.
 *
 * `storage_audits`: a full listing of the bucket, every object sorted into a category (counted,
 * app data the statistics leave out, orphan, unknown). Scheduled weekly or run by an admin.
 *
 * The audit looks objects up by key a page at a time, hence the two key indexes.
 */
export class StorageMonitor2260000000000 implements MigrationInterface {
  name = 'StorageMonitor2260000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE storage_snapshots (
        id uuid PRIMARY KEY,
        slot timestamptz NOT NULL UNIQUE,
        status varchar(20) NOT NULL DEFAULT 'running'
          CHECK (status IN ('running', 'completed', 'failed')),
        bucket_payload_bytes bigint NULL,
        bucket_metadata_bytes bigint NULL,
        bucket_objects bigint NULL,
        bucket_pending_uploads bigint NULL,
        bucket_measured_at timestamptz NULL,
        expected_bytes bigint NULL,
        leaked_bytes bigint NULL,
        expected_breakdown jsonb NULL,
        operations jsonb NULL,
        class_a_operations bigint NULL,
        class_b_operations bigint NULL,
        error text NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz NULL
      )
    `);
    await queryRunner.query(`
      CREATE TABLE storage_audits (
        id uuid PRIMARY KEY,
        status varchar(20) NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued', 'running', 'completed', 'failed')),
        trigger varchar(20) NOT NULL CHECK (trigger IN ('schedule', 'manual')),
        requested_by varchar(128) NULL,
        locked_until timestamptz NULL,
        started_at timestamptz NULL,
        finished_at timestamptz NULL,
        listed_objects bigint NOT NULL DEFAULT 0,
        listed_bytes bigint NOT NULL DEFAULT 0,
        multipart_uploads integer NULL,
        multipart_bytes bigint NULL,
        categories jsonb NULL,
        other_prefixes jsonb NULL,
        top_objects jsonb NULL,
        error text NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX storage_audits_status_idx ON storage_audits(status, created_at)`,
    );
    await queryRunner.query(
      `CREATE INDEX assets_original_storage_key_idx ON assets(original_storage_key)`,
    );
    await queryRunner.query(
      `CREATE INDEX asset_variants_storage_key_idx ON asset_variants(storage_key)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS asset_variants_storage_key_idx`);
    await queryRunner.query(`DROP INDEX IF EXISTS assets_original_storage_key_idx`);
    await queryRunner.query(`DROP TABLE IF EXISTS storage_audits`);
    await queryRunner.query(`DROP TABLE IF EXISTS storage_snapshots`);
  }
}
