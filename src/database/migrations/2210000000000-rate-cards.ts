import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Versioned CTV rate cards (ANTGO-253, spec "dac-ta-hop-dong-nghiem-thu" 2.1.1, 7.2.1).
 *
 * `rate_cards` is one version of a code with its effective dates; `rate_card_items` one price cell
 * (product = category × level × tier, or a per-source price for Lái xe / Flycam);
 * `rate_card_level_rules` the extra-scene price and scene threshold per level.
 *
 * Seeds code `CTV-2026` from "Bảng lương CTV (chuẩn)" (D7), frozen here: version 1 until 14/07/2026,
 * version 2 from 15/07/2026 with KHÁM PHÁ +200.000đ on every cell (Q-R5). Products are matched to
 * existing categories by unaccented name or slug; missing ones are created (and removed again on
 * revert while no project uses them).
 */

const SEED_ACTOR = 'system:rate-card-seed';
const CODE = 'CTV-2026';

const PRODUCTS = [
  {
    slug: 'camping',
    name: 'Camping',
    scenes: [7, 10, 13],
    prices: {
      LV1: [800_000, 1_200_000, 1_600_000],
      LV2: [1_000_000, 1_400_000, 1_800_000],
      LV3: [1_200_000, 1_600_000, 2_000_000],
    },
  },
  {
    slug: 'kham-pha',
    name: 'Khám phá',
    scenes: [7, 10, 13],
    prices: {
      LV1: [800_000, 1_200_000, 1_600_000],
      LV2: [1_000_000, 1_400_000, 1_800_000],
      LV3: [1_200_000, 1_600_000, 2_000_000],
    },
  },
  {
    slug: 'doi-song',
    name: 'Đời sống',
    scenes: [5, 7, 9],
    prices: {
      LV1: [600_000, 1_000_000, 1_400_000],
      LV2: [800_000, 1_200_000, 1_600_000],
      LV3: [800_000, 1_200_000, 1_600_000],
    },
  },
  {
    slug: 'canh',
    name: 'Cảnh',
    scenes: [6, 10, 14],
    prices: {
      LV1: [500_000, 900_000, 1_300_000],
      LV2: [700_000, 1_100_000, 1_500_000],
      LV3: [700_000, 1_100_000, 1_500_000],
    },
  },
] as const;

const PER_SOURCE = [
  { slug: 'flycam', name: 'Flycam', price: 50_000, minSourceSeconds: 300 },
  { slug: 'lai-xe', name: 'Lái xe', price: 50_000, minSourceSeconds: 300 },
] as const;

const SOURCE_RANGES = [
  [70, 100],
  [100, 150],
  [150, 200],
] as const;

const LEVEL_RULES = [
  ['LV1', 80_000, 8],
  ['LV2', 100_000, 8],
  ['LV3', 150_000, 13],
] as const;

const VERSIONS = [
  {
    version: 1,
    from: '2026-01-01',
    to: '2026-07-14',
    surcharge: 0,
    note: 'Bảng lương CTV (chuẩn) – bảng giá gốc',
  },
  {
    version: 2,
    from: '2026-07-15',
    to: null,
    surcharge: 200_000,
    note: 'Từ 15/07/2026 đơn giá mọi gói Khám phá tăng 200.000đ',
  },
] as const;

export class RateCards2210000000000 implements MigrationInterface {
  name = 'RateCards2210000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE rate_cards (
        id uuid PRIMARY KEY,
        code varchar(50) NOT NULL,
        version integer NOT NULL CHECK (version > 0),
        effective_from date NOT NULL,
        effective_to date NULL,
        status varchar(20) NOT NULL DEFAULT 'draft'
          CHECK (status IN ('draft', 'published', 'archived')),
        note text NULL,
        duration_rule jsonb NOT NULL
          DEFAULT '{"min_seconds": 10, "preferred_seconds": 20, "preferred_ratio": 0.8, "scope": "package"}'::jsonb,
        source_file_name varchar(255) NULL,
        created_by varchar(128) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        published_by varchar(128) NULL,
        published_at timestamptz NULL,
        CONSTRAINT rate_cards_code_version_key UNIQUE (code, version),
        CONSTRAINT rate_cards_dates_check CHECK (effective_to IS NULL OR effective_to >= effective_from)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX rate_cards_code_status_idx ON rate_cards(code, status, effective_from)`,
    );
    await queryRunner.query(`
      CREATE TABLE rate_card_items (
        id uuid PRIMARY KEY,
        rate_card_id uuid NOT NULL REFERENCES rate_cards(id) ON DELETE CASCADE,
        category_id uuid NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
        level varchar(10) NOT NULL CHECK (level IN ('LV1', 'LV2', 'LV3', 'ALL')),
        pricing_type varchar(20) NOT NULL CHECK (pricing_type IN ('tier', 'per_source')),
        tier integer NULL CHECK (tier IS NULL OR tier > 0),
        source_min integer NULL CHECK (source_min IS NULL OR source_min >= 0),
        source_max integer NULL,
        scene_min integer NULL CHECK (scene_min IS NULL OR scene_min >= 0),
        price bigint NOT NULL CHECK (price >= 0),
        min_source_seconds integer NULL CHECK (min_source_seconds IS NULL OR min_source_seconds >= 0),
        CONSTRAINT rate_card_items_shape_check CHECK (
          (pricing_type = 'tier' AND tier IS NOT NULL AND level <> 'ALL')
          OR (pricing_type = 'per_source' AND tier IS NULL AND level = 'ALL')
        )
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX rate_card_items_cell_key
         ON rate_card_items(rate_card_id, category_id, level, COALESCE(tier, 0))`,
    );
    await queryRunner.query(
      `CREATE INDEX rate_card_items_category_idx ON rate_card_items(category_id)`,
    );
    await queryRunner.query(`
      CREATE TABLE rate_card_level_rules (
        rate_card_id uuid NOT NULL REFERENCES rate_cards(id) ON DELETE CASCADE,
        level varchar(10) NOT NULL CHECK (level IN ('LV1', 'LV2', 'LV3')),
        extra_scene_price bigint NOT NULL CHECK (extra_scene_price >= 0),
        extra_scene_min_sources integer NOT NULL CHECK (extra_scene_min_sources >= 0),
        PRIMARY KEY (rate_card_id, level)
      )
    `);

    await this.seed(queryRunner);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS rate_card_level_rules`);
    await queryRunner.query(`DROP TABLE IF EXISTS rate_card_items`);
    await queryRunner.query(`DROP TABLE IF EXISTS rate_cards`);
    await queryRunner.query(
      `DELETE FROM categories category
       WHERE category.created_by = $1
         AND NOT EXISTS (SELECT 1 FROM projects project WHERE project.category_id = category.id)`,
      [SEED_ACTOR],
    );
  }

  private async seed(queryRunner: QueryRunner): Promise<void> {
    const categoryIds = new Map<string, string>();
    for (const product of [...PRODUCTS, ...PER_SOURCE]) {
      categoryIds.set(product.slug, await this.category(queryRunner, product.slug, product.name));
    }
    for (const version of VERSIONS) {
      const [{ id: rateCardId }] = (await queryRunner.query(
        `INSERT INTO rate_cards (id, code, version, effective_from, effective_to, status, note,
           created_by, published_by, published_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'published', $5, $6, $6, now())
         RETURNING id`,
        [CODE, version.version, version.from, version.to, version.note, SEED_ACTOR],
      )) as Array<{ id: string }>;
      for (const product of PRODUCTS) {
        for (const level of ['LV1', 'LV2', 'LV3'] as const) {
          for (let index = 0; index < 3; index += 1) {
            const surcharge = product.slug === 'kham-pha' ? version.surcharge : 0;
            await queryRunner.query(
              `INSERT INTO rate_card_items (id, rate_card_id, category_id, level, pricing_type, tier,
                 source_min, source_max, scene_min, price)
               VALUES (gen_random_uuid(), $1, $2, $3, 'tier', $4, $5, $6, $7, $8)`,
              [
                rateCardId,
                categoryIds.get(product.slug),
                level,
                index + 1,
                SOURCE_RANGES[index][0],
                SOURCE_RANGES[index][1],
                product.scenes[index],
                product.prices[level][index] + surcharge,
              ],
            );
          }
        }
      }
      for (const product of PER_SOURCE) {
        await queryRunner.query(
          `INSERT INTO rate_card_items (id, rate_card_id, category_id, level, pricing_type, price,
             min_source_seconds)
           VALUES (gen_random_uuid(), $1, $2, 'ALL', 'per_source', $3, $4)`,
          [rateCardId, categoryIds.get(product.slug), product.price, product.minSourceSeconds],
        );
      }
      for (const [level, price, minSources] of LEVEL_RULES) {
        await queryRunner.query(
          `INSERT INTO rate_card_level_rules (rate_card_id, level, extra_scene_price,
             extra_scene_min_sources)
           VALUES ($1, $2, $3, $4)`,
          [rateCardId, level, price, minSources],
        );
      }
    }
  }

  /** Existing category by slug or unaccented name (e.g. "KHÁM PHÁ" → kham-pha), else a new one. */
  private async category(queryRunner: QueryRunner, slug: string, name: string): Promise<string> {
    const found = (await queryRunner.query(
      `SELECT id FROM categories
       WHERE slug = $1
          OR trim(both '-' from regexp_replace(lower(immutable_unaccent(name)), '[^a-z0-9]+', '-', 'g')) = $1
       ORDER BY (slug = $1) DESC, created_at ASC
       LIMIT 1`,
      [slug],
    )) as Array<{ id: string }>;
    if (found.length > 0) {
      return found[0].id;
    }
    const [created] = (await queryRunner.query(
      `INSERT INTO categories (id, name, slug, sort_order, is_active, created_by)
       VALUES (gen_random_uuid(), $1, $2, 0, true, $3)
       RETURNING id`,
      [name, slug, SEED_ACTOR],
    )) as Array<{ id: string }>;
    return created.id;
  }
}
