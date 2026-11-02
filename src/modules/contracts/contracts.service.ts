import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, QueryFailedError, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { isAdminUserType } from '../../common/auth/user-type';
import { PiiCipherService } from '../../common/crypto/pii-cipher.service';
import {
  failedImportResult,
  parseCsvUpload,
  successfulImportResult,
  type CsvImportError,
  type CsvImportResult,
  type CsvUploadFile,
} from '../../common/csv/csv-import';
import { ListResponseDto } from '../../common/dto/list-response.dto';
import { ContractAmendmentEntity } from '../../database/entities/contract-amendment.entity';
import { ContractEntity, type PricingModel } from '../../database/entities/contract.entity';
import { PartnerEntity } from '../../database/entities/partner.entity';
import type { AccountContractProfile } from '../account/account.types';
import { SystemLogService } from '../logs/system-log.service';
import { hasPermission, type PartnerActor } from '../partners/partner-actor';
import { PROFILE_FIELD_MAP } from '../partners/partner-profile';
import { PartnersService } from '../partners/partners.service';
import {
  LEGACY_CONTRACT_HEADERS,
  parseLegacyContractRow,
  type LegacyContractRow,
} from './contract-import';
import { contractNumberBase, nextAppendixNumber, nextContractNumber } from './contract-number';
import {
  allowedContractActions,
  amendable,
  ContractTransitionError,
  nextContractStatus,
  termsEditable,
  type ContractAction,
} from './contract-state';
import {
  AMENDABLE_TERMS,
  DEFAULT_TECH_SPEC_PRESET,
  effectiveTerms,
  PRICING_CONFIG_SCHEMAS,
  TECH_SPEC_PRESETS,
  TechSpecSchema,
  validateContractTerms,
  type TermsErrors,
} from './contract-terms';
import type {
  ActivateContractDto,
  AmendmentChangesDto,
  CreateAmendmentDto,
  CreateContractDto,
  ListContractsQueryDto,
  UpdateAmendmentDto,
  UpdateContractDto,
} from './dto/contract.dto';

export const CONTRACT_AUDIT_CATEGORY = 'contract';

export const CONTRACT_ERROR_CODES = {
  NOT_FOUND: 'CONTRACT_NOT_FOUND',
  TERMS_INVALID: 'CONTRACT_TERMS_INVALID',
  TERMS_LOCKED: 'CONTRACT_TERMS_LOCKED',
  NUMBER_TAKEN: 'CONTRACT_NUMBER_TAKEN',
  INVALID_TRANSITION: 'CONTRACT_INVALID_TRANSITION',
  PARTNER_INACTIVE: 'PARTNER_INACTIVE',
  PROFILE_INCOMPLETE: 'PARTNER_PROFILE_INCOMPLETE',
  SIGNED_DATE_REQUIRED: 'CONTRACT_SIGNED_DATE_REQUIRED',
  SIGNED_FILE_REQUIRED: 'CONTRACT_SIGNED_FILE_REQUIRED',
  NOT_DELETABLE: 'CONTRACT_NOT_DELETABLE',
  NOT_AMENDABLE: 'CONTRACT_NOT_AMENDABLE',
  AMENDMENT_NOT_FOUND: 'CONTRACT_AMENDMENT_NOT_FOUND',
  AMENDMENT_LOCKED: 'CONTRACT_AMENDMENT_LOCKED',
  AMENDMENT_EMPTY: 'CONTRACT_AMENDMENT_EMPTY',
} as const;

/** Term fields of UpdateContractDto: changing one needs a draft contract. */
const TERM_FIELDS = [
  'contractType',
  'contractNumber',
  'signedDate',
  'startDate',
  'endDate',
  'pricingModel',
  'pricingConfig',
  'capAmount',
  'advanceAmount',
  'advanceDueBusinessDays',
  'advanceOffsetRule',
  'acceptanceCycle',
  'deliveryRule',
  'paymentTermBusinessDays',
  'techSpec',
  'techSpecPreset',
  'penaltyPercent',
  'originalityMinPercent',
  'similarityMaxPercent',
  'nonCompeteMonths',
  'templateVersionId',
  'regenerateNumber',
] as const satisfies ReadonlyArray<keyof UpdateContractDto>;

/** Columns copied from the DTO as they are (after validation). */
const PLAIN_TERM_FIELDS = [
  'contractType',
  'signedDate',
  'startDate',
  'endDate',
  'pricingModel',
  'capAmount',
  'advanceAmount',
  'advanceDueBusinessDays',
  'advanceOffsetRule',
  'acceptanceCycle',
  'paymentTermBusinessDays',
  'penaltyPercent',
  'originalityMinPercent',
  'similarityMaxPercent',
  'nonCompeteMonths',
  'templateVersionId',
] as const satisfies ReadonlyArray<keyof UpdateContractDto & keyof ContractEntity>;

const AMENDMENT_CHANGE_COLUMNS: Record<
  keyof AmendmentChangesDto,
  (typeof AMENDABLE_TERMS)[number]
> = {
  pricingConfig: 'pricing_config',
  capAmount: 'cap_amount',
  techSpec: 'tech_spec',
  endDate: 'end_date',
  paymentTermBusinessDays: 'payment_term_business_days',
  penaltyPercent: 'penalty_percent',
};

type PartnerSummary = Pick<PartnerEntity, 'id' | 'code' | 'displayName' | 'status'>;

export type ContractResponse = Omit<ContractEntity, 'partnerSnapshotEnc'> & {
  partner: PartnerSummary | null;
  /** True once a partner snapshot was taken (issue); its content is never returned. */
  hasPartnerSnapshot: boolean;
  allowedActions: ContractAction[];
  nextAppendixNumber: number;
};

/** What is captured, encrypted, when a contract is issued (BR-02). */
export type PartnerSnapshot = {
  capturedAt: string;
  accountUserId: string;
  profileVersion: string;
  partnerCode: string;
  name: string;
  fields: Record<string, string | null>;
  passportUnreadable: boolean;
};

export function buildPartnerSnapshot(
  partner: Pick<PartnerEntity, 'accountUserId' | 'code'>,
  profile: AccountContractProfile,
  now: Date,
): PartnerSnapshot {
  return {
    capturedAt: now.toISOString(),
    accountUserId: partner.accountUserId,
    profileVersion: profile.version,
    partnerCode: partner.code,
    name: profile.name,
    fields: Object.fromEntries(
      Object.entries(PROFILE_FIELD_MAP).map(([camel, snake]) => [camel, profile[snake] ?? null]),
    ),
    passportUnreadable: profile.passport_unreadable === true,
  };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

@Injectable()
export class ContractsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(ContractEntity)
    private readonly contracts: Repository<ContractEntity>,
    @InjectRepository(ContractAmendmentEntity)
    private readonly amendments: Repository<ContractAmendmentEntity>,
    @InjectRepository(PartnerEntity)
    private readonly partnerRepository: Repository<PartnerEntity>,
    private readonly partners: PartnersService,
    private readonly cipher: PiiCipherService,
    private readonly systemLog: SystemLogService,
  ) {}

  techSpecPresets() {
    return Object.entries(TECH_SPEC_PRESETS).map(([id, preset]) => ({ id, ...preset }));
  }

  async list(
    query: ListContractsQueryDto,
    actor: PartnerActor,
  ): Promise<ListResponseDto<ContractResponse>> {
    const builder = this.contracts
      .createQueryBuilder('contract')
      .innerJoin(PartnerEntity, 'partner', 'partner.id = contract.partner_id');
    if (!this.canSeeAll(actor)) {
      builder.andWhere('contract.manager_user_id = :me', { me: actor.userId });
    }
    if (query.partnerId) {
      builder.andWhere('contract.partner_id = :partnerId', { partnerId: query.partnerId });
    }
    if (query.status) {
      builder.andWhere('contract.status = :status', { status: query.status });
    }
    if (query.pricingModel) {
      builder.andWhere('contract.pricing_model = :pricingModel', {
        pricingModel: query.pricingModel,
      });
    }
    if (query.managerUserId) {
      builder.andWhere('contract.manager_user_id = :managerUserId', {
        managerUserId: query.managerUserId,
      });
    }
    const keyword = query.normalizedKeyword;
    if (keyword) {
      builder.andWhere(
        '(contract.contract_number ILIKE :keyword OR partner.display_name ILIKE :keyword OR partner.code ILIKE :keyword)',
        { keyword: `%${keyword.replace(/[\\%_]/g, (match) => `\\${match}`)}%` },
      );
    }
    const [rows, total] = await builder
      .orderBy('contract.created_at', 'DESC')
      .addOrderBy('contract.id', 'DESC')
      .skip(query.skip)
      .take(query.pageSize)
      .getManyAndCount();
    const partners = await this.partnerSummaries(rows.map((row) => row.partnerId));
    return new ListResponseDto(
      rows.map((row) => this.toResponse(row, partners.get(row.partnerId) ?? null)),
      query.page,
      query.pageSize,
      total,
    );
  }

  async get(id: string, actor: PartnerActor) {
    const contract = await this.findVisible(id, actor);
    const [partners, amendments] = await Promise.all([
      this.partnerSummaries([contract.partnerId]),
      this.amendments.find({ where: { contractId: id }, order: { amendmentNumber: 'ASC' } }),
    ]);
    return {
      ...this.toResponse(contract, partners.get(contract.partnerId) ?? null),
      amendments,
    };
  }

  /** Number the contract would get (BR-05), for the form to show before saving. */
  async nextNumber(partnerId: string, date: string, actor: PartnerActor) {
    const partner = await this.partners.findVisible(partnerId, actor);
    return { contractNumber: await this.generateNumber(partner.code, date) };
  }

  async create(dto: CreateContractDto, actor: PartnerActor): Promise<ContractResponse> {
    const partner = await this.partners.findVisible(dto.partnerId, actor);
    if (partner.status !== 'active') {
      throw new ConflictException({
        code: CONTRACT_ERROR_CODES.PARTNER_INACTIVE,
        message: 'An inactive partner cannot get a new contract',
      });
    }
    const techSpec =
      dto.techSpec ?? TECH_SPEC_PRESETS[dto.techSpecPreset ?? DEFAULT_TECH_SPEC_PRESET].techSpec;
    const terms = await this.checkTerms({
      pricingModel: dto.pricingModel,
      pricingConfig: dto.pricingConfig,
      techSpec,
      deliveryRule: dto.deliveryRule,
      capAmount: dto.capAmount,
      advanceAmount: dto.advanceAmount,
      advanceDueBusinessDays: dto.advanceDueBusinessDays,
      startDate: dto.startDate,
      endDate: dto.endDate,
    });
    const contractNumber =
      dto.contractNumber?.trim() ||
      (await this.generateNumber(partner.code, dto.signedDate ?? dto.startDate));

    const contract = this.contracts.create({
      id: uuidv7(),
      partnerId: partner.id,
      contractNumber,
      contractType: dto.contractType ?? 'content_production',
      signedDate: dto.signedDate ?? null,
      startDate: dto.startDate,
      endDate: dto.endDate ?? null,
      status: 'draft',
      pricingModel: dto.pricingModel,
      pricingConfig: terms.pricingConfig,
      capAmount: dto.capAmount ?? null,
      advanceAmount: dto.advanceAmount ?? 0,
      advanceDueBusinessDays: dto.advanceDueBusinessDays ?? null,
      advanceOffsetRule: dto.advanceOffsetRule ?? 'full_first',
      acceptanceCycle: dto.acceptanceCycle,
      deliveryRule: terms.deliveryRule,
      paymentTermBusinessDays: dto.paymentTermBusinessDays,
      techSpec: terms.techSpec,
      penaltyPercent: dto.penaltyPercent ?? 8,
      originalityMinPercent: dto.originalityMinPercent ?? null,
      similarityMaxPercent: dto.similarityMaxPercent === undefined ? 30 : dto.similarityMaxPercent,
      nonCompeteMonths: dto.nonCompeteMonths === undefined ? 24 : dto.nonCompeteMonths,
      templateVersionId: dto.templateVersionId ?? null,
      managerUserId: dto.managerUserId?.trim() || partner.managerUserId,
      lastAppendixNumber: 0,
      source: 'system',
      note: dto.note?.trim() || null,
      createdBy: actor.userId,
    });
    await this.insertContract(contract);
    await this.audit(actor, 'CONTRACT_CREATED', contract, { pricingModel: contract.pricingModel });
    return this.get(contract.id, actor);
  }

  /** Terms only while draft (5.2: later changes go through amendments); manager and note always. */
  async update(id: string, dto: UpdateContractDto, actor: PartnerActor) {
    const contract = await this.findVisible(id, actor);
    const touchesTerms = TERM_FIELDS.some((field) => dto[field] !== undefined);
    if (touchesTerms && !termsEditable(contract.status)) {
      throw new ConflictException({
        code: CONTRACT_ERROR_CODES.TERMS_LOCKED,
        message: 'Terms of an issued or running contract change only through an amendment',
      });
    }
    const changed: string[] = [];
    if (touchesTerms) {
      const next = { ...contract };
      for (const field of PLAIN_TERM_FIELDS) {
        if (dto[field] !== undefined) {
          (next as Record<string, unknown>)[field] = dto[field];
        }
      }
      const techSpec =
        dto.techSpec ??
        (dto.techSpecPreset ? TECH_SPEC_PRESETS[dto.techSpecPreset].techSpec : next.techSpec);
      const terms = await this.checkTerms({
        pricingModel: next.pricingModel,
        pricingConfig: dto.pricingConfig ?? next.pricingConfig,
        techSpec,
        deliveryRule: dto.deliveryRule === undefined ? next.deliveryRule : dto.deliveryRule,
        capAmount: next.capAmount,
        advanceAmount: next.advanceAmount,
        advanceDueBusinessDays: next.advanceDueBusinessDays,
        startDate: next.startDate,
        endDate: next.endDate,
      });
      next.pricingConfig = terms.pricingConfig;
      next.techSpec = terms.techSpec;
      next.deliveryRule = terms.deliveryRule;
      if (dto.contractNumber?.trim()) {
        next.contractNumber = dto.contractNumber.trim();
      } else if (dto.regenerateNumber) {
        const partner = await this.partnerRepository.findOneByOrFail({ id: contract.partnerId });
        next.contractNumber = await this.generateNumber(
          partner.code,
          next.signedDate ?? next.startDate,
          contract.id,
        );
      }
      for (const key of Object.keys(next) as Array<keyof ContractEntity>) {
        if (JSON.stringify(next[key]) !== JSON.stringify(contract[key])) {
          changed.push(key);
        }
      }
      Object.assign(contract, next);
    }
    if (dto.managerUserId !== undefined && dto.managerUserId.trim() !== contract.managerUserId) {
      contract.managerUserId = dto.managerUserId.trim();
      changed.push('managerUserId');
    }
    if (dto.note !== undefined && (dto.note?.trim() || null) !== contract.note) {
      contract.note = dto.note?.trim() || null;
      changed.push('note');
    }
    if (changed.length > 0) {
      try {
        await this.contracts.save(contract);
      } catch (error) {
        throw this.numberTaken(error) ?? error;
      }
      await this.audit(actor, 'CONTRACT_UPDATED', contract, { fields: changed });
    }
    return this.get(contract.id, actor);
  }

  /** Only drafts can be deleted. */
  async remove(id: string, actor: PartnerActor): Promise<void> {
    const contract = await this.findVisible(id, actor);
    if (contract.status !== 'draft') {
      throw new ConflictException({
        code: CONTRACT_ERROR_CODES.NOT_DELETABLE,
        message: 'Only a draft contract can be deleted',
      });
    }
    await this.contracts.delete(contract.id);
    await this.audit(actor, 'CONTRACT_DELETED', contract, {});
  }

  /**
   * draft → issued. Reads the partner's AG Account profile, refuses when a field required to sign
   * is missing (422 PARTNER_PROFILE_INCOMPLETE with `details.missing`) or AG Account cannot be read
   * (503), and stores it encrypted as the contract's partner snapshot (BR-02).
   */
  async issue(id: string, actor: PartnerActor) {
    const contract = await this.findVisible(id, actor);
    this.assertTransition(contract, 'issue');
    const partner = await this.partnerRepository.findOneByOrFail({ id: contract.partnerId });
    if (partner.status !== 'active') {
      throw new ConflictException({
        code: CONTRACT_ERROR_CODES.PARTNER_INACTIVE,
        message: 'The partner is inactive',
      });
    }
    const { profile, completeness } = await this.partners.readProfileForDocument(partner, actor);
    if (!completeness.complete) {
      throw new UnprocessableEntityException({
        code: CONTRACT_ERROR_CODES.PROFILE_INCOMPLETE,
        message: 'The partner profile misses fields required to sign a contract',
        details: { missing: completeness.missing },
      });
    }
    const now = new Date();
    const snapshot = this.cipher.encryptJson(buildPartnerSnapshot(partner, profile, now));
    return this.transition(id, 'issue', actor, (locked) => {
      locked.partnerSnapshotEnc = snapshot;
      locked.partnerSnapshotAt = now;
      locked.issuedAt = now;
      locked.issuedBy = actor.userId;
    });
  }

  /** issued → draft, to edit again; the snapshot is taken again at the next issue. */
  unissue(id: string, actor: PartnerActor) {
    return this.transition(id, 'unissue', actor, (locked) => {
      locked.partnerSnapshotEnc = null;
      locked.partnerSnapshotAt = null;
      locked.issuedAt = null;
      locked.issuedBy = null;
    });
  }

  /**
   * issued → active. Needs the signing date and the signed copy; an administrator may activate
   * without the copy by giving a reason (FR-C-06).
   */
  activate(id: string, dto: ActivateContractDto, actor: PartnerActor) {
    return this.transition(id, 'activate', actor, (locked) => {
      const signedDate = dto.signedDate ?? locked.signedDate;
      if (!signedDate) {
        throw new BadRequestException({
          code: CONTRACT_ERROR_CODES.SIGNED_DATE_REQUIRED,
          message: 'The signing date is required to activate',
        });
      }
      const signedFileId = dto.signedFileId ?? locked.signedFileId;
      if (!signedFileId) {
        if (!isAdminUserType(actor.userType) || !dto.skipSignedFileReason?.trim()) {
          throw new BadRequestException({
            code: CONTRACT_ERROR_CODES.SIGNED_FILE_REQUIRED,
            message:
              'Upload the signed contract first (an administrator may skip it with a reason)',
          });
        }
        locked.activationNote = dto.skipSignedFileReason.trim();
      }
      locked.signedDate = signedDate;
      locked.signedFileId = signedFileId ?? null;
      locked.activatedAt = new Date();
      locked.activatedBy = actor.userId;
    });
  }

  suspend(id: string, reason: string | undefined, actor: PartnerActor) {
    return this.transition(id, 'suspend', actor, (locked) => {
      locked.suspendedReason = reason?.trim() || null;
    });
  }

  resume(id: string, actor: PartnerActor) {
    return this.transition(id, 'resume', actor);
  }

  complete(id: string, actor: PartnerActor) {
    return this.transition(id, 'complete', actor, (locked) => {
      locked.closedAt = new Date();
    });
  }

  terminate(id: string, reason: string, actor: PartnerActor) {
    return this.transition(id, 'terminate', actor, (locked) => {
      locked.terminatedReason = reason.trim();
      locked.closedAt = new Date();
    });
  }

  /** Terms in force on `date` (signed amendments applied), for acceptance records later on. */
  async terms(id: string, date: string | undefined, actor: PartnerActor) {
    const contract = await this.findVisible(id, actor);
    const amendments = await this.amendments.find({ where: { contractId: id, status: 'signed' } });
    const day = date ?? today();
    return {
      date: day,
      ...effectiveTerms(
        {
          pricing_model: contract.pricingModel,
          pricing_config: contract.pricingConfig,
          cap_amount: contract.capAmount,
          tech_spec: contract.techSpec,
          end_date: contract.endDate,
          payment_term_business_days: contract.paymentTermBusinessDays,
          penalty_percent: contract.penaltyPercent,
        },
        amendments,
        day,
      ),
    };
  }

  async listAmendments(contractId: string, actor: PartnerActor) {
    await this.findVisible(contractId, actor);
    return this.amendments.find({ where: { contractId }, order: { amendmentNumber: 'ASC' } });
  }

  /** A draft amendment of an active or suspended contract, numbered next in the contract. */
  async createAmendment(contractId: string, dto: CreateAmendmentDto, actor: PartnerActor) {
    const contract = await this.findVisible(contractId, actor);
    if (!amendable(contract.status)) {
      throw new ConflictException({
        code: CONTRACT_ERROR_CODES.NOT_AMENDABLE,
        message: 'Only an active or suspended contract can be amended',
      });
    }
    const changes = this.checkAmendment(contract, dto.changes, dto.effectiveDate);
    const amendment = await this.dataSource.transaction(async (manager) => {
      await manager
        .getRepository(ContractEntity)
        .findOne({ where: { id: contractId }, lock: { mode: 'pessimistic_write' } });
      const last = await manager
        .getRepository(ContractAmendmentEntity)
        .createQueryBuilder('amendment')
        .select('COALESCE(MAX(amendment.amendment_number), 0)', 'last')
        .where('amendment.contract_id = :contractId', { contractId })
        .getRawOne<{ last: number | string }>();
      const row = manager.getRepository(ContractAmendmentEntity).create({
        id: uuidv7(),
        contractId,
        amendmentNumber: Number(last?.last ?? 0) + 1,
        effectiveDate: dto.effectiveDate,
        changes,
        reason: dto.reason?.trim() || null,
        status: 'draft',
        signedFileId: null,
        createdBy: actor.userId,
      });
      await manager.getRepository(ContractAmendmentEntity).save(row);
      return row;
    });
    await this.audit(actor, 'CONTRACT_AMENDMENT_CREATED', contract, {
      amendmentId: amendment.id,
      amendmentNumber: amendment.amendmentNumber,
      fields: Object.keys(changes),
    });
    return this.amendments.findOneByOrFail({ id: amendment.id });
  }

  async updateAmendment(
    contractId: string,
    amendmentId: string,
    dto: UpdateAmendmentDto,
    actor: PartnerActor,
  ) {
    const { contract, amendment } = await this.findAmendment(contractId, amendmentId, actor);
    this.assertDraftAmendment(amendment);
    const effectiveDate = dto.effectiveDate ?? amendment.effectiveDate;
    if (dto.changes !== undefined || dto.effectiveDate !== undefined) {
      amendment.changes =
        dto.changes !== undefined
          ? this.checkAmendment(contract, dto.changes, effectiveDate)
          : amendment.changes;
      amendment.effectiveDate = effectiveDate;
    }
    if (dto.reason !== undefined) {
      amendment.reason = dto.reason?.trim() || null;
    }
    await this.amendments.save(amendment);
    await this.audit(actor, 'CONTRACT_AMENDMENT_UPDATED', contract, { amendmentId });
    return amendment;
  }

  async issueAmendment(contractId: string, amendmentId: string, actor: PartnerActor) {
    const { contract, amendment } = await this.findAmendment(contractId, amendmentId, actor);
    this.assertDraftAmendment(amendment);
    amendment.status = 'issued';
    await this.amendments.save(amendment);
    await this.audit(actor, 'CONTRACT_AMENDMENT_ISSUED', contract, { amendmentId });
    return amendment;
  }

  /** issued → signed: from its effective date the amendment is part of the terms in force. */
  async signAmendment(
    contractId: string,
    amendmentId: string,
    signedFileId: string | undefined,
    actor: PartnerActor,
  ) {
    const { contract, amendment } = await this.findAmendment(contractId, amendmentId, actor);
    if (amendment.status !== 'issued') {
      throw new ConflictException({
        code: CONTRACT_ERROR_CODES.AMENDMENT_LOCKED,
        message: 'Only an issued amendment can be signed',
      });
    }
    amendment.status = 'signed';
    amendment.signedFileId = signedFileId ?? amendment.signedFileId;
    await this.amendments.save(amendment);
    await this.audit(actor, 'CONTRACT_AMENDMENT_SIGNED', contract, { amendmentId });
    return amendment;
  }

  async removeAmendment(contractId: string, amendmentId: string, actor: PartnerActor) {
    const { contract, amendment } = await this.findAmendment(contractId, amendmentId, actor);
    this.assertDraftAmendment(amendment);
    await this.amendments.delete(amendment.id);
    await this.audit(actor, 'CONTRACT_AMENDMENT_DELETED', contract, { amendmentId });
  }

  /**
   * Imports contracts signed outside AG Go (FR-C-11): all rows or none. Each keeps its number and
   * the last appendix number used, so the next acceptance appendix continues from it.
   */
  async importCsv(file: CsvUploadFile | undefined, actor: PartnerActor): Promise<CsvImportResult> {
    const parsed = parseCsvUpload(file, LEGACY_CONTRACT_HEADERS);
    if (parsed.errors.length > 0) {
      return failedImportResult(parsed.rows.length, parsed.errors);
    }
    const errors: CsvImportError[] = [];
    const rows: LegacyContractRow[] = [];
    for (const { row, values } of parsed.rows) {
      const result = parseLegacyContractRow(row, values);
      if (result.value) {
        rows.push(result.value);
      } else {
        errors.push(...result.errors);
      }
    }

    const numbersInFile = new Map<string, number>();
    for (const row of rows) {
      const first = numbersInFile.get(row.contractNumber);
      if (first !== undefined) {
        errors.push({
          row: row.row,
          field: 'contract_number',
          value: row.contractNumber,
          reason: `Trùng số HĐ với dòng ${first}.`,
        });
      } else {
        numbersInFile.set(row.contractNumber, row.row);
      }
    }

    const codes = [...new Set(rows.map((row) => row.partnerCode))];
    const partners = codes.length
      ? await this.partnerRepository.find({ where: { code: In(codes) } })
      : [];
    const partnerByCode = new Map(
      partners.filter((partner) => this.partners.canSee(partner, actor)).map((p) => [p.code, p]),
    );
    const existingNumbers = rows.length
      ? new Set(
          (
            await this.contracts.find({
              where: { contractNumber: In(rows.map((row) => row.contractNumber)) },
              select: { contractNumber: true },
            })
          ).map((row) => row.contractNumber),
        )
      : new Set<string>();

    const techSpec = TECH_SPEC_PRESETS[DEFAULT_TECH_SPEC_PRESET].techSpec;
    const entities: ContractEntity[] = [];
    for (const row of rows) {
      const partner = partnerByCode.get(row.partnerCode);
      if (!partner) {
        errors.push({
          row: row.row,
          field: 'partner_code',
          value: row.partnerCode,
          reason: 'Không tìm thấy đối tác có mã này.',
        });
      }
      if (existingNumbers.has(row.contractNumber)) {
        errors.push({
          row: row.row,
          field: 'contract_number',
          value: row.contractNumber,
          reason: 'Số HĐ đã có trong hệ thống.',
        });
      }
      const terms = validateContractTerms({
        pricingModel: row.pricingModel,
        pricingConfig: row.pricingConfig,
        techSpec,
        capAmount: row.capAmount,
        advanceAmount: row.advanceAmount,
        advanceDueBusinessDays: row.advanceDueBusinessDays,
        startDate: row.startDate,
        endDate: row.endDate,
      });
      if (!terms.ok) {
        for (const [field, messages] of Object.entries(terms.errors)) {
          for (const reason of messages) {
            errors.push({ row: row.row, field: toCsvField(field), value: '', reason });
          }
        }
        continue;
      }
      if (!partner) {
        continue;
      }
      entities.push(
        this.contracts.create({
          id: uuidv7(),
          partnerId: partner.id,
          contractNumber: row.contractNumber,
          contractType: 'content_production',
          signedDate: row.signedDate,
          startDate: row.startDate,
          endDate: row.endDate,
          status: row.status,
          pricingModel: row.pricingModel,
          pricingConfig: terms.value.pricingConfig,
          capAmount: row.capAmount,
          advanceAmount: row.advanceAmount,
          advanceDueBusinessDays: row.advanceDueBusinessDays,
          advanceOffsetRule: 'full_first',
          acceptanceCycle: row.acceptanceCycle,
          deliveryRule: null,
          paymentTermBusinessDays: row.paymentTermBusinessDays,
          techSpec: terms.value.techSpec,
          penaltyPercent: 8,
          originalityMinPercent: null,
          similarityMaxPercent: 30,
          nonCompeteMonths: 24,
          templateVersionId: null,
          managerUserId: partner.managerUserId,
          lastAppendixNumber: row.lastAppendixNumber,
          source: 'legacy_import',
          legacyAcceptedAmount: row.legacyAcceptedAmount,
          legacyPaidAmount: row.legacyPaidAmount,
          legacyAdvanceBalance: row.legacyAdvanceBalance,
          note: row.note,
          closedAt: row.status === 'completed' || row.status === 'terminated' ? new Date() : null,
          createdBy: actor.userId,
        }),
      );
    }
    if (errors.length > 0) {
      return failedImportResult(parsed.rows.length, errors);
    }
    try {
      await this.dataSource.transaction(async (manager: EntityManager) => {
        await manager.getRepository(ContractEntity).save(entities);
      });
    } catch (error) {
      if (this.numberTaken(error)) {
        return failedImportResult(parsed.rows.length, [
          { row: 0, field: 'contract_number', value: '', reason: 'Số HĐ đã có trong hệ thống.' },
        ]);
      }
      throw error;
    }
    await this.systemLog.write({
      level: 'info',
      category: CONTRACT_AUDIT_CATEGORY,
      action: 'CONTRACT_IMPORTED',
      message: `Imported ${entities.length} legacy contract(s)`,
      requestId: actor.requestId ?? null,
      userId: actor.userId,
      metadata: { contractIds: entities.map((entity) => entity.id) },
    });
    return successfulImportResult(parsed.rows.length);
  }

  /** The contract if the actor may see it (its manager, contract.read_all or admin). */
  async findVisible(id: string, actor: PartnerActor): Promise<ContractEntity> {
    const contract = await this.contracts.findOne({ where: { id } });
    if (!contract || !this.canSee(contract, actor)) {
      throw this.notFound();
    }
    return contract;
  }

  private canSee(contract: Pick<ContractEntity, 'managerUserId'>, actor: PartnerActor): boolean {
    return this.canSeeAll(actor) || contract.managerUserId === actor.userId;
  }

  private canSeeAll(actor: PartnerActor): boolean {
    return hasPermission(actor, GO_PERMISSIONS.CONTRACT_READ_ALL);
  }

  /**
   * Runs one state change in a transaction with the contract row locked, so two concurrent
   * changes cannot both pass the status check (NFR-03).
   */
  private async transition(
    id: string,
    action: ContractAction,
    actor: PartnerActor,
    apply?: (contract: ContractEntity) => void,
  ) {
    const contract = await this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(ContractEntity);
      const locked = await repository.findOne({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!locked || !this.canSee(locked, actor)) {
        throw this.notFound();
      }
      const from = locked.status;
      locked.status = this.assertTransition(locked, action);
      apply?.(locked);
      await repository.save(locked);
      return { locked, from };
    });
    await this.audit(actor, `CONTRACT_${action.toUpperCase()}`, contract.locked, {
      from: contract.from,
      to: contract.locked.status,
    });
    return this.get(id, actor);
  }

  private assertTransition(contract: ContractEntity, action: ContractAction) {
    try {
      return nextContractStatus(contract.status, action);
    } catch (error) {
      if (error instanceof ContractTransitionError) {
        throw new ConflictException({
          code: CONTRACT_ERROR_CODES.INVALID_TRANSITION,
          message: error.message,
          details: { status: contract.status, action },
        });
      }
      throw error;
    }
  }

  private async checkTerms(input: Parameters<typeof validateContractTerms>[0]) {
    const result = validateContractTerms(input);
    const fieldErrors: TermsErrors = result.ok ? {} : { ...result.errors };
    if (result.ok && input.pricingModel === 'package_tier') {
      const ids = (result.value.pricingConfig.category_ids as string[]) ?? [];
      const found = (await this.contracts.manager.query(
        `SELECT id FROM categories WHERE id = ANY($1::uuid[])`,
        [ids],
      )) as Array<{ id: string }>;
      const known = new Set(found.map((row) => row.id));
      const missing = ids.filter((categoryId) => !known.has(categoryId));
      if (missing.length > 0) {
        fieldErrors.pricingConfig = [
          `pricingConfig.category_ids: unknown categories ${missing.join(', ')}`,
        ];
      }
      const code = result.value.pricingConfig.rate_card_id as string;
      const cards = (await this.contracts.manager.query(
        `SELECT 1 FROM rate_cards WHERE code = $1 AND status <> 'archived' LIMIT 1`,
        [code],
      )) as unknown[];
      if (cards.length === 0) {
        (fieldErrors.pricingConfig ??= []).push(
          `pricingConfig.rate_card_id: unknown rate card ${code}`,
        );
      }
    }
    if (!result.ok || Object.keys(fieldErrors).length > 0) {
      throw new BadRequestException({
        code: CONTRACT_ERROR_CODES.TERMS_INVALID,
        message: 'Contract terms are invalid',
        fieldErrors,
      });
    }
    return result.value;
  }

  /** Amendment changes as stored (column names), validated against the contract's model. */
  private checkAmendment(
    contract: ContractEntity,
    input: AmendmentChangesDto,
    effectiveDate: string,
  ): Record<string, unknown> {
    const changes: Record<string, unknown> = {};
    const fieldErrors: TermsErrors = {};
    for (const [field, column] of Object.entries(AMENDMENT_CHANGE_COLUMNS) as Array<
      [keyof AmendmentChangesDto, string]
    >) {
      if (input[field] !== undefined) {
        changes[column] = input[field];
      }
    }
    if (Object.keys(changes).length === 0) {
      throw new BadRequestException({
        code: CONTRACT_ERROR_CODES.AMENDMENT_EMPTY,
        message: 'An amendment must change at least one term',
      });
    }
    if (effectiveDate < contract.startDate) {
      fieldErrors.effectiveDate = ['effectiveDate must not be before the contract start date'];
    }
    if (changes.pricing_config !== undefined) {
      const parsed = PRICING_CONFIG_SCHEMAS[contract.pricingModel as PricingModel].safeParse(
        changes.pricing_config,
      );
      if (parsed.success) {
        changes.pricing_config = parsed.data;
      } else {
        fieldErrors.pricingConfig = parsed.error.issues.map(
          (issue) => `pricingConfig.${issue.path.join('.')}: ${issue.message}`,
        );
      }
    }
    if (changes.tech_spec !== undefined) {
      const parsed = TechSpecSchema.safeParse(changes.tech_spec);
      if (parsed.success) {
        changes.tech_spec = parsed.data;
      } else {
        fieldErrors.techSpec = parsed.error.issues.map(
          (issue) => `techSpec.${issue.path.join('.')}: ${issue.message}`,
        );
      }
    }
    if (typeof changes.cap_amount === 'number' && changes.cap_amount < contract.advanceAmount) {
      fieldErrors.capAmount = ['capAmount must not be below the advance amount'];
    }
    if (typeof changes.end_date === 'string' && changes.end_date < contract.startDate) {
      fieldErrors.endDate = ['endDate must not be before the contract start date'];
    }
    if (Object.keys(fieldErrors).length > 0) {
      throw new BadRequestException({
        code: CONTRACT_ERROR_CODES.TERMS_INVALID,
        message: 'Amendment terms are invalid',
        fieldErrors,
      });
    }
    return changes;
  }

  private async findAmendment(contractId: string, amendmentId: string, actor: PartnerActor) {
    const contract = await this.findVisible(contractId, actor);
    const amendment = await this.amendments.findOne({ where: { id: amendmentId, contractId } });
    if (!amendment) {
      throw new NotFoundException({
        code: CONTRACT_ERROR_CODES.AMENDMENT_NOT_FOUND,
        message: 'Amendment not found',
      });
    }
    return { contract, amendment };
  }

  private assertDraftAmendment(amendment: ContractAmendmentEntity) {
    if (amendment.status !== 'draft') {
      throw new ConflictException({
        code: CONTRACT_ERROR_CODES.AMENDMENT_LOCKED,
        message: 'Only a draft amendment can be changed',
      });
    }
  }

  /** First free BR-05 number for this partner and date (`excludeId`: the contract renumbered). */
  private async generateNumber(partnerCode: string, date: string, excludeId?: string) {
    const base = contractNumberBase(date, partnerCode);
    const builder = this.contracts
      .createQueryBuilder('contract')
      .select('contract.contract_number', 'contractNumber')
      .where('(contract.contract_number = :base OR contract.contract_number LIKE :pattern)', {
        base,
        pattern: `${base.replace(/[\\%_]/g, (match) => `\\${match}`)}-%`,
      });
    if (excludeId) {
      builder.andWhere('contract.id <> :excludeId', { excludeId });
    }
    const taken = await builder.getRawMany<{ contractNumber: string }>();
    return nextContractNumber(
      base,
      taken.map((row) => row.contractNumber),
    );
  }

  private async insertContract(contract: ContractEntity) {
    try {
      await this.contracts.save(contract);
    } catch (error) {
      throw this.numberTaken(error) ?? error;
    }
  }

  private numberTaken(error: unknown) {
    if (!(error instanceof QueryFailedError)) {
      return null;
    }
    const driverError = error.driverError as { code?: string; constraint?: string };
    if (
      driverError?.code === '23505' &&
      driverError.constraint === 'contracts_contract_number_key'
    ) {
      return new ConflictException({
        code: CONTRACT_ERROR_CODES.NUMBER_TAKEN,
        message: 'This contract number is already used',
      });
    }
    return null;
  }

  private async partnerSummaries(ids: string[]): Promise<Map<string, PartnerSummary>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) {
      return new Map();
    }
    const rows = await this.partnerRepository.find({
      where: { id: In(unique) },
      select: { id: true, code: true, displayName: true, status: true },
    });
    return new Map(rows.map((row) => [row.id, row]));
  }

  private toResponse(contract: ContractEntity, partner: PartnerSummary | null): ContractResponse {
    const rest: Partial<ContractEntity> = { ...contract };
    delete rest.partnerSnapshotEnc;
    return {
      ...(rest as Omit<ContractEntity, 'partnerSnapshotEnc'>),
      partner,
      hasPartnerSnapshot: contract.partnerSnapshotAt !== null,
      allowedActions: allowedContractActions(contract.status),
      nextAppendixNumber: nextAppendixNumber(contract.lastAppendixNumber),
    };
  }

  private notFound() {
    return new NotFoundException({
      code: CONTRACT_ERROR_CODES.NOT_FOUND,
      message: 'Contract not found',
    });
  }

  private async audit(
    actor: PartnerActor,
    action: string,
    contract: ContractEntity,
    metadata: Record<string, unknown>,
  ) {
    await this.systemLog.write({
      level: 'info',
      category: CONTRACT_AUDIT_CATEGORY,
      action,
      message: `${action} ${contract.contractNumber} (${contract.id})`,
      requestId: actor.requestId ?? null,
      userId: actor.userId,
      metadata: { contractId: contract.id, partnerId: contract.partnerId, ...metadata },
    });
  }
}

/** API field name of a terms error → CSV column. */
function toCsvField(field: string): string {
  return field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
