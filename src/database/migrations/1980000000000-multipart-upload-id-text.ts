import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * R2 multipart upload ids are opaque tokens that are often longer than 255 characters, so opening
 * an upload session for a file above the multipart threshold failed with
 * "value too long for type character varying(255)".
 */
export class MultipartUploadIdTextMigration1980000000000 implements MigrationInterface {
  name = 'MultipartUploadIdTextMigration1980000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE asset_upload_sessions
        ALTER COLUMN multipart_upload_id TYPE text
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Ids longer than 255 characters cannot be kept; those sessions lose their multipart id.
    await queryRunner.query(`
      UPDATE asset_upload_sessions
        SET multipart_upload_id = NULL
        WHERE length(multipart_upload_id) > 255
    `);
    await queryRunner.query(`
      ALTER TABLE asset_upload_sessions
        ALTER COLUMN multipart_upload_id TYPE varchar(255)
    `);
  }
}
