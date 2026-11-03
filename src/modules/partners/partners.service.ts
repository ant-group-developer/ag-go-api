import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, QueryFailedError, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { subjectOfUserId } from '../../common/auth/user-subject';
import { isAdminUserType } from '../../common/auth/user-type';
import { ListResponseDto } from '../../common/dto/list-response.dto';
import { PartnerEntity } from '../../database/entities/partner.entity';
import { ACCOUNT_ERROR_CODES, AccountApiService } from '../account/account-api.service';
import type { AccountContractProfile } from '../account/account.types';
import { SystemLogService } from '../logs/system-log.service';
import type {
  CreatePartnerDto,
  ListPartnersQueryDto,
  PartnerProfileState,
  UpdatePartnerDto,
} from './dto/partner.dto';
import type { SearchPartnerCandidatesDto } from './dto/search-partner-candidates.dto';
import type { UpdatePartnerProfileDto } from './dto/update-partner-profile.dto';
import { hasPermission, type PartnerActor } from './partner-actor';
import { nextPartnerCode, partnerCodeBase } from './partner-code';
import {
  MASKED_PROFILE_FIELDS,
  PARTNER_PROFILE_FIELDS,
  profileCompleteness,
  toAccountChanges,
  toPartnerFieldNames,
  toProfileView,
  type PartnerProfileField,
  type PartnerProfileView,
  type ProfileCompleteness,
} from './partner-profile';

export const PARTNER_AUDIT_CATEGORY = 'partner';

export const PARTNER_AUDIT_ACTIONS = {
  CREATED: 'PARTNER_CREATED',
  UPDATED: 'PARTNER_UPDATED',
  PROFILE_VIEWED: 'PARTNER_PROFILE_VIEWED',
  PROFILE_UPDATED: 'PARTNER_PROFILE_UPDATED',
} as const;

export const PARTNER_ERROR_CODES = {
  NOT_FOUND: 'PARTNER_NOT_FOUND',
  ALREADY_EXISTS: 'PARTNER_ALREADY_EXISTS',
  CODE_TAKEN: 'PARTNER_CODE_TAKEN',
  ACCOUNT_MISMATCH: 'PARTNER_ACCOUNT_MISMATCH',
  ACCOUNT_INACTIVE: 'PARTNER_ACCOUNT_INACTIVE',
  NOTHING_TO_UPDATE: 'PARTNER_PROFILE_NOTHING_TO_UPDATE',
} as const;

export type PartnerResponse = PartnerEntity & {
  profileState: PartnerProfileState;
  activeContractCount: number;
};

export type PartnerProfileResponse = PartnerProfileView & { partnerId: string };

export type PartnerProfileUpdateResponse = PartnerProfileResponse & {
  changedFields: string[];
  warnings: string[];
};

export type PartnerCandidate = {
  accountUserId: string;
  /** AG Go user id to send as `goUserId` when creating the partner. */
  goUserId: string;
  /**
   * True when the AG Go id was seen as a project owner. Otherwise it is assumed equal to the AG
   * Account id, which holds for Auth0 database users but not for Google sign-ins.
   */
  goUserIdVerified: boolean;
  name?: string;
  email?: string;
  avatar?: string;
  /** Already a partner. */
  partnerId: string | null;
};

/** Why the profile was read, recorded with the audit entry. */
export type ProfileReadPurpose = 'profile_view' | 'contract_issue' | 'document_preview';

@Injectable()
export class PartnersService {
  private readonly logger = new Logger(PartnersService.name);

  constructor(
    @InjectRepository(PartnerEntity)
    private readonly partners: Repository<PartnerEntity>,
    private readonly accountApi: AccountApiService,
    private readonly systemLog: SystemLogService,
  ) {}

  async list(
    query: ListPartnersQueryDto,
    actor: PartnerActor,
  ): Promise<ListResponseDto<PartnerResponse>> {
    const builder = this.partners.createQueryBuilder('partner');
    if (!this.canSeeAll(actor)) {
      builder.andWhere('partner.manager_user_id = :me', { me: actor.userId });
    }
    if (query.managerUserId) {
      builder.andWhere('partner.manager_user_id = :managerUserId', {
        managerUserId: query.managerUserId,
      });
    }
    if (query.status) {
      builder.andWhere('partner.status = :status', { status: query.status });
    }
    if (query.profile === 'complete') {
      builder.andWhere(`partner.profile_missing_fields = '[]'::jsonb`);
    } else if (query.profile === 'incomplete') {
      builder.andWhere(`jsonb_array_length(partner.profile_missing_fields) > 0`);
    } else if (query.profile === 'unchecked') {
      builder.andWhere('partner.profile_missing_fields IS NULL');
    }
    const keyword = query.normalizedKeyword;
    if (keyword) {
      builder.andWhere('(partner.display_name ILIKE :keyword OR partner.code ILIKE :keyword)', {
        keyword: `%${keyword.replace(/[\\%_]/g, (match) => `\\${match}`)}%`,
      });
    }
    const [rows, total] = await builder
      .orderBy('partner.display_name', 'ASC')
      .addOrderBy('partner.id', 'ASC')
      .skip(query.skip)
      .take(query.pageSize)
      .getManyAndCount();
    const counts = await this.activeContractCounts(rows.map((row) => row.id));
    return new ListResponseDto(
      rows.map((row) => this.toResponse(row, counts.get(row.id) ?? 0)),
      query.page,
      query.pageSize,
      total,
    );
  }

  async get(id: string, actor: PartnerActor): Promise<PartnerResponse> {
    const partner = await this.findVisible(id, actor);
    const counts = await this.activeContractCounts([partner.id]);
    return this.toResponse(partner, counts.get(partner.id) ?? 0);
  }

  /** The partner if the actor may see it (manager, read_all or admin); 404 otherwise. */
  async findVisible(id: string, actor: PartnerActor): Promise<PartnerEntity> {
    const partner = await this.partners.findOne({ where: { id } });
    if (!partner || !this.canSee(partner, actor)) {
      throw new NotFoundException({
        code: PARTNER_ERROR_CODES.NOT_FOUND,
        message: 'Partner not found',
      });
    }
    return partner;
  }

  canSee(partner: Pick<PartnerEntity, 'managerUserId'>, actor: PartnerActor): boolean {
    return this.canSeeAll(actor) || partner.managerUserId === actor.userId;
  }

  /**
   * AG Account users of the AG Go application to pick a new partner from, flagged when already a
   * partner. The AG Go id is looked up among project owners, otherwise assumed equal to the AG
   * Account id (see PartnerCandidate.goUserIdVerified).
   */
  async searchCandidates(query: SearchPartnerCandidatesDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const response = await this.accountApi.searchApplicationUsers({
      keyword: query.keyword,
      page,
      limit,
    });
    const ids = response.data.map((user) => user.id);
    const [owners, existing] = await Promise.all([
      this.projectOwnersOf(ids),
      ids.length > 0
        ? this.partners.find({
            where: { accountUserId: In(ids) },
            select: { id: true, accountUserId: true },
          })
        : Promise.resolve([] as PartnerEntity[]),
    ]);
    const partnerByAccount = new Map(existing.map((row) => [row.accountUserId, row.id]));
    const text = (value: unknown) =>
      typeof value === 'string' && value.trim() ? value.trim() : undefined;
    const items: PartnerCandidate[] = response.data.map((user) => ({
      accountUserId: user.id,
      goUserId: owners.get(user.id) ?? user.id,
      goUserIdVerified: owners.has(user.id),
      name: text(user.name),
      email: text(user.email),
      avatar: text(user.avatar),
      partnerId: partnerByAccount.get(user.id) ?? null,
    }));
    return new ListResponseDto(items, page, limit, response.meta.total);
  }

  /**
   * Adds an AG Go user as a partner (FR-P-01, Q1): resolves their AG Account id by subject,
   * requires them to be an active member of AG Go, and caches their name. One partner per AG Go
   * user and per AG Account user.
   */
  async create(dto: CreatePartnerDto, actor: PartnerActor): Promise<PartnerResponse> {
    const goUserId = dto.goUserId.trim();
    const sameGoUser = await this.partners.findOne({ where: { goUserId } });
    if (sameGoUser) {
      throw this.alreadyExists(sameGoUser.id);
    }

    const account = await this.accountApi.resolveBySub(subjectOfUserId(goUserId));
    if (dto.accountUserId && dto.accountUserId !== account.user_id) {
      throw new BadRequestException({
        code: PARTNER_ERROR_CODES.ACCOUNT_MISMATCH,
        message: 'goUserId belongs to another AG Account user than accountUserId',
      });
    }
    if (account.is_active === false) {
      throw new BadRequestException({
        code: PARTNER_ERROR_CODES.ACCOUNT_INACTIVE,
        message: 'The AG Account user is deactivated',
      });
    }
    // by-sub/access answers for any user; members of AG Go have a role there (or are admins).
    if (!isAdminUserType(account.user_type) && account.permissions.length === 0) {
      throw new NotFoundException({
        code: ACCOUNT_ERROR_CODES.USER_NOT_IN_APPLICATION,
        message: 'The user is not a member of AG Go in AG Account, or does not exist',
      });
    }
    const sameAccount = await this.partners.findOne({ where: { accountUserId: account.user_id } });
    if (sameAccount) {
      throw this.alreadyExists(sameAccount.id);
    }

    const user = (await this.accountApi.getUsersByIds([account.user_id], 'id,name,email')).get(
      account.user_id,
    );
    const name =
      (typeof user?.name === 'string' && user.name.trim()) ||
      (typeof user?.email === 'string' && user.email.trim()) ||
      goUserId;
    const code = dto.code ?? (await this.generateCode(name));
    if (dto.code && (await this.partners.exists({ where: { code: dto.code } }))) {
      throw this.codeTaken(dto.code);
    }

    const partner = this.partners.create({
      id: uuidv7(),
      accountUserId: account.user_id,
      goUserId,
      code,
      displayName: name.slice(0, 200),
      managerUserId: dto.managerUserId?.trim() || actor.userId,
      status: 'active',
      profileCheckedAt: null,
      profileMissingFields: null,
      note: dto.note?.trim() || null,
      createdBy: actor.userId,
    });
    try {
      await this.partners.insert(partner);
    } catch (error) {
      throw this.uniqueViolation(error) ?? error;
    }
    await this.audit(actor, PARTNER_AUDIT_ACTIONS.CREATED, partner, {
      code,
      managerUserId: partner.managerUserId,
    });
    return this.toResponse(await this.partners.findOneByOrFail({ id: partner.id }), 0);
  }

  /** Code, manager, status (FR-P-11: inactive partners get no new contract) and note. */
  async update(id: string, dto: UpdatePartnerDto, actor: PartnerActor): Promise<PartnerResponse> {
    const partner = await this.findVisible(id, actor);
    const changed: string[] = [];
    if (dto.code !== undefined && dto.code !== partner.code) {
      if (await this.partners.exists({ where: { code: dto.code } })) {
        throw this.codeTaken(dto.code);
      }
      partner.code = dto.code;
      changed.push('code');
    }
    if (dto.managerUserId !== undefined && dto.managerUserId.trim() !== partner.managerUserId) {
      partner.managerUserId = dto.managerUserId.trim();
      changed.push('managerUserId');
    }
    if (dto.status !== undefined && dto.status !== partner.status) {
      partner.status = dto.status;
      changed.push('status');
    }
    if (dto.note !== undefined && (dto.note?.trim() || null) !== partner.note) {
      partner.note = dto.note?.trim() || null;
      changed.push('note');
    }
    if (changed.length > 0) {
      try {
        await this.partners.save(partner);
      } catch (error) {
        throw this.uniqueViolation(error) ?? error;
      }
      await this.audit(actor, PARTNER_AUDIT_ACTIONS.UPDATED, partner, { fields: changed });
    }
    return this.get(partner.id, actor);
  }

  /**
   * The AG Account contract profile, masked unless `reveal` (which needs go.partner.pii_read).
   * Every read is audited (field names only) and refreshes the "profile complete" check.
   */
  async getProfile(
    id: string,
    reveal: boolean,
    actor: PartnerActor,
  ): Promise<PartnerProfileResponse> {
    if (reveal && !hasPermission(actor, GO_PERMISSIONS.PARTNER_PII_READ)) {
      throw new ForbiddenException(
        `Missing required permission(s): ${GO_PERMISSIONS.PARTNER_PII_READ}`,
      );
    }
    const partner = await this.findVisible(id, actor);
    const { profile } = await this.readProfile(partner, actor, 'profile_view', reveal);
    return { partnerId: partner.id, ...toProfileView(profile, reveal) };
  }

  /**
   * Partial update through AG Account (`PATCH` + `If-Match: version`). 409 when the profile changed
   * since it was read: the client reloads it. Returns the new profile, masked.
   */
  async updateProfile(
    id: string,
    dto: UpdatePartnerProfileDto,
    actor: PartnerActor,
  ): Promise<PartnerProfileUpdateResponse> {
    const partner = await this.findVisible(id, actor);
    const input: Partial<Record<PartnerProfileField, string | null>> = {};
    for (const field of PARTNER_PROFILE_FIELDS) {
      if (dto[field] !== undefined) {
        input[field] = dto[field];
      }
    }
    const changes = toAccountChanges(input);
    if (Object.keys(changes).length === 0) {
      throw new BadRequestException({
        code: PARTNER_ERROR_CODES.NOTHING_TO_UPDATE,
        message: 'No profile field to update',
      });
    }
    const actingUserId = await this.actingAccountUserId(actor);
    const result = await this.accountApi.patchContractProfile(partner.accountUserId, changes, {
      version: dto.version,
      actingUserId,
    });
    const changedFields = toPartnerFieldNames(result.changed_fields);
    await this.audit(actor, PARTNER_AUDIT_ACTIONS.PROFILE_UPDATED, partner, {
      fields: changedFields,
      requestedFields: toPartnerFieldNames(Object.keys(changes)),
    });
    await this.recordCompleteness(partner, result);
    return {
      partnerId: partner.id,
      ...toProfileView(result, false),
      changedFields,
      warnings: result.warnings ?? [],
    };
  }

  /**
   * Reads the full profile for a document (contract issue): audited like a revealed view, and
   * the completeness is recorded. Callers must keep the values out of logs and responses.
   */
  async readProfileForDocument(
    partner: PartnerEntity,
    actor: PartnerActor,
  ): Promise<{ profile: AccountContractProfile; completeness: ProfileCompleteness }> {
    return this.readProfile(partner, actor, 'contract_issue', true);
  }

  /** Full profile printed on the preview of a draft document (audited as a view, spec 13). */
  async readProfileForPreview(
    partner: PartnerEntity,
    actor: PartnerActor,
  ): Promise<{ profile: AccountContractProfile; completeness: ProfileCompleteness }> {
    return this.readProfile(partner, actor, 'document_preview', true);
  }

  /** USER_PROFILE_CHANGED webhook: refreshes the cached names of these AG Account users. */
  async refreshDisplayNames(accountUserIds: string[]): Promise<number> {
    const ids = [...new Set(accountUserIds.filter(Boolean))];
    if (ids.length === 0) {
      return 0;
    }
    const rows = await this.partners.find({ where: { accountUserId: In(ids) } });
    if (rows.length === 0) {
      return 0;
    }
    const users = await this.accountApi.getUsersByIds(
      rows.map((row) => row.accountUserId),
      'id,name,email',
    );
    let updated = 0;
    for (const row of rows) {
      const name = users.get(row.accountUserId)?.name;
      if (typeof name === 'string' && name.trim() && name.trim() !== row.displayName) {
        await this.partners.update(row.id, { displayName: name.trim().slice(0, 200) });
        updated += 1;
      }
    }
    return updated;
  }

  /**
   * CONTRACT_PROFILE_CHANGED webhook: the last completeness check no longer holds; the next
   * profile view or contract issue checks again.
   */
  async markProfileChanged(accountUserId: string): Promise<void> {
    await this.partners.update(
      { accountUserId },
      { profileCheckedAt: null, profileMissingFields: null },
    );
  }

  /** AG Account id of the AG Go user acting, sent as X-Acting-User-Id (spec 7.0.6). */
  async actingAccountUserId(actor: PartnerActor): Promise<string> {
    const account = await this.accountApi.resolveBySub(actor.sub ?? subjectOfUserId(actor.userId));
    return account.user_id;
  }

  private async readProfile(
    partner: PartnerEntity,
    actor: PartnerActor,
    purpose: ProfileReadPurpose,
    reveal: boolean,
  ): Promise<{ profile: AccountContractProfile; completeness: ProfileCompleteness }> {
    const actingUserId = await this.actingAccountUserId(actor);
    const profile = await this.accountApi.getContractProfile(partner.accountUserId, actingUserId);
    const completeness = profileCompleteness(profile);
    await this.audit(actor, PARTNER_AUDIT_ACTIONS.PROFILE_VIEWED, partner, {
      purpose,
      reveal,
      // Sensitive fields returned in full; the others are always shown.
      fields: reveal ? MASKED_PROFILE_FIELDS : [],
    });
    await this.recordCompleteness(partner, profile, completeness);
    return { profile, completeness };
  }

  private async recordCompleteness(
    partner: PartnerEntity,
    profile: AccountContractProfile,
    completeness = profileCompleteness(profile),
  ): Promise<void> {
    const patch: Partial<PartnerEntity> = {
      profileMissingFields: completeness.missing,
      profileCheckedAt: completeness.complete ? new Date() : null,
    };
    const name = profile.name?.trim();
    if (name && name !== partner.displayName) {
      patch.displayName = name.slice(0, 200);
    }
    await this.partners.update(partner.id, patch);
    Object.assign(partner, patch);
  }

  private canSeeAll(actor: PartnerActor): boolean {
    return hasPermission(actor, GO_PERMISSIONS.PARTNER_READ_ALL);
  }

  private async generateCode(name: string): Promise<string> {
    const base = partnerCodeBase(name);
    const taken = await this.partners
      .createQueryBuilder('partner')
      .select('partner.code', 'code')
      .where('partner.code LIKE :prefix', { prefix: `${base}%` })
      .getRawMany<{ code: string }>();
    return nextPartnerCode(
      base,
      taken.map((row) => row.code),
    );
  }

  /** Project owners among these ids, keyed by AG Account id: the id itself or `provider|id`. */
  private async projectOwnersOf(accountUserIds: string[]): Promise<Map<string, string>> {
    if (accountUserIds.length === 0) {
      return new Map();
    }
    const rows = (await this.partners.manager.query(
      `SELECT DISTINCT owner_user_id AS "ownerUserId"
       FROM projects
       WHERE owner_user_id = ANY($1::varchar[])
          OR split_part(owner_user_id, '|', 2) = ANY($1::varchar[])`,
      [accountUserIds],
    )) as Array<{ ownerUserId: string }>;
    const owners = new Map<string, string>();
    for (const { ownerUserId } of rows) {
      const accountId = ownerUserId.includes('|')
        ? ownerUserId.slice(ownerUserId.indexOf('|') + 1)
        : ownerUserId;
      // Prefer the plain id (Auth0 database user) when both forms exist.
      if (!owners.has(accountId) || !ownerUserId.includes('|')) {
        owners.set(accountId, ownerUserId);
      }
    }
    return owners;
  }

  private async activeContractCounts(partnerIds: string[]): Promise<Map<string, number>> {
    if (partnerIds.length === 0) {
      return new Map();
    }
    const rows = (await this.partners.manager.query(
      `SELECT partner_id AS "partnerId", count(*)::int AS count
       FROM contracts
       WHERE partner_id = ANY($1::uuid[]) AND status = 'active'
       GROUP BY partner_id`,
      [partnerIds],
    )) as Array<{ partnerId: string; count: number }>;
    return new Map(rows.map((row) => [row.partnerId, Number(row.count)]));
  }

  private toResponse(partner: PartnerEntity, activeContractCount: number): PartnerResponse {
    const missing = partner.profileMissingFields;
    return {
      ...partner,
      profileState:
        missing === null ? 'unchecked' : missing.length === 0 ? 'complete' : 'incomplete',
      activeContractCount,
    };
  }

  private async audit(
    actor: PartnerActor,
    action: string,
    partner: PartnerEntity,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.systemLog.write({
      level: 'info',
      category: PARTNER_AUDIT_CATEGORY,
      action,
      message: `${action} partner ${partner.code} (${partner.id})`,
      requestId: actor.requestId ?? null,
      userId: actor.userId,
      metadata: { partnerId: partner.id, accountUserId: partner.accountUserId, ...metadata },
    });
  }

  private alreadyExists(partnerId: string) {
    return new ConflictException({
      code: PARTNER_ERROR_CODES.ALREADY_EXISTS,
      message: 'This user is already a partner',
      details: { partnerId },
    });
  }

  private codeTaken(code?: string) {
    return new ConflictException({
      code: PARTNER_ERROR_CODES.CODE_TAKEN,
      message: code ? `Partner code ${code} is already used` : 'Partner code is already used',
    });
  }

  private uniqueViolation(error: unknown) {
    if (!(error instanceof QueryFailedError)) {
      return null;
    }
    const driverError = error.driverError as { code?: string; constraint?: string };
    if (driverError?.code !== '23505') {
      return null;
    }
    if (driverError.constraint === 'partners_code_key') {
      return this.codeTaken();
    }
    this.logger.warn(`Partner unique violation on ${driverError.constraint ?? 'unknown'}`);
    return new ConflictException({
      code: PARTNER_ERROR_CODES.ALREADY_EXISTS,
      message: 'This user is already a partner',
    });
  }
}
