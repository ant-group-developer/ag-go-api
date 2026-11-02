import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { refreshProjectMediaSummary } from '../../media/project-media-summary';

/**
 * Rows for the db-spec tests of packages and acceptance records (real Postgres, migrations run):
 * partners, contracts, projects of a folder and their videos with analysed durations.
 */
export class ContractFixtures {
  readonly folderId = randomUUID();
  readonly partnerIds: string[] = [];
  readonly assetIds: string[] = [];
  private counter = 0;

  constructor(
    private readonly ds: DataSource,
    readonly suffix = randomUUID().slice(0, 5).toUpperCase(),
  ) {}

  async setup() {
    await this.ds.query(
      `INSERT INTO folders (id, parent_id, name, path_key, path_ids, path_text, depth, sort_order, is_active, created_by)
       VALUES ($1, NULL, $2, $3, '{}', $4, 0, 0, true, 'test')`,
      [
        this.folderId,
        `Fixtures ${this.folderId.slice(0, 8)}`,
        `/${this.folderId}`,
        `Fixtures ${this.folderId.slice(0, 8)}`,
      ],
    );
  }

  async cleanup() {
    const [{ acceptances }] = (await this.ds.query(
      `SELECT to_regclass('acceptance_records') IS NOT NULL AS acceptances`,
    )) as Array<{ acceptances: boolean }>;
    const [{ payments }] = (await this.ds.query(
      `SELECT to_regclass('payments') IS NOT NULL AS payments`,
    )) as Array<{ payments: boolean }>;
    if (payments) {
      await this.ds.query(`DELETE FROM payments WHERE partner_id = ANY($1::uuid[])`, [
        this.partnerIds,
      ]);
    }
    if (acceptances) {
      await this.ds.query(
        `DELETE FROM acceptance_records WHERE contract_id IN
           (SELECT id FROM contracts WHERE partner_id = ANY($1::uuid[]))`,
        [this.partnerIds],
      );
    }
    await this.ds.query(`DELETE FROM projects WHERE folder_id = $1`, [this.folderId]);
    await this.ds.query(`DELETE FROM product_packages WHERE partner_id = ANY($1::uuid[])`, [
      this.partnerIds,
    ]);
    await this.ds.query(`DELETE FROM assets WHERE id = ANY($1::uuid[])`, [this.assetIds]);
    await this.ds.query(`DELETE FROM contracts WHERE partner_id = ANY($1::uuid[])`, [
      this.partnerIds,
    ]);
    await this.ds.query(`DELETE FROM partners WHERE id = ANY($1::uuid[])`, [this.partnerIds]);
    await this.ds.query(`DELETE FROM folders WHERE id = $1`, [this.folderId]);
  }

  async categoryId(slug: string): Promise<string> {
    const [row] = (await this.ds.query(`SELECT id FROM categories WHERE slug = $1`, [
      slug,
    ])) as Array<{ id: string }>;
    if (!row) {
      throw new Error(`No category ${slug}`);
    }
    return row.id;
  }

  async partner(managerUserId: string) {
    const id = randomUUID();
    const goUserId = `go-${randomUUID()}`;
    this.counter += 1;
    const code = `F${this.suffix}${this.counter}`;
    await this.ds.query(
      `INSERT INTO partners (id, account_user_id, go_user_id, code, display_name, manager_user_id, status, created_by)
       VALUES ($1, $2, $3, $4, 'Nguyễn Văn Test', $5, 'active', 'test')`,
      [id, randomUUID(), goUserId, code, managerUserId],
    );
    this.partnerIds.push(id);
    return { id, goUserId, code };
  }

  async contract(
    partnerId: string,
    managerUserId: string,
    options: {
      pricingModel?: string;
      pricingConfig?: Record<string, unknown>;
      status?: string;
      startDate?: string;
      capAmount?: number | null;
      advanceAmount?: number;
      advanceOffsetRule?: string;
      lastAppendixNumber?: number;
      techSpec?: Record<string, unknown>;
    } = {},
  ) {
    const id = randomUUID();
    await this.ds.query(
      `INSERT INTO contracts (id, partner_id, contract_number, start_date, status, pricing_model,
         pricing_config, cap_amount, advance_amount, advance_due_business_days, advance_offset_rule,
         acceptance_cycle, payment_term_business_days, tech_spec, manager_user_id,
         last_appendix_number, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'monthly', 10, $12, $13, $14, 'test')`,
      [
        id,
        partnerId,
        `${id.slice(0, 8)}/HĐSXND/AG-T`,
        options.startDate ?? '2026-01-01',
        options.status ?? 'active',
        options.pricingModel ?? 'package_tier',
        JSON.stringify(options.pricingConfig ?? {}),
        options.capAmount ?? null,
        options.advanceAmount ?? 0,
        options.advanceAmount ? 5 : null,
        options.advanceOffsetRule ?? 'full_first',
        JSON.stringify(options.techSpec ?? {}),
        managerUserId,
        options.lastAppendixNumber ?? 0,
      ],
    );
    return id;
  }

  /** An advance actually paid under the contract (payments, kind `advance`). */
  async advancePaid(contractId: string, amount: number, paidDate = '2026-08-05') {
    const id = randomUUID();
    await this.ds.query(
      `INSERT INTO payments (id, contract_id, partner_id, kind, amount, paid_date, created_by)
       SELECT $1, id, partner_id, 'advance', $3, $4, 'test' FROM contracts WHERE id = $2`,
      [id, contractId, amount, paidDate],
    );
    return id;
  }

  async project(
    ownerUserId: string,
    options: {
      categoryId?: string | null;
      contractId?: string | null;
      deliveredAt?: string | null;
      name?: string;
    } = {},
  ) {
    const id = randomUUID();
    await this.ds.query(
      `INSERT INTO projects (id, owner_user_id, folder_id, name, evaluation_status, category_id,
         contract_id, delivered_at)
       VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7)`,
      [
        id,
        ownerUserId,
        this.folderId,
        options.name ?? `Project ${id.slice(0, 8)}`,
        options.categoryId ?? null,
        options.contractId ?? null,
        options.deliveredAt ?? null,
      ],
    );
    return id;
  }

  /**
   * Videos of `projectId` with these durations (seconds, null = never analysed) and evaluation
   * status, then the project's evaluation recalculated (as uploads and evaluations do).
   */
  async videos(
    projectId: string,
    durations: ReadonlyArray<number | null>,
    status: 'pending' | 'approved' | 'rejected' = 'pending',
  ) {
    const assetIds = durations.map(() => randomUUID());
    const mediaIds = durations.map(() => randomUUID());
    this.assetIds.push(...assetIds);
    await this.ds.query(
      `INSERT INTO assets (id, asset_type, original_filename, mime_type, file_size_bytes, storage_provider,
         original_bucket, original_storage_key, processing_status, source_type, source_metadata, created_by)
       SELECT asset_id, 'video', 'clip-' || asset_id || '.mp4', 'video/mp4', 1024, 'r2', 'ag-go',
              'test/' || asset_id || '.mp4', 'ready', 'local', '{}', 'test'
       FROM unnest($1::uuid[]) AS asset_id`,
      [assetIds],
    );
    await this.ds.query(
      `INSERT INTO asset_analyses (id, asset_id, status, extract_version, prompt_version, is_current,
         artifacts, technical, duration_ms, has_audio, usable, quality, completed_at)
       SELECT gen_random_uuid(), input.asset_id, 'completed', 'x2', 'p2', true,
              '{"media": {"width": 3840, "height": 2160, "fps": 59.94}}', '{"dead": false}',
              (input.seconds * 1000)::int, true, true, 4, now()
       FROM unnest($1::uuid[], $2::numeric[]) AS input(asset_id, seconds)
       WHERE input.seconds IS NOT NULL`,
      [assetIds, durations],
    );
    await this.ds.query(
      `INSERT INTO project_media (id, project_id, asset_id, sort_order, evaluation_status, created_by)
       SELECT input.media_id, $1, input.asset_id, input.ordinality, $4, 'test'
       FROM unnest($2::uuid[], $3::uuid[]) WITH ORDINALITY AS input(media_id, asset_id, ordinality)`,
      [projectId, mediaIds, assetIds, status],
    );
    await this.refresh(projectId);
    return mediaIds;
  }

  /** Sets every media of the project to `status` and recalculates its evaluation. */
  async evaluate(projectId: string, status: 'pending' | 'approved' | 'rejected') {
    await this.ds.query(`UPDATE project_media SET evaluation_status = $2 WHERE project_id = $1`, [
      projectId,
      status,
    ]);
    await this.refresh(projectId);
  }

  async refresh(projectId: string) {
    await this.ds.transaction((manager) => refreshProjectMediaSummary(manager, projectId));
  }
}
