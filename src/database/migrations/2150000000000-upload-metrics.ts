import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Upload sessions keep how long the file took to send (measured in the browser) and to complete
 * (measured by the API), so upload speed can be reviewed later. `upload_speed_log` lists one row
 * per completed upload with the speed worked out.
 */
export class UploadMetrics2150000000000 implements MigrationInterface {
  name = 'UploadMetrics2150000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE asset_upload_sessions
        ADD COLUMN upload_metrics jsonb NULL
    `);
    await queryRunner.query(`
      CREATE VIEW upload_speed_log AS
      SELECT
        s.id AS upload_session_id,
        s.asset_id,
        a.original_filename,
        a.asset_type,
        s.expected_size_bytes AS size_bytes,
        s.created_by,
        s.created_at,
        s.completed_at,
        s.upload_metrics->'client'->>'mode' AS mode,
        (s.upload_metrics->'client'->>'transferMs')::bigint AS transfer_ms,
        CASE WHEN (s.upload_metrics->'client'->>'transferMs')::bigint > 0
          THEN round(s.expected_size_bytes * 8 / 1000.0 / (s.upload_metrics->'client'->>'transferMs')::bigint, 2)
        END AS transfer_mbps,
        (s.upload_metrics->'client'->>'partUrlWaitMs')::bigint AS part_url_wait_ms,
        (s.upload_metrics->'client'->>'partCount')::int AS part_count,
        (s.upload_metrics->'client'->>'parallelParts')::int AS parallel_parts,
        (s.upload_metrics->'client'->>'retries')::int AS retries,
        (s.upload_metrics->'client'->>'concurrentUploads')::int AS concurrent_uploads,
        s.upload_metrics->'client'->>'networkType' AS network_type,
        (s.upload_metrics->'client'->>'downlinkMbps')::numeric AS downlink_mbps,
        (s.upload_metrics->'client'->>'rttMs')::int AS rtt_ms,
        (s.upload_metrics->'server'->>'assembleMs')::bigint AS assemble_ms,
        (s.upload_metrics->'server'->>'completeMs')::bigint AS complete_ms,
        (s.upload_metrics->'server'->>'sinceSessionMs')::bigint AS total_ms
      FROM asset_upload_sessions s
      JOIN assets a ON a.id = s.asset_id
      WHERE s.upload_metrics IS NOT NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP VIEW IF EXISTS upload_speed_log`);
    await queryRunner.query(`
      ALTER TABLE asset_upload_sessions
        DROP COLUMN IF EXISTS upload_metrics
    `);
  }
}
