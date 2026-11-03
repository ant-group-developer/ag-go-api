import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Contract documents, ANTGO-253 (spec "dac-ta-hop-dong-nghiem-thu" 6.5, 7.9, 13).
 *
 * `document_templates`: versioned DOCX templates (contract per pricing model, amendment, acceptance
 * record), one active per kind and model. `generated_documents`: documents rendered by worker-io
 * (DOCX, PDF through Gotenberg when configured) and signed copies uploaded, versioned per owner.
 * Contracts and amendments keep the party A details captured when issued (`company_snapshot`,
 * FR-D-05) and the template version used; amendments also get their own encrypted partner snapshot
 * (BR-02). `system_settings.company` holds the current party A details.
 */
export class ContractDocuments2240000000000 implements MigrationInterface {
  name = 'ContractDocuments2240000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE document_templates (
        id uuid PRIMARY KEY,
        kind varchar(20) NOT NULL CHECK (kind IN ('contract', 'amendment', 'acceptance')),
        pricing_model varchar(20) NULL
          CHECK (pricing_model IS NULL OR pricing_model IN ('per_topic', 'per_unit', 'package_tier')),
        version integer NOT NULL CHECK (version > 0),
        name varchar(200) NOT NULL,
        file_name varchar(255) NOT NULL,
        storage_key text NOT NULL,
        size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
        checksum_sha256 varchar(64) NOT NULL,
        placeholders jsonb NOT NULL DEFAULT '[]'::jsonb,
        missing_recommended jsonb NOT NULL DEFAULT '[]'::jsonb,
        is_active boolean NOT NULL DEFAULT false,
        source varchar(20) NOT NULL DEFAULT 'upload' CHECK (source IN ('upload', 'default')),
        note text NULL,
        activated_at timestamptz NULL,
        activated_by varchar(128) NULL,
        created_by varchar(128) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT document_templates_contract_model_check
          CHECK (kind <> 'contract' OR pricing_model IS NOT NULL)
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX document_templates_version_key
       ON document_templates(kind, COALESCE(pricing_model, ''), version)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX document_templates_active_key
       ON document_templates(kind, COALESCE(pricing_model, '')) WHERE is_active`,
    );

    await queryRunner.query(`
      CREATE TABLE generated_documents (
        id uuid PRIMARY KEY,
        contract_id uuid NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
        owner_type varchar(20) NOT NULL CHECK (owner_type IN ('contract', 'amendment', 'acceptance')),
        owner_id uuid NOT NULL,
        kind varchar(20) NOT NULL CHECK (kind IN ('generated', 'signed')),
        version integer NOT NULL CHECK (version > 0),
        template_id uuid NULL REFERENCES document_templates(id) ON DELETE RESTRICT,
        status varchar(20) NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
        file_name varchar(255) NOT NULL,
        content_type varchar(120) NOT NULL,
        storage_key text NULL,
        size_bytes bigint NULL,
        checksum_sha256 varchar(64) NULL,
        pdf_status varchar(20) NOT NULL DEFAULT 'none'
          CHECK (pdf_status IN ('none', 'pending', 'ready', 'failed', 'skipped')),
        pdf_storage_key text NULL,
        pdf_size_bytes bigint NULL,
        pdf_checksum_sha256 varchar(64) NULL,
        error text NULL,
        pdf_error text NULL,
        attempts integer NOT NULL DEFAULT 0,
        generated_at timestamptz NULL,
        created_by varchar(128) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT generated_documents_version_key UNIQUE (owner_type, owner_id, kind, version),
        CONSTRAINT generated_documents_template_check
          CHECK (kind = 'signed' OR template_id IS NOT NULL)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX generated_documents_contract_id_idx ON generated_documents(contract_id, created_at)`,
    );

    await queryRunner.query(`ALTER TABLE contracts ADD COLUMN company_snapshot jsonb NULL`);
    await queryRunner.query(`
      ALTER TABLE contract_amendments
        ADD COLUMN partner_snapshot_enc text NULL,
        ADD COLUMN partner_snapshot_at timestamptz NULL,
        ADD COLUMN company_snapshot jsonb NULL,
        ADD COLUMN template_version_id uuid NULL,
        ADD COLUMN issued_at timestamptz NULL,
        ADD COLUMN issued_by varchar(128) NULL
    `);
    await queryRunner.query(`
      INSERT INTO system_settings (key, value)
      VALUES ('company', '{}'::jsonb)
      ON CONFLICT (key) DO NOTHING
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM system_settings WHERE key = 'company'`);
    await queryRunner.query(`
      ALTER TABLE contract_amendments
        DROP COLUMN IF EXISTS issued_by,
        DROP COLUMN IF EXISTS issued_at,
        DROP COLUMN IF EXISTS template_version_id,
        DROP COLUMN IF EXISTS company_snapshot,
        DROP COLUMN IF EXISTS partner_snapshot_at,
        DROP COLUMN IF EXISTS partner_snapshot_enc
    `);
    await queryRunner.query(`ALTER TABLE contracts DROP COLUMN IF EXISTS company_snapshot`);
    await queryRunner.query(`DROP TABLE IF EXISTS generated_documents`);
    await queryRunner.query(`DROP TABLE IF EXISTS document_templates`);
  }
}
