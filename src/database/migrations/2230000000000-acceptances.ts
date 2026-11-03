import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Acceptance records (BBNT) of contracts (ANTGO-253, spec 5.3, 7.6, 7.7, 9.3–9.5).
 *
 * `acceptance_records` holds the period, amounts (gross, tax with manual override, advance offset,
 * net and words), the terms and rate card used, warnings, and the fields the documents and payments
 * phases fill later (snapshots, template, signed file, due date, paid statuses). The appendix
 * number is given when issued, unique per contract.
 *
 * `acceptance_items` are its lines with computed and final quantity / price (adjustments need a
 * reason, BR-14); `acceptance_item_sources` traces each line to its projects. A counted project
 * stays `is_active` while its record is not cancelled, and a partial unique index keeps it on one
 * record only ("không tính hai lần", spec 7.7). Packages point at the record holding them.
 */
export class Acceptances2230000000000 implements MigrationInterface {
  name = 'Acceptances2230000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE acceptance_records (
        id uuid PRIMARY KEY,
        contract_id uuid NOT NULL REFERENCES contracts(id) ON DELETE RESTRICT,
        partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
        pricing_model varchar(20) NOT NULL
          CHECK (pricing_model IN ('per_topic', 'per_unit', 'package_tier')),
        appendix_number integer NULL CHECK (appendix_number IS NULL OR appendix_number > 0),
        period_start date NOT NULL,
        period_end date NOT NULL,
        record_date date NULL,
        status varchar(20) NOT NULL DEFAULT 'draft'
          CHECK (status IN ('draft', 'submitted', 'approved', 'issued', 'signed',
                            'partially_paid', 'paid', 'cancelled')),
        delivery_method varchar(20) NOT NULL DEFAULT 'ag_go'
          CHECK (delivery_method IN ('ag_go', 'hard_drive', 'google_drive', 'other')),
        delivery_note text NULL,
        gross_amount bigint NOT NULL DEFAULT 0 CHECK (gross_amount >= 0),
        tax_rate numeric(5,2) NOT NULL DEFAULT 10 CHECK (tax_rate >= 0 AND tax_rate <= 100),
        tax_amount bigint NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
        tax_overridden boolean NOT NULL DEFAULT false,
        tax_override_reason text NULL,
        advance_offset_amount bigint NOT NULL DEFAULT 0 CHECK (advance_offset_amount >= 0),
        advance_offset_overridden boolean NOT NULL DEFAULT false,
        advance_offset_reason text NULL,
        net_payable bigint NOT NULL DEFAULT 0 CHECK (net_payable >= 0),
        net_payable_words text NULL,
        rate_card_id uuid NULL REFERENCES rate_cards(id) ON DELETE RESTRICT,
        terms_snapshot jsonb NULL,
        partner_snapshot_enc text NULL,
        partner_snapshot_at timestamptz NULL,
        company_snapshot jsonb NULL,
        warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
        excluded_project_ids uuid[] NOT NULL DEFAULT '{}',
        excluded_package_ids uuid[] NOT NULL DEFAULT '{}',
        calculated_at timestamptz NULL,
        approval_note text NULL,
        return_reason text NULL,
        returned_at timestamptz NULL,
        returned_by varchar(128) NULL,
        prepared_by varchar(128) NOT NULL,
        submitted_at timestamptz NULL,
        submitted_by varchar(128) NULL,
        approved_at timestamptz NULL,
        approved_by varchar(128) NULL,
        issued_at timestamptz NULL,
        issued_by varchar(128) NULL,
        signed_at timestamptz NULL,
        signed_file_id uuid NULL,
        due_date date NULL,
        template_version_id uuid NULL,
        cancelled_reason text NULL,
        cancelled_at timestamptz NULL,
        cancelled_by varchar(128) NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT acceptance_records_appendix_key UNIQUE (contract_id, appendix_number),
        CONSTRAINT acceptance_records_period_check CHECK (period_end >= period_start),
        CONSTRAINT acceptance_records_net_check
          CHECK (net_payable = gross_amount - tax_amount - advance_offset_amount),
        CONSTRAINT acceptance_records_issued_number_check
          CHECK (status IN ('draft', 'submitted', 'approved', 'cancelled') OR appendix_number IS NOT NULL)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX acceptance_records_contract_status_idx ON acceptance_records(contract_id, status)`,
    );
    await queryRunner.query(
      `CREATE INDEX acceptance_records_partner_idx ON acceptance_records(partner_id, status)`,
    );

    await queryRunner.query(`
      CREATE TABLE acceptance_items (
        id uuid PRIMARY KEY,
        acceptance_id uuid NOT NULL REFERENCES acceptance_records(id) ON DELETE CASCADE,
        line_no integer NOT NULL CHECK (line_no > 0),
        line_key varchar(120) NOT NULL,
        product_label varchar(200) NOT NULL,
        category_id uuid NULL REFERENCES categories(id) ON DELETE SET NULL,
        package_id uuid NULL REFERENCES product_packages(id) ON DELETE SET NULL,
        level varchar(10) NULL,
        rate_card_item_id uuid NULL REFERENCES rate_card_items(id) ON DELETE SET NULL,
        unit varchar(20) NOT NULL
          CHECK (unit IN ('topic', 'shot', 'clip', 'package', 'extra_scene', 'source')),
        computed_quantity numeric(12,2) NOT NULL CHECK (computed_quantity >= 0),
        quantity numeric(12,2) NOT NULL CHECK (quantity >= 0),
        computed_unit_price bigint NOT NULL CHECK (computed_unit_price >= 0),
        unit_price bigint NOT NULL CHECK (unit_price >= 0),
        computed_amount bigint NOT NULL CHECK (computed_amount >= 0),
        amount bigint NOT NULL CHECK (amount >= 0),
        metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
        adjustment_reason text NULL,
        adjusted_by varchar(128) NULL,
        adjusted_at timestamptz NULL,
        CONSTRAINT acceptance_items_line_no_key UNIQUE (acceptance_id, line_no),
        CONSTRAINT acceptance_items_line_key_key UNIQUE (acceptance_id, line_key),
        CONSTRAINT acceptance_items_adjustment_check CHECK (
          adjustment_reason IS NOT NULL
          OR (quantity = computed_quantity AND unit_price = computed_unit_price)
        )
      )
    `);

    await queryRunner.query(`
      CREATE TABLE acceptance_item_sources (
        id uuid PRIMARY KEY,
        acceptance_id uuid NOT NULL REFERENCES acceptance_records(id) ON DELETE CASCADE,
        acceptance_item_id uuid NULL REFERENCES acceptance_items(id) ON DELETE CASCADE,
        project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        project_media_id uuid NULL REFERENCES project_media(id) ON DELETE SET NULL,
        package_id uuid NULL REFERENCES product_packages(id) ON DELETE SET NULL,
        counted boolean NOT NULL,
        exclusion_reason varchar(100) NULL,
        exclusion_message text NULL,
        quantity numeric(12,2) NOT NULL DEFAULT 0,
        metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
        is_active boolean NOT NULL DEFAULT true
      )
    `);
    await queryRunner.query(
      `CREATE INDEX acceptance_item_sources_acceptance_idx ON acceptance_item_sources(acceptance_id)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX acceptance_item_sources_active_project_key
         ON acceptance_item_sources(project_id)
         WHERE is_active AND project_media_id IS NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX acceptance_item_sources_active_media_key
         ON acceptance_item_sources(project_media_id)
         WHERE is_active AND project_media_id IS NOT NULL`,
    );

    await queryRunner.query(`
      ALTER TABLE product_packages
        ADD CONSTRAINT product_packages_acceptance_id_fkey
          FOREIGN KEY (acceptance_id) REFERENCES acceptance_records(id) ON DELETE SET NULL,
        ADD CONSTRAINT product_packages_acceptance_item_id_fkey
          FOREIGN KEY (acceptance_item_id) REFERENCES acceptance_items(id) ON DELETE SET NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE product_packages
      SET acceptance_id = NULL, acceptance_item_id = NULL,
          status = CASE WHEN status = 'accepted' THEN 'evaluated' ELSE status END
      WHERE acceptance_id IS NOT NULL OR status = 'accepted'
    `);
    await queryRunner.query(`
      ALTER TABLE product_packages
        DROP CONSTRAINT IF EXISTS product_packages_acceptance_item_id_fkey,
        DROP CONSTRAINT IF EXISTS product_packages_acceptance_id_fkey
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS acceptance_item_sources`);
    await queryRunner.query(`DROP TABLE IF EXISTS acceptance_items`);
    await queryRunner.query(`DROP TABLE IF EXISTS acceptance_records`);
  }
}
