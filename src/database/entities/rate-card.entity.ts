import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import type {
  CtvLevel,
  RateCardLevel,
  RateCardPricingType,
  RateCardStatus,
} from '../../modules/pricing-engine/rate-card';

const bigintNumber = {
  to: (value: number | null | undefined) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};

/** Duration rule as stored (snake_case JSON, spec 7.2.1). */
export type StoredDurationRule = {
  min_seconds: number;
  preferred_seconds: number;
  preferred_ratio: number;
  scope?: string;
};

/**
 * One version of a CTV rate card (spec 7.2.1). A price change is a new version with its own
 * effective date; published versions are never edited. Only `published` versions price packages.
 */
@Entity('rate_cards')
export class RateCardEntity {
  @PrimaryColumn('uuid')
  id!: string;

  /** e.g. `CTV-2026`; contracts reference it in `pricing_config.rate_card_id`. */
  @Column({ type: 'varchar', length: 50 })
  code!: string;

  /** Increasing per code. */
  @Column({ type: 'integer' })
  version!: number;

  @Column({ name: 'effective_from', type: 'date' })
  effectiveFrom!: string;

  /** Null: in force until a later version is published. */
  @Column({ name: 'effective_to', type: 'date', nullable: true })
  effectiveTo!: string | null;

  @Column({ type: 'varchar', length: 20, default: 'draft' })
  status!: RateCardStatus;

  /** Why the prices changed. */
  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ name: 'duration_rule', type: 'jsonb' })
  durationRule!: StoredDurationRule;

  /** Excel file the version was imported from, if any. */
  @Column({ name: 'source_file_name', type: 'varchar', length: 255, nullable: true })
  sourceFileName!: string | null;

  @Column({ name: 'created_by', type: 'varchar', length: 128 })
  createdBy!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'published_by', type: 'varchar', length: 128, nullable: true })
  publishedBy!: string | null;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;
}

/** One price cell: product (category) × level × tier, or the per-source price of a product. */
@Entity('rate_card_items')
export class RateCardItemEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'rate_card_id', type: 'uuid' })
  rateCardId!: string;

  @Column({ name: 'category_id', type: 'uuid' })
  categoryId!: string;

  @Column({ type: 'varchar', length: 10 })
  level!: RateCardLevel;

  @Column({ name: 'pricing_type', type: 'varchar', length: 20 })
  pricingType!: RateCardPricingType;

  @Column({ type: 'integer', nullable: true })
  tier!: number | null;

  @Column({ name: 'source_min', type: 'integer', nullable: true })
  sourceMin!: number | null;

  /** Display only (BR-13). */
  @Column({ name: 'source_max', type: 'integer', nullable: true })
  sourceMax!: number | null;

  @Column({ name: 'scene_min', type: 'integer', nullable: true })
  sceneMin!: number | null;

  @Column({ type: 'bigint', transformer: bigintNumber })
  price!: number;

  @Column({ name: 'min_source_seconds', type: 'integer', nullable: true })
  minSourceSeconds!: number | null;
}

/** Extra-scene price and scene threshold of one level (spec 7.2.1). */
@Entity('rate_card_level_rules')
export class RateCardLevelRuleEntity {
  @PrimaryColumn({ name: 'rate_card_id', type: 'uuid' })
  rateCardId!: string;

  @PrimaryColumn({ type: 'varchar', length: 10 })
  level!: CtvLevel;

  @Column({ name: 'extra_scene_price', type: 'bigint', transformer: bigintNumber })
  extraScenePrice!: number;

  @Column({ name: 'extra_scene_min_sources', type: 'integer' })
  extraSceneMinSources!: number;
}
