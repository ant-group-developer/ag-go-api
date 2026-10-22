import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * How AG Studio uses footage, as Studio reports it (POST /usage/studio-events): one row per event,
 * `event_key` unique so a resent event is not counted twice. No foreign keys: an event stays when
 * its asset or project is deleted later, and an unknown id must not reject the whole batch.
 *
 * Also indexes the download tables by asset and project for the usage counts.
 *
 * Those download indexes were built without CONCURRENTLY, which blocked writes on large live
 * tables. New indexes on large tables must use CREATE INDEX CONCURRENTLY with `transaction =
 * false` on the migration (see DataRetentionIndexes2150000000000).
 */
export class StudioUsage2130000000000 implements MigrationInterface {
  name = 'StudioUsage2130000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE studio_usage_events (
        id                   bigserial PRIMARY KEY,
        event_key            varchar(200) NOT NULL,
        kind                 varchar(30) NOT NULL
                               CONSTRAINT studio_usage_events_kind_check
                               CHECK (kind IN ('source_added','source_removed','final_render','premiere_export')),
        asset_id             uuid,
        ag_go_project_id     uuid,
        studio_job_id        varchar(100),
        studio_project_id    varchar(100) NOT NULL,
        studio_project_name  varchar(500) NOT NULL,
        studio_video_id      varchar(100),
        studio_video_title   varchar(500),
        studio_user_id       varchar(128),
        occurred_at          timestamptz NOT NULL,
        received_at          timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT studio_usage_events_event_key_unique UNIQUE (event_key)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX studio_usage_events_asset_idx ON studio_usage_events(asset_id, occurred_at)`,
    );
    await queryRunner.query(
      `CREATE INDEX studio_usage_events_project_idx ON studio_usage_events(ag_go_project_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX studio_usage_events_kind_idx ON studio_usage_events(kind, occurred_at)`,
    );

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS download_logs_asset_idx ON download_logs(asset_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS download_logs_project_idx ON download_logs(project_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS download_logs_created_idx ON download_logs(created_at)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS download_job_items_asset_idx ON download_job_items(asset_id)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS download_job_items_asset_idx`);
    await queryRunner.query(`DROP INDEX IF EXISTS download_logs_created_idx`);
    await queryRunner.query(`DROP INDEX IF EXISTS download_logs_project_idx`);
    await queryRunner.query(`DROP INDEX IF EXISTS download_logs_asset_idx`);
    await queryRunner.query(`DROP TABLE IF EXISTS studio_usage_events`);
  }
}
