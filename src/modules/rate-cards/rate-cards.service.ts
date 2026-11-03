import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { ListResponseDto } from '../../common/dto/list-response.dto';
import {
  RateCardEntity,
  RateCardItemEntity,
  RateCardLevelRuleEntity,
  type StoredDurationRule,
} from '../../database/entities/rate-card.entity';
import { SystemLogService } from '../logs/system-log.service';
import type { PartnerActor } from '../partners/partner-actor';
import { previousDay } from '../pricing-engine/business-days';
import { DEFAULT_DURATION_RULE, type DurationRule } from '../pricing-engine/durations';
import {
  validateRateCard,
  type RateCardContent,
  type RateCardItemData,
  type RateCardStatus,
} from '../pricing-engine/rate-card';
import type {
  CloneRateCardDto,
  CreateRateCardDto,
  ImportRateCardDto,
  ListRateCardsQueryDto,
  UpdateRateCardDto,
} from './dto/rate-card.dto';
import {
  buildRateCardWorkbook,
  MAX_RATE_CARD_FILE_SIZE_BYTES,
  parseRateCardWorkbook,
  type ExcelCategory,
} from './rate-card-excel';

export const RATE_CARD_AUDIT_CATEGORY = 'rate_card';

export const RATE_CARD_ERROR_CODES = {
  NOT_FOUND: 'RATE_CARD_NOT_FOUND',
  INVALID: 'RATE_CARD_INVALID',
  LOCKED: 'RATE_CARD_LOCKED',
  EFFECTIVE_FROM_INVALID: 'RATE_CARD_EFFECTIVE_FROM_INVALID',
  NOT_IN_FORCE: 'RATE_CARD_NOT_IN_FORCE',
  FILE_INVALID: 'RATE_CARD_FILE_INVALID',
} as const;

export type RateCardFile = { buffer: Buffer; originalname: string; size: number };

export type RateCardItemResponse = RateCardItemData & { id: string; categoryName: string | null };

export type RateCardDetail = Omit<RateCardEntity, 'durationRule'> & {
  durationRule: DurationRule;
  items: RateCardItemResponse[];
  levelRules: Array<Omit<RateCardLevelRuleEntity, 'rateCardId'>>;
  allowedActions: Array<'update' | 'publish' | 'archive' | 'delete' | 'clone'>;
};

/** A rate card version with its content, as the pricing reads it. */
export type RateCardInForce = {
  id: string;
  code: string;
  version: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  content: RateCardContent;
};

export function toDurationRule(stored: StoredDurationRule | null | undefined): DurationRule {
  if (!stored) {
    return { ...DEFAULT_DURATION_RULE };
  }
  return {
    minSeconds: stored.min_seconds,
    preferredSeconds: stored.preferred_seconds,
    preferredRatio: stored.preferred_ratio,
  };
}

function fromDurationRule(rule: DurationRule): StoredDurationRule {
  return {
    min_seconds: rule.minSeconds,
    preferred_seconds: rule.preferredSeconds,
    preferred_ratio: rule.preferredRatio,
    scope: 'package',
  };
}

function allowedActions(status: RateCardStatus): RateCardDetail['allowedActions'] {
  if (status === 'draft') {
    return ['update', 'publish', 'archive', 'delete', 'clone'];
  }
  if (status === 'published') {
    return ['archive', 'clone'];
  }
  return ['clone'];
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Versioned CTV rate cards (spec 7.2.1): drafts are edited freely, publishing fixes the prices and
 * closes the previous version the day before; the version in force on a day prices packages
 * (Q-R1). Excel import / export follows the D7 layout.
 */
@Injectable()
export class RateCardsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly systemLog: SystemLogService,
  ) {}

  async list(query: ListRateCardsQueryDto) {
    const builder = this.dataSource.getRepository(RateCardEntity).createQueryBuilder('card');
    if (query.code) {
      builder.andWhere('card.code = :code', { code: query.code.trim() });
    }
    if (query.status) {
      builder.andWhere('card.status = :status', { status: query.status });
    }
    const [rows, total] = await builder
      .orderBy('card.code', 'ASC')
      .addOrderBy('card.version', 'DESC')
      .skip(query.skip)
      .take(query.pageSize)
      .getManyAndCount();
    const counts = (await this.dataSource.query(
      `SELECT rate_card_id AS id, count(*)::int AS count FROM rate_card_items
       WHERE rate_card_id = ANY($1::uuid[]) GROUP BY rate_card_id`,
      [rows.map((row) => row.id)],
    )) as Array<{ id: string; count: number }>;
    const byId = new Map(counts.map((row) => [row.id, row.count]));
    return new ListResponseDto(
      rows.map((row) => ({
        ...row,
        durationRule: toDurationRule(row.durationRule),
        itemCount: byId.get(row.id) ?? 0,
        allowedActions: allowedActions(row.status),
      })),
      query.page,
      query.pageSize,
      total,
    );
  }

  async get(id: string): Promise<RateCardDetail> {
    return this.detail(this.dataSource.manager, id);
  }

  /** The published version of `code` in force on `date` (default today). */
  async effective(code: string, date: string | undefined): Promise<RateCardDetail> {
    const day = date ?? today();
    const found = await findRateCardInForce(this.dataSource.manager, code.trim(), day);
    if (!found) {
      throw new NotFoundException({
        code: RATE_CARD_ERROR_CODES.NOT_IN_FORCE,
        message: `No published version of rate card ${code} on ${day}`,
      });
    }
    return this.get(found.id);
  }

  async create(dto: CreateRateCardDto, actor: PartnerActor, sourceFileName?: string) {
    const content: RateCardContent = {
      durationRule: dto.durationRule ?? { ...DEFAULT_DURATION_RULE },
      items: (dto.items ?? []).map((item) => normalizeItem(item)),
      levelRules: dto.levelRules ?? [],
    };
    await this.assertValid(content);
    const id = await this.dataSource.transaction(async (manager) => {
      const code = dto.code.trim();
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`rate_card:${code}`]);
      const [{ next }] = (await manager.query(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM rate_cards WHERE code = $1`,
        [code],
      )) as Array<{ next: number }>;
      const card = manager.create(RateCardEntity, {
        id: uuidv7(),
        code,
        version: Number(next),
        effectiveFrom: dto.effectiveFrom,
        effectiveTo: null,
        status: 'draft',
        note: dto.note?.trim() || null,
        durationRule: fromDurationRule(content.durationRule),
        sourceFileName: sourceFileName ?? null,
        createdBy: actor.userId,
      });
      await manager.save(card);
      await this.writeContent(manager, card.id, content);
      return card.id;
    });
    const detail = await this.get(id);
    await this.audit(actor, 'RATE_CARD_CREATED', detail, { items: detail.items.length });
    return detail;
  }

  async update(id: string, dto: UpdateRateCardDto, actor: PartnerActor) {
    await this.dataSource.transaction(async (manager) => {
      const card = await this.lockDraft(manager, id);
      const current = await loadContent(manager, id, card.durationRule);
      const content: RateCardContent = {
        durationRule: dto.durationRule ?? current.durationRule,
        items: dto.items ? dto.items.map((item) => normalizeItem(item)) : current.items,
        levelRules: dto.levelRules ?? current.levelRules,
      };
      await this.assertValid(content, manager);
      if (dto.effectiveFrom !== undefined) {
        card.effectiveFrom = dto.effectiveFrom;
      }
      if (dto.note !== undefined) {
        card.note = dto.note?.trim() || null;
      }
      card.durationRule = fromDurationRule(content.durationRule);
      await manager.save(card);
      if (dto.items || dto.levelRules) {
        await this.writeContent(manager, id, content);
      }
    });
    const detail = await this.get(id);
    await this.audit(actor, 'RATE_CARD_UPDATED', detail, {
      fields: Object.keys(dto).filter((key) => dto[key as keyof UpdateRateCardDto] !== undefined),
    });
    return detail;
  }

  /** New draft (next version of the same code) with the content of `id` ("Tạo phiên bản mới"). */
  async clone(id: string, dto: CloneRateCardDto, actor: PartnerActor) {
    const source = await this.get(id);
    return this.create(
      {
        code: source.code,
        effectiveFrom: dto.effectiveFrom ?? source.effectiveFrom,
        note: dto.note ?? `Tạo từ phiên bản ${source.version}`,
        durationRule: source.durationRule,
        items: source.items.map((item) => ({
          categoryId: item.categoryId,
          level: item.level,
          pricingType: item.pricingType,
          tier: item.tier,
          sourceMin: item.sourceMin,
          sourceMax: item.sourceMax,
          sceneMin: item.sceneMin,
          price: item.price,
          minSourceSeconds: item.minSourceSeconds,
        })),
        levelRules: source.levelRules.map((rule) => ({ ...rule })),
      },
      actor,
    );
  }

  /**
   * draft → published. The version must start after every published version of its code; the one
   * in force until then ends the day before (spec 7.2.1: a price change never edits a version).
   */
  async publish(id: string, effectiveFrom: string | undefined, actor: PartnerActor) {
    const closed = await this.dataSource.transaction(async (manager) => {
      const card = await this.lockDraft(manager, id);
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`rate_card:${card.code}`]);
      const from = effectiveFrom ?? card.effectiveFrom;
      const content = await loadContent(manager, id, card.durationRule);
      await this.assertValid(content, manager);
      if (content.items.length === 0) {
        throw this.invalid(['Bảng giá chưa có ô giá nào']);
      }
      const [latest] = (await manager.query(
        `SELECT id, version, effective_from::text AS "effectiveFrom" FROM rate_cards
         WHERE code = $1 AND status = 'published'
         ORDER BY effective_from DESC, version DESC LIMIT 1`,
        [card.code],
      )) as Array<{ id: string; version: number; effectiveFrom: string }>;
      if (latest && latest.effectiveFrom >= from) {
        throw new ConflictException({
          code: RATE_CARD_ERROR_CODES.EFFECTIVE_FROM_INVALID,
          message: `effectiveFrom must be after ${latest.effectiveFrom}, the start of published version ${latest.version}`,
        });
      }
      const ended = (await manager.query(
        `UPDATE rate_cards SET effective_to = $3, updated_at = now()
         WHERE code = $1 AND status = 'published' AND id <> $2
           AND (effective_to IS NULL OR effective_to >= $4)
         RETURNING version`,
        [card.code, id, previousDay(from), from],
      )) as [Array<{ version: number }>, number];
      card.effectiveFrom = from;
      card.status = 'published';
      card.publishedAt = new Date();
      card.publishedBy = actor.userId;
      await manager.save(card);
      return (ended[0] ?? []).map((row) => row.version);
    });
    const detail = await this.get(id);
    await this.audit(actor, 'RATE_CARD_PUBLISHED', detail, {
      effectiveFrom: detail.effectiveFrom,
      endedVersions: closed,
    });
    return detail;
  }

  /** Out of pricing for good (draft or published). */
  async archive(id: string, actor: PartnerActor) {
    await this.dataSource.transaction(async (manager) => {
      const card = await this.lock(manager, id);
      if (card.status === 'archived') {
        throw this.locked('The rate card is already archived');
      }
      card.status = 'archived';
      await manager.save(card);
    });
    const detail = await this.get(id);
    await this.audit(actor, 'RATE_CARD_ARCHIVED', detail, {});
    return detail;
  }

  async remove(id: string, actor: PartnerActor): Promise<void> {
    const detail = await this.get(id);
    await this.dataSource.transaction(async (manager) => {
      await this.lockDraft(manager, id);
      await manager.delete(RateCardEntity, { id });
    });
    await this.audit(actor, 'RATE_CARD_DELETED', detail, {});
  }

  async exportXlsx(id: string): Promise<{ fileName: string; buffer: Buffer }> {
    const detail = await this.get(id);
    const categories = await this.categories(
      this.dataSource.manager,
      detail.items.map((item) => item.categoryId),
    );
    const buffer = await buildRateCardWorkbook(
      { durationRule: detail.durationRule, items: detail.items, levelRules: detail.levelRules },
      categories,
      detail,
    );
    return { fileName: `bang-gia-${detail.code}-v${detail.version}.xlsx`, buffer };
  }

  /** New draft from an Excel file in the D7 layout (all or nothing). */
  async importXlsx(file: RateCardFile | undefined, dto: ImportRateCardDto, actor: PartnerActor) {
    if (!file || file.size === 0) {
      throw this.fileInvalid(['Vui lòng chọn file Excel (.xlsx).']);
    }
    if (!file.originalname.toLowerCase().endsWith('.xlsx')) {
      throw this.fileInvalid(['Chỉ chấp nhận file .xlsx.']);
    }
    if (file.size > MAX_RATE_CARD_FILE_SIZE_BYTES) {
      throw this.fileInvalid(['File Excel không được vượt quá 5 MB.']);
    }
    const categories = await this.categories(this.dataSource.manager);
    const parsed = await parseRateCardWorkbook(file.buffer, categories);
    const problems = [...parsed.errors, ...validateRateCard(parsed.content)];
    if (problems.length > 0) {
      throw this.fileInvalid(problems, parsed.warnings);
    }
    const detail = await this.create(
      {
        code: dto.code,
        effectiveFrom: dto.effectiveFrom,
        note: dto.note,
        durationRule: parsed.content.durationRule,
        items: parsed.content.items.map((item) => ({ ...item })),
        levelRules: [...parsed.content.levelRules],
      },
      actor,
      file.originalname,
    );
    return { ...detail, warnings: parsed.warnings };
  }

  // -------------------------------------------------------------------------

  private async detail(manager: EntityManager, id: string): Promise<RateCardDetail> {
    const card = await manager.findOne(RateCardEntity, { where: { id } });
    if (!card) {
      throw new NotFoundException({
        code: RATE_CARD_ERROR_CODES.NOT_FOUND,
        message: 'Rate card not found',
      });
    }
    const items = (await manager.query(
      `SELECT item.id, item.category_id AS "categoryId", category.name AS "categoryName",
              item.level, item.pricing_type AS "pricingType", item.tier,
              item.source_min AS "sourceMin", item.source_max AS "sourceMax",
              item.scene_min AS "sceneMin", item.price::bigint AS price,
              item.min_source_seconds AS "minSourceSeconds"
       FROM rate_card_items item
       LEFT JOIN categories category ON category.id = item.category_id
       WHERE item.rate_card_id = $1
       ORDER BY category.name ASC, item.pricing_type ASC, item.level ASC, item.tier ASC NULLS FIRST`,
      [id],
    )) as Array<RateCardItemResponse & { price: string }>;
    const levelRules = await manager.find(RateCardLevelRuleEntity, {
      where: { rateCardId: id },
      order: { level: 'ASC' },
    });
    return {
      ...card,
      durationRule: toDurationRule(card.durationRule),
      items: items.map((item) => ({ ...item, price: Number(item.price) })),
      levelRules: levelRules.map(({ level, extraScenePrice, extraSceneMinSources }) => ({
        level,
        extraScenePrice,
        extraSceneMinSources,
      })),
      allowedActions: allowedActions(card.status),
    };
  }

  private async writeContent(manager: EntityManager, id: string, content: RateCardContent) {
    await manager.delete(RateCardItemEntity, { rateCardId: id });
    await manager.delete(RateCardLevelRuleEntity, { rateCardId: id });
    if (content.items.length > 0) {
      await manager.insert(
        RateCardItemEntity,
        content.items.map((item) => ({
          id: uuidv7(),
          rateCardId: id,
          categoryId: item.categoryId,
          level: item.level,
          pricingType: item.pricingType,
          tier: item.tier,
          sourceMin: item.sourceMin,
          sourceMax: item.sourceMax,
          sceneMin: item.sceneMin,
          price: item.price,
          minSourceSeconds: item.minSourceSeconds,
        })),
      );
    }
    if (content.levelRules.length > 0) {
      await manager.insert(
        RateCardLevelRuleEntity,
        content.levelRules.map((rule) => ({ rateCardId: id, ...rule })),
      );
    }
  }

  private async assertValid(content: RateCardContent, manager = this.dataSource.manager) {
    const errors = validateRateCard(content);
    const ids = [...new Set(content.items.map((item) => item.categoryId))];
    if (ids.length > 0) {
      const known = new Set((await this.categories(manager, ids)).map((category) => category.id));
      const missing = ids.filter((categoryId) => !known.has(categoryId));
      if (missing.length > 0) {
        errors.push(`items: không có danh mục ${missing.join(', ')}`);
      }
    }
    if (errors.length > 0) {
      throw this.invalid(errors);
    }
  }

  private async categories(manager: EntityManager, ids?: string[]): Promise<ExcelCategory[]> {
    return (await manager.query(
      ids
        ? `SELECT id, name, slug FROM categories WHERE id = ANY($1::uuid[])`
        : `SELECT id, name, slug FROM categories WHERE is_active = true`,
      ids ? [ids] : [],
    )) as ExcelCategory[];
  }

  private async lock(manager: EntityManager, id: string) {
    const card = await manager.findOne(RateCardEntity, {
      where: { id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!card) {
      throw new NotFoundException({
        code: RATE_CARD_ERROR_CODES.NOT_FOUND,
        message: 'Rate card not found',
      });
    }
    return card;
  }

  private async lockDraft(manager: EntityManager, id: string) {
    const card = await this.lock(manager, id);
    if (card.status !== 'draft') {
      throw this.locked('Only a draft rate card can be changed; clone it into a new version');
    }
    return card;
  }

  private locked(message: string) {
    return new ConflictException({ code: RATE_CARD_ERROR_CODES.LOCKED, message });
  }

  private invalid(errors: string[]) {
    return new BadRequestException({
      code: RATE_CARD_ERROR_CODES.INVALID,
      message: 'Rate card is invalid',
      details: { errors },
    });
  }

  private fileInvalid(errors: string[], warnings: string[] = []) {
    return new BadRequestException({
      code: RATE_CARD_ERROR_CODES.FILE_INVALID,
      message: 'The Excel file cannot be imported',
      details: { errors, warnings },
    });
  }

  private async audit(
    actor: PartnerActor,
    action: string,
    card: Pick<RateCardEntity, 'id' | 'code' | 'version'>,
    metadata: Record<string, unknown>,
  ) {
    await this.systemLog.write({
      level: 'info',
      category: RATE_CARD_AUDIT_CATEGORY,
      action,
      message: `${action} ${card.code} v${card.version} (${card.id})`,
      requestId: actor.requestId ?? null,
      userId: actor.userId,
      metadata: { rateCardId: card.id, code: card.code, version: card.version, ...metadata },
    });
  }
}

function normalizeItem(item: {
  categoryId: string;
  level: RateCardItemData['level'];
  pricingType: RateCardItemData['pricingType'];
  tier?: number | null;
  sourceMin?: number | null;
  sourceMax?: number | null;
  sceneMin?: number | null;
  price: number;
  minSourceSeconds?: number | null;
}): RateCardItemData {
  return {
    categoryId: item.categoryId,
    level: item.level,
    pricingType: item.pricingType,
    tier: item.tier ?? null,
    sourceMin: item.sourceMin ?? null,
    sourceMax: item.sourceMax ?? null,
    sceneMin: item.sceneMin ?? null,
    price: item.price,
    minSourceSeconds: item.minSourceSeconds ?? null,
  };
}

/** Content (duration rule, items with ids, level rules) of one version. */
export async function loadContent(
  manager: EntityManager,
  rateCardId: string,
  durationRule: StoredDurationRule | null,
): Promise<RateCardContent> {
  const items = await manager.find(RateCardItemEntity, { where: { rateCardId } });
  const rules = await manager.find(RateCardLevelRuleEntity, { where: { rateCardId } });
  return {
    durationRule: toDurationRule(durationRule),
    items: items.map((item) => ({ ...item })),
    levelRules: rules.map(({ level, extraScenePrice, extraSceneMinSources }) => ({
      level,
      extraScenePrice,
      extraSceneMinSources,
    })),
  };
}

/**
 * The published version of `code` in force on `date` (Q-R1: the last day of the acceptance period),
 * with its content; null when none.
 */
export async function findRateCardInForce(
  manager: EntityManager,
  code: string,
  date: string,
): Promise<RateCardInForce | null> {
  const [card] = (await manager.query(
    `SELECT id, code, version, effective_from::text AS "effectiveFrom",
            effective_to::text AS "effectiveTo", duration_rule AS "durationRule"
     FROM rate_cards
     WHERE code = $1 AND status = 'published' AND effective_from <= $2
       AND (effective_to IS NULL OR effective_to >= $2)
     ORDER BY version DESC
     LIMIT 1`,
    [code, date],
  )) as Array<{
    id: string;
    code: string;
    version: number;
    effectiveFrom: string;
    effectiveTo: string | null;
    durationRule: StoredDurationRule;
  }>;
  if (!card) {
    return null;
  }
  return {
    id: card.id,
    code: card.code,
    version: card.version,
    effectiveFrom: card.effectiveFrom,
    effectiveTo: card.effectiveTo,
    content: await loadContent(manager, card.id, card.durationRule),
  };
}
