import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { DataSource, IsNull, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import type { PricingModel } from '../../database/entities/contract.entity';
import {
  DocumentTemplateEntity,
  type DocumentTemplateKind,
  type DocumentTemplateSource,
} from '../../database/entities/document-template.entity';
import { STORAGE_ADAPTER, type StorageAdapter } from '../assets/storage/storage-adapter';
import { SystemLogService } from '../logs/system-log.service';
import type { PartnerActor } from '../partners/partner-actor';
import { DEFAULT_TEMPLATES } from './default-templates';
import { checkTemplateTags, placeholderCatalog, type TemplateCheck } from './document-placeholders';
import { DOCX_CONTENT_TYPE, parseTemplate, type TemplateError } from './docx-renderer';
import type { ListTemplatesQueryDto, UploadTemplateDto } from './dto/document.dto';
import { readObjectBuffer } from './storage-buffer';

export const DOCUMENT_AUDIT_CATEGORY = 'contract_document';

/** Largest template accepted (Word files with logos stay well below). */
export const MAX_TEMPLATE_BYTES = 10 * 1024 * 1024;

export const TEMPLATE_ERROR_CODES = {
  NOT_FOUND: 'DOCUMENT_TEMPLATE_NOT_FOUND',
  FILE_REQUIRED: 'DOCUMENT_TEMPLATE_FILE_REQUIRED',
  INVALID: 'DOCUMENT_TEMPLATE_INVALID',
  MODEL_REQUIRED: 'DOCUMENT_TEMPLATE_MODEL_REQUIRED',
} as const;

export type TemplateUploadFile = {
  originalname: string;
  mimetype?: string;
  size: number;
  buffer: Buffer;
};

export type TemplateValidation = TemplateCheck & {
  valid: boolean;
  errors: TemplateError[];
};

/**
 * Versioned DOCX templates (spec 7.9, FR-D-01): upload to R2 under `contract-templates/`, placeholder
 * check with docxtemplater (unknown tags refused, recommended tags missing reported), one active
 * version per kind and pricing model, and the interim templates bundled with AG Go (Q-R9).
 */
@Injectable()
export class DocumentTemplatesService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(DocumentTemplateEntity)
    private readonly templates: Repository<DocumentTemplateEntity>,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
    private readonly systemLog: SystemLogService,
  ) {}

  list(query: ListTemplatesQueryDto) {
    const builder = this.templates
      .createQueryBuilder('template')
      .orderBy('template.kind', 'ASC')
      .addOrderBy('template.pricing_model', 'ASC', 'NULLS FIRST')
      .addOrderBy('template.version', 'DESC');
    if (query.kind) {
      builder.andWhere('template.kind = :kind', { kind: query.kind });
    }
    if (query.pricingModel) {
      builder.andWhere('template.pricing_model = :pricingModel', {
        pricingModel: query.pricingModel,
      });
    }
    return builder.getMany();
  }

  placeholders(kind: DocumentTemplateKind) {
    return placeholderCatalog(kind);
  }

  async get(id: string): Promise<DocumentTemplateEntity> {
    const template = await this.templates.findOne({ where: { id } });
    if (!template) {
      throw new NotFoundException({
        code: TEMPLATE_ERROR_CODES.NOT_FOUND,
        message: 'Template not found',
      });
    }
    return template;
  }

  /** Checks a DOCX without saving it (template screen, before upload). */
  validate(kind: DocumentTemplateKind, file: TemplateUploadFile | undefined): TemplateValidation {
    const buffer = this.fileBuffer(file);
    const parsed = parseTemplate(buffer);
    if (!parsed.ok) {
      return { valid: false, errors: parsed.errors, unknown: [], missingRecommended: [], used: [] };
    }
    const check = checkTemplateTags(kind, parsed.tags);
    return {
      valid: check.unknown.length === 0,
      errors: check.unknown.map((tag) => ({ tag, message: `Placeholder lạ: {${tag}}` })),
      ...check,
    };
  }

  /**
   * New version of a template: 422 DOCUMENT_TEMPLATE_INVALID (details: errors, unknown) when the
   * file does not parse or uses placeholders AG Go never fills. Active by default.
   */
  async upload(dto: UploadTemplateDto, file: TemplateUploadFile | undefined, actor: PartnerActor) {
    const model = this.modelFor(dto.kind, dto.pricingModel);
    const validation = this.validate(dto.kind, file);
    if (!validation.valid) {
      throw new UnprocessableEntityException({
        code: TEMPLATE_ERROR_CODES.INVALID,
        message: 'The template has errors or unknown placeholders',
        details: { errors: validation.errors, unknown: validation.unknown },
      });
    }
    const template = await this.create({
      kind: dto.kind,
      pricingModel: model,
      name: dto.name?.trim() || file!.originalname,
      fileName: file!.originalname,
      buffer: file!.buffer,
      validation,
      source: 'upload',
      note: dto.note?.trim() || null,
      activate: dto.activate ?? true,
      actor,
    });
    return { ...template, warnings: validation.missingRecommended };
  }

  /** Makes this version the one issue uses for its kind and pricing model. */
  async activate(id: string, actor: PartnerActor) {
    const template = await this.get(id);
    await this.dataSource.transaction(async (manager) => {
      await manager.update(
        DocumentTemplateEntity,
        { kind: template.kind, pricingModel: template.pricingModel ?? IsNull(), isActive: true },
        { isActive: false },
      );
      await manager.update(DocumentTemplateEntity, template.id, {
        isActive: true,
        activatedAt: new Date(),
        activatedBy: actor.userId,
      });
    });
    await this.audit(actor, 'DOCUMENT_TEMPLATE_ACTIVATED', template);
    return this.get(id);
  }

  async content(id: string): Promise<{ template: DocumentTemplateEntity; buffer: Buffer }> {
    const template = await this.get(id);
    return { template, buffer: await this.buffer(template) };
  }

  buffer(template: Pick<DocumentTemplateEntity, 'storageKey'>): Promise<Buffer> {
    return readObjectBuffer(this.storage, template.storageKey);
  }

  /**
   * Installs the interim templates (Q-R9) for every kind / model that has no template yet; they
   * become active. Returns the versions made.
   */
  async installDefaults(actor: PartnerActor) {
    const made: DocumentTemplateEntity[] = [];
    for (const item of DEFAULT_TEMPLATES) {
      const existing = await this.templates.count({
        where: { kind: item.kind, pricingModel: item.pricingModel ?? IsNull() },
      });
      if (existing > 0) {
        continue;
      }
      const buffer = item.build();
      made.push(
        await this.create({
          kind: item.kind,
          pricingModel: item.pricingModel,
          name: item.name,
          fileName: item.fileName,
          buffer,
          validation: this.validate(item.kind, {
            originalname: item.fileName,
            size: buffer.length,
            buffer,
          }),
          source: 'default',
          note: 'Mẫu tạm của hệ thống, chờ nghiệp vụ chuẩn hoá (Q-R9)',
          activate: true,
          actor,
        }),
      );
    }
    return made;
  }

  /**
   * Template issue uses: the active one of the pricing model, else (amendment / acceptance) the
   * active one for every model.
   */
  async active(
    kind: DocumentTemplateKind,
    model: PricingModel,
  ): Promise<DocumentTemplateEntity | null> {
    const exact = await this.templates.findOne({
      where: { kind, pricingModel: model, isActive: true },
    });
    if (exact || kind === 'contract') {
      return exact;
    }
    return this.templates.findOne({ where: { kind, pricingModel: IsNull(), isActive: true } });
  }

  private async create(input: {
    kind: DocumentTemplateKind;
    pricingModel: PricingModel | null;
    name: string;
    fileName: string;
    buffer: Buffer;
    validation: TemplateValidation;
    source: DocumentTemplateSource;
    note: string | null;
    activate: boolean;
    actor: PartnerActor;
  }): Promise<DocumentTemplateEntity> {
    const id = uuidv7();
    const checksum = createHash('sha256').update(input.buffer).digest('hex');
    const template = await this.dataSource.transaction(async (manager) => {
      // One version number at a time per kind / model.
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `document_templates:${input.kind}:${input.pricingModel ?? ''}`,
      ]);
      const [{ last }] = (await manager.query(
        `SELECT COALESCE(MAX(version), 0)::int AS last FROM document_templates
         WHERE kind = $1 AND COALESCE(pricing_model, '') = $2`,
        [input.kind, input.pricingModel ?? ''],
      )) as Array<{ last: number }>;
      const version = Number(last) + 1;
      const storageKey = `contract-templates/${input.kind}/${input.pricingModel ?? 'all'}/v${version}-${id}.docx`;
      await this.storage.putObject(
        storageKey,
        input.buffer,
        DOCX_CONTENT_TYPE,
        input.buffer.length,
      );
      if (input.activate) {
        await manager.update(
          DocumentTemplateEntity,
          { kind: input.kind, pricingModel: input.pricingModel ?? IsNull(), isActive: true },
          { isActive: false },
        );
      }
      const row = manager.create(DocumentTemplateEntity, {
        id,
        kind: input.kind,
        pricingModel: input.pricingModel,
        version,
        name: input.name.slice(0, 200),
        fileName: input.fileName.slice(0, 255),
        storageKey,
        sizeBytes: input.buffer.length,
        checksumSha256: checksum,
        placeholders: input.validation.used,
        missingRecommended: input.validation.missingRecommended,
        isActive: input.activate,
        source: input.source,
        note: input.note,
        activatedAt: input.activate ? new Date() : null,
        activatedBy: input.activate ? input.actor.userId : null,
        createdBy: input.actor.userId,
      });
      await manager.save(row);
      return row;
    });
    await this.audit(input.actor, 'DOCUMENT_TEMPLATE_CREATED', template);
    return this.get(template.id);
  }

  private modelFor(kind: DocumentTemplateKind, model: PricingModel | undefined) {
    if (kind === 'contract' && !model) {
      throw new BadRequestException({
        code: TEMPLATE_ERROR_CODES.MODEL_REQUIRED,
        message: 'A contract template needs its pricing model',
      });
    }
    return model ?? null;
  }

  private fileBuffer(file: TemplateUploadFile | undefined): Buffer {
    if (!file?.buffer || file.size === 0) {
      throw new BadRequestException({
        code: TEMPLATE_ERROR_CODES.FILE_REQUIRED,
        message: 'Upload a .docx file as `file`',
      });
    }
    if (!/\.docx$/i.test(file.originalname) || file.size > MAX_TEMPLATE_BYTES) {
      throw new BadRequestException({
        code: TEMPLATE_ERROR_CODES.INVALID,
        message: `The template must be a .docx file of at most ${MAX_TEMPLATE_BYTES / 1024 / 1024} MB`,
      });
    }
    return file.buffer;
  }

  private async audit(actor: PartnerActor, action: string, template: DocumentTemplateEntity) {
    await this.systemLog.write({
      level: 'info',
      category: DOCUMENT_AUDIT_CATEGORY,
      action,
      message: `${action} ${template.kind}/${template.pricingModel ?? 'all'} v${template.version}`,
      requestId: actor.requestId ?? null,
      userId: actor.userId,
      metadata: {
        templateId: template.id,
        kind: template.kind,
        pricingModel: template.pricingModel,
        version: template.version,
      },
    });
  }
}
