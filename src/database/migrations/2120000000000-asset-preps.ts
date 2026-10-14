import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Studio inputs prepared once per footage ("prep"), apart from the analysis pipeline:
 *
 * - asset_preps: shots, frames, contact sheets and the transcript of one video, read by AG Studio.
 *   One `is_current` (ready) prep per asset; a new run stays beside it until it is ready.
 * - asset_prep_batches: a backfill, so it can be paused, resumed and cancelled at the farm by its
 *   group key (`prep-batch:<id>`). New footage and Studio requests run without a batch.
 * - asset_prep_farm_jobs: the farm jobs of a prep (scan.prep, studio.transcribe), like
 *   analysis_farm_jobs.
 */
export class AssetPreps2120000000000 implements MigrationInterface {
  name = 'AssetPreps2120000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE asset_prep_batches (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name        varchar(200) NOT NULL,
        mode        varchar(20) NOT NULL,
        priority    integer NOT NULL DEFAULT 0,
        status      varchar(20) NOT NULL DEFAULT 'running'
                      CONSTRAINT asset_prep_batches_status_check CHECK (status IN ('running','paused','cancelled')),
        created_by  varchar(128),
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX asset_prep_batches_created_idx ON asset_prep_batches(created_at DESC)`,
    );

    await queryRunner.query(`
      CREATE TABLE asset_preps (
        id                 uuid PRIMARY KEY,
        asset_id           uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        status             varchar(20) NOT NULL DEFAULT 'queued'
                             CONSTRAINT asset_preps_status_check
                             CHECK (status IN ('queued','cutting','transcribing','ready','failed','cancelled')),
        is_current         boolean NOT NULL DEFAULT false,
        lane               varchar(20) NOT NULL DEFAULT 'batch'
                             CONSTRAINT asset_preps_lane_check CHECK (lane IN ('interactive','batch')),
        priority           integer NOT NULL DEFAULT 0,
        batch_id           uuid REFERENCES asset_prep_batches(id) ON DELETE SET NULL,
        requested_by       varchar(128),
        source_kind        varchar(20),
        watermarked        boolean,
        duration_s         double precision,
        width              integer,
        height             integer,
        fps                double precision,
        has_audio          boolean,
        scene              jsonb,
        shots              jsonb,
        sheets             jsonb,
        transcript         jsonb,
        transcript_text    text,
        transcript_status  varchar(20) NOT NULL DEFAULT 'pending'
                             CONSTRAINT asset_preps_transcript_status_check
                             CHECK (transcript_status IN ('none','pending','skipped','done','failed')),
        language           varchar(20),
        error              text,
        created_at         timestamptz NOT NULL DEFAULT now(),
        updated_at         timestamptz NOT NULL DEFAULT now(),
        prepared_at        timestamptz
      )
    `);
    // One current (ready) prep per asset
    await queryRunner.query(
      `CREATE UNIQUE INDEX asset_preps_current_unique ON asset_preps(asset_id) WHERE is_current`,
    );
    await queryRunner.query(
      `CREATE INDEX asset_preps_asset_created_idx ON asset_preps(asset_id, created_at DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX asset_preps_batch_status_idx ON asset_preps(batch_id, status)`,
    );
    await queryRunner.query(
      `CREATE INDEX asset_preps_unfinished_idx ON asset_preps(status) WHERE status IN ('queued','cutting','transcribing')`,
    );

    await queryRunner.query(`
      CREATE TABLE asset_prep_farm_jobs (
        farm_job_id   uuid PRIMARY KEY,
        prep_id       uuid NOT NULL REFERENCES asset_preps(id) ON DELETE CASCADE,
        type          varchar(40) NOT NULL,
        status        varchar(20) NOT NULL DEFAULT 'submitted'
                        CONSTRAINT asset_prep_farm_jobs_status_check CHECK (status IN ('submitted','ingested','failed')),
        error         jsonb,
        submitted_at  timestamptz NOT NULL DEFAULT now(),
        ingested_at   timestamptz,
        locked_until  timestamptz
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX asset_prep_farm_jobs_prep_type_unique ON asset_prep_farm_jobs(prep_id, type)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS asset_prep_farm_jobs`);
    await queryRunner.query(`DROP TABLE IF EXISTS asset_preps`);
    await queryRunner.query(`DROP TABLE IF EXISTS asset_prep_batches`);
  }
}
