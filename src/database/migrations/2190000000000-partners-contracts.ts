import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Partners and contracts, phase 1 of ANTGO-251 (spec "dac-ta-hop-dong-nghiem-thu" 7.1–7.3).
 *
 * `partners` is a thin record over an AG Account user: personal data stays in AG Account. Each AG
 * Go user (`go_user_id`) and each AG Account user (`account_user_id`) is at most one partner.
 * `contracts` keeps the terms (pricing model and config, ceiling, advance, tech spec) and the
 * encrypted partner snapshot taken when issued; `contract_amendments` changes the terms of an
 * active contract from an effective date.
 */
export class PartnersContracts2190000000000 implements MigrationInterface {
  name = 'PartnersContracts2190000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE partners (
        id uuid PRIMARY KEY,
        account_user_id varchar(36) NOT NULL,
        go_user_id varchar(128) NOT NULL,
        code varchar(20) NOT NULL,
        display_name varchar(200) NOT NULL,
        manager_user_id varchar(128) NOT NULL,
        status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
        profile_checked_at timestamptz NULL,
        profile_missing_fields jsonb NULL,
        note text NULL,
        created_by varchar(128) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT partners_account_user_id_key UNIQUE (account_user_id),
        CONSTRAINT partners_go_user_id_key UNIQUE (go_user_id),
        CONSTRAINT partners_code_key UNIQUE (code)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX partners_manager_user_id_idx ON partners(manager_user_id, status)`,
    );

    await queryRunner.query(`
      CREATE TABLE contracts (
        id uuid PRIMARY KEY,
        partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
        contract_number varchar(60) NOT NULL,
        contract_type varchar(30) NOT NULL DEFAULT 'content_production'
          CHECK (contract_type IN ('content_production')),
        signed_date date NULL,
        start_date date NOT NULL,
        end_date date NULL,
        status varchar(20) NOT NULL DEFAULT 'draft'
          CHECK (status IN ('draft', 'issued', 'active', 'suspended', 'completed', 'terminated')),
        pricing_model varchar(20) NOT NULL
          CHECK (pricing_model IN ('per_topic', 'per_unit', 'package_tier')),
        pricing_config jsonb NOT NULL,
        cap_amount bigint NULL CHECK (cap_amount IS NULL OR cap_amount >= 0),
        advance_amount bigint NOT NULL DEFAULT 0 CHECK (advance_amount >= 0),
        advance_due_business_days integer NULL CHECK (advance_due_business_days >= 0),
        advance_offset_rule varchar(20) NOT NULL DEFAULT 'full_first'
          CHECK (advance_offset_rule IN ('full_first', 'proportional')),
        acceptance_cycle varchar(10) NOT NULL
          CHECK (acceptance_cycle IN ('on_demand', 'weekly', 'monthly')),
        delivery_rule jsonb NULL,
        payment_term_business_days integer NOT NULL CHECK (payment_term_business_days >= 0),
        tech_spec jsonb NOT NULL,
        penalty_percent numeric(5,2) NOT NULL DEFAULT 8,
        originality_min_percent integer NULL,
        similarity_max_percent integer NULL DEFAULT 30,
        non_compete_months integer NULL DEFAULT 24,
        template_version_id uuid NULL,
        manager_user_id varchar(128) NOT NULL,
        partner_snapshot_enc text NULL,
        partner_snapshot_at timestamptz NULL,
        last_appendix_number integer NOT NULL DEFAULT 0 CHECK (last_appendix_number >= 0),
        source varchar(20) NOT NULL DEFAULT 'system' CHECK (source IN ('system', 'legacy_import')),
        legacy_accepted_amount bigint NULL,
        legacy_paid_amount bigint NULL,
        legacy_advance_balance bigint NULL,
        signed_file_id uuid NULL,
        activation_note text NULL,
        suspended_reason text NULL,
        terminated_reason text NULL,
        note text NULL,
        issued_at timestamptz NULL,
        issued_by varchar(128) NULL,
        activated_at timestamptz NULL,
        activated_by varchar(128) NULL,
        closed_at timestamptz NULL,
        created_by varchar(128) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT contracts_contract_number_key UNIQUE (contract_number),
        CONSTRAINT contracts_advance_cap_check
          CHECK (cap_amount IS NULL OR advance_amount <= cap_amount),
        CONSTRAINT contracts_advance_due_check
          CHECK (advance_amount = 0 OR advance_due_business_days IS NOT NULL),
        CONSTRAINT contracts_dates_check CHECK (end_date IS NULL OR end_date >= start_date)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX contracts_partner_id_idx ON contracts(partner_id, status)`,
    );
    await queryRunner.query(
      `CREATE INDEX contracts_manager_user_id_idx ON contracts(manager_user_id, status)`,
    );

    await queryRunner.query(`
      CREATE TABLE contract_amendments (
        id uuid PRIMARY KEY,
        contract_id uuid NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
        amendment_number integer NOT NULL CHECK (amendment_number > 0),
        effective_date date NOT NULL,
        changes jsonb NOT NULL,
        reason text NULL,
        status varchar(20) NOT NULL DEFAULT 'draft'
          CHECK (status IN ('draft', 'issued', 'signed')),
        signed_file_id uuid NULL,
        created_by varchar(128) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT contract_amendments_number_key UNIQUE (contract_id, amendment_number)
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS contract_amendments`);
    await queryRunner.query(`DROP TABLE IF EXISTS contracts`);
    await queryRunner.query(`DROP TABLE IF EXISTS partners`);
  }
}
