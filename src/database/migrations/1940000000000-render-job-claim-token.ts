import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A render job records which worker run claimed it. With media workers on several hosts, a
 * worker whose job was re-queued (its heartbeat looked stale) must see that the job is no
 * longer its own and stop, instead of rendering the file again next to the new owner.
 */
export class RenderJobClaimTokenMigration1940000000000 implements MigrationInterface {
  name = 'RenderJobClaimTokenMigration1940000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE media_render_jobs ADD COLUMN IF NOT EXISTS claim_token uuid NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE media_render_jobs DROP COLUMN IF EXISTS claim_token`);
  }
}
