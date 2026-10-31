import type { MigrationInterface, QueryRunner } from 'typeorm';

/** `upload_speed_log` as of UploadSpeedLogRange2170000000000, for `down`. */
const RANGE_VIEW = `
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
    (s.upload_metrics->'server'->>'sinceSessionMs')::bigint AS total_ms,
    (s.upload_metrics->'client'->>'minMbps')::numeric AS min_mbps,
    (s.upload_metrics->'client'->>'maxMbps')::numeric AS max_mbps,
    (s.upload_metrics->'client'->>'idleMs')::bigint AS idle_ms,
    s.target_project_id AS project_id,
    p.name AS project_name,
    p.folder_id
  FROM asset_upload_sessions s
  JOIN assets a ON a.id = s.asset_id
  LEFT JOIN projects p ON p.id = s.target_project_id`;

/**
 * `upload_speed_log` also lists uploads that failed (aborted by the browser, or kept open to be
 * resumed) or were left to expire (tab closed, computer asleep), with what the browser reported
 * about the failure (`upload_metrics->'failure'`). Their speed is not worked out: the file never
 * fully went up. A resumed upload's speed counts only the bytes sent in its last run.
 * `ended_at` is when the upload completed, failed or expired.
 * New columns go last, as `CREATE OR REPLACE VIEW` requires.
 */
export class UploadFailureLog2180000000000 implements MigrationInterface {
  name = 'UploadFailureLog2180000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE VIEW upload_speed_log AS
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
        CASE WHEN s.status = 'completed' AND (s.upload_metrics->'client'->>'transferMs')::bigint > 0
          THEN round(
            (s.expected_size_bytes - COALESCE((s.upload_metrics->'client'->>'resumedBytes')::bigint, 0))
              * 8 / 1000.0 / (s.upload_metrics->'client'->>'transferMs')::bigint,
            2
          )
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
        (s.upload_metrics->'server'->>'sinceSessionMs')::bigint AS total_ms,
        (s.upload_metrics->'client'->>'minMbps')::numeric AS min_mbps,
        (s.upload_metrics->'client'->>'maxMbps')::numeric AS max_mbps,
        (s.upload_metrics->'client'->>'idleMs')::bigint AS idle_ms,
        s.target_project_id AS project_id,
        p.name AS project_name,
        p.folder_id,
        s.status,
        COALESCE(s.completed_at, s.updated_at) AS ended_at,
        s.upload_metrics->'failure'->>'stage' AS failure_stage,
        s.upload_metrics->'failure'->>'message' AS failure_message,
        s.upload_metrics->'failure' AS failure,
        (s.upload_metrics->'client'->>'resumedBytes')::bigint AS resumed_bytes
      FROM asset_upload_sessions s
      JOIN assets a ON a.id = s.asset_id
      LEFT JOIN projects p ON p.id = s.target_project_id
      WHERE s.upload_metrics IS NOT NULL OR s.status IN ('aborted', 'expired')
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP VIEW IF EXISTS upload_speed_log`);
    await queryRunner.query(`
      CREATE VIEW upload_speed_log AS
      ${RANGE_VIEW}
      WHERE s.upload_metrics IS NOT NULL AND s.status = 'completed'
    `);
  }
}
