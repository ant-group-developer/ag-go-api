import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { v7 as uuidv7 } from 'uuid';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { ListResponseDto } from '../../common/dto/list-response.dto';
import { ProductPackageEntity } from '../../database/entities/product-package.entity';
import { ProjectAuditLogEntity } from '../../database/entities/project-audit-log.entity';
import { SystemLogService } from '../logs/system-log.service';
import { hasPermission, type PartnerActor } from '../partners/partner-actor';
import { contractDay, requestSpecChecks } from '../project-contracts/project-delivery';
import type { CreatePackageDto, ListPackagesQueryDto, UpdatePackageDto } from './dto/package.dto';
import { previewSummary, pricePackage, type PackagePricing } from './package-pricing';
import { PACKAGE_AUDIT_CATEGORY, refreshPackageProgress } from './package-progress';
import {
  canTransitionPackage,
  nextPackageStatus,
  packageCode,
  packageCodePrefix,
  PackageTransitionError,
  USER_PACKAGE_ACTIONS,
  type PackageAction,
  type UserPackageAction,
} from './package-state';

export const PACKAGE_ERROR_CODES = {
  NOT_FOUND: 'PACKAGE_NOT_FOUND',
  FORBIDDEN: 'PACKAGE_FORBIDDEN',
  INVALID_TRANSITION: 'PACKAGE_INVALID_TRANSITION',
  LOCKED: 'PACKAGE_LOCKED',
  CONTRACT_INVALID: 'PACKAGE_CONTRACT_INVALID',
  CONTRACT_REQUIRED: 'PACKAGE_CONTRACT_REQUIRED',
  CATEGORY_INVALID: 'PACKAGE_CATEGORY_INVALID',
  PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND',
  PROJECT_INVALID: 'PACKAGE_PROJECT_INVALID',
  PROJECT_IN_OTHER_PACKAGE: 'PROJECT_IN_OTHER_PACKAGE',
  EMPTY: 'PACKAGE_EMPTY',
  BELOW_TIER_1: 'PACKAGE_BELOW_TIER_1',
  NOT_PRICED: 'PACKAGE_NOT_PRICED',
} as const;

type PackageRow = ProductPackageEntity & {
  partnerCode: string;
  partnerName: string;
  partnerGoUserId: string;
  contractNumber: string;
  contractStatus: string;
  contractManagerUserId: string;
  categoryName: string | null;
  projectCount: number;
};

export type PackageAllowedAction = UserPackageAction | 'rename' | 'add_project' | 'remove_project';

export type PackageResponse = Omit<
  PackageRow,
  | 'partnerCode'
  | 'partnerName'
  | 'partnerGoUserId'
  | 'contractNumber'
  | 'contractStatus'
  | 'contractManagerUserId'
  | 'categoryName'
> & {
  partner: { id: string; code: string; displayName: string; goUserId: string };
  contract: { id: string; contractNumber: string; status: string; managerUserId: string };
  category: { id: string; name: string | null };
  allowedActions: PackageAllowedAction[];
};

const SELECT_PACKAGE = `
  SELECT package.id, package.contract_id AS "contractId", package.partner_id AS "partnerId",
         package.category_id AS "categoryId", package.sequence_number AS "sequenceNumber",
         package.code, package.name, package.status, package.submitted_at AS "submittedAt",
         package.submitted_by AS "submittedBy", package.evaluated_at AS "evaluatedAt",
         package.returned_reason AS "returnedReason", package.returned_at AS "returnedAt",
         package.returned_by AS "returnedBy", package.preview, package.preview_at AS "previewAt",
         package.submitted_preview AS "submittedPreview", package.acceptance_id AS "acceptanceId",
         package.acceptance_item_id AS "acceptanceItemId", package.cancelled_at AS "cancelledAt",
         package.created_by AS "createdBy", package.created_at AS "createdAt",
         package.updated_at AS "updatedAt",
         partner.code AS "partnerCode", partner.display_name AS "partnerName",
         partner.go_user_id AS "partnerGoUserId",
         contract.contract_number AS "contractNumber", contract.status AS "contractStatus",
         contract.manager_user_id AS "contractManagerUserId",
         category.name AS "categoryName",
         (SELECT count(*)::int FROM projects project WHERE project.package_id = package.id)
           AS "projectCount"
  FROM product_packages package
  INNER JOIN partners partner ON partner.id = package.partner_id
  INNER JOIN contracts contract ON contract.id = package.contract_id
  LEFT JOIN categories category ON category.id = package.category_id`;

/** `update` of a package; jsonb columns typed as records do not fit TypeORM's deep partial. */
function patchPackage(manager: EntityManager, id: string, changes: Partial<ProductPackageEntity>) {
  return manager.update(
    ProductPackageEntity,
    id,
    changes as QueryDeepPartialEntity<ProductPackageEntity>,
  );
}

function today(): string {
  return contractDay(new Date());
}

/**
 * Product packages of `package_tier` contracts (spec 7.4.1, FR-K-01…08). The partner (CTV, owner
 * of the projects) manages their own packages from "my-projects" (Q-R11); the contract's manager
 * with go.acceptance.prepare does it for them; evaluators (go.project.evaluate) see and return them.
 */
@Injectable()
export class PackagesService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly systemLog: SystemLogService,
  ) {}

  async list(query: ListPackagesQueryDto, actor: PartnerActor) {
    const where: string[] = [];
    const params: unknown[] = [];
    const param = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const me = param(actor.userId);
    if (query.mine) {
      where.push(`partner.go_user_id = ${me}`);
    } else {
      const scopes = [`partner.go_user_id = ${me}`];
      if (this.canSeeAllPrepared(actor)) {
        scopes.push('true');
      } else if (hasPermission(actor, GO_PERMISSIONS.ACCEPTANCE_PREPARE)) {
        scopes.push(`contract.manager_user_id = ${me}`);
      }
      where.push(`(${scopes.join(' OR ')})`);
    }
    if (query.contractId) where.push(`package.contract_id = ${param(query.contractId)}`);
    if (query.partnerId) where.push(`package.partner_id = ${param(query.partnerId)}`);
    if (query.categoryId) where.push(`package.category_id = ${param(query.categoryId)}`);
    if (query.status) where.push(`package.status = ${param(query.status)}`);
    if (query.readyForAcceptance) {
      where.push(`package.status = 'evaluated' AND package.acceptance_id IS NULL`);
    }
    const keyword = query.normalizedKeyword;
    if (keyword) {
      const like = param(`%${keyword.replace(/[\\%_]/g, (match) => `\\${match}`)}%`);
      where.push(
        `(package.code ILIKE ${like} OR package.name ILIKE ${like} OR partner.display_name ILIKE ${like})`,
      );
    }
    const filter = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const [{ total }] = (await this.dataSource.query(
      `SELECT count(*)::int AS total FROM product_packages package
       INNER JOIN partners partner ON partner.id = package.partner_id
       INNER JOIN contracts contract ON contract.id = package.contract_id ${filter}`,
      params,
    )) as Array<{ total: number }>;
    const rows = (await this.dataSource.query(
      `${SELECT_PACKAGE} ${filter}
       ORDER BY package.created_at DESC, package.id DESC
       LIMIT ${param(query.pageSize)} OFFSET ${param(query.skip)}`,
      params,
    )) as PackageRow[];
    return new ListResponseDto(
      rows.map((row) => this.toResponse(row, actor)),
      query.page,
      query.pageSize,
      total,
    );
  }

  /** Detail with the live computation (FR-K-03) of its projects. */
  async get(id: string, actor: PartnerActor) {
    const row = await this.findVisible(this.dataSource.manager, id, actor);
    const pricing = await this.livePricing(this.dataSource.manager, row);
    return { ...this.toResponse(row, actor), pricing };
  }

  /** Recomputes and stores the preview (`product_packages.preview`). */
  async preview(id: string, actor: PartnerActor): Promise<PackagePricing> {
    const row = await this.findVisible(this.dataSource.manager, id, actor);
    return this.livePricing(this.dataSource.manager, row, true);
  }

  async create(dto: CreatePackageDto, actor: PartnerActor) {
    const id = await this.dataSource.transaction(async (manager) => {
      const contract = await this.contractForCreate(manager, dto, actor);
      const [partner] = (await manager.query(
        `SELECT id, code FROM partners WHERE id = $1 FOR UPDATE`,
        [contract.partnerId],
      )) as Array<{ id: string; code: string }>;
      const [category] = (await manager.query(`SELECT slug FROM categories WHERE id = $1`, [
        dto.categoryId,
      ])) as Array<{ slug: string }>;
      const [{ next }] = (await manager.query(
        `SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next FROM product_packages WHERE partner_id = $1`,
        [partner.id],
      )) as Array<{ next: number }>;
      const sequence = Number(next);
      const created = manager.create(ProductPackageEntity, {
        id: uuidv7(),
        contractId: contract.id,
        partnerId: partner.id,
        categoryId: dto.categoryId,
        sequenceNumber: sequence,
        code: packageCode(packageCodePrefix(category?.slug ?? ''), partner.code, sequence),
        name: dto.name?.trim() || null,
        status: 'open',
        createdBy: actor.userId,
      });
      await manager.save(created);
      return created.id;
    });
    const detail = await this.get(id, actor);
    await this.audit(actor, 'PACKAGE_CREATED', detail, { contractId: detail.contractId });
    return detail;
  }

  async update(id: string, dto: UpdatePackageDto, actor: PartnerActor) {
    await this.dataSource.transaction(async (manager) => {
      const row = await this.findVisible(manager, id, actor, true);
      this.assertCanChange(row, actor);
      if (dto.name !== undefined) {
        await patchPackage(manager, id, { name: dto.name?.trim() || null });
      }
    });
    return this.get(id, actor);
  }

  /**
   * Adds a project of the same partner, contract and category to an open package (FR-K-02). A
   * project not linked yet is linked to the package's contract (and its checks queued).
   */
  async addProject(id: string, projectId: string, actor: PartnerActor) {
    const linked = await this.dataSource.transaction(async (manager) => {
      const row = await this.findVisible(manager, id, actor, true);
      this.assertCanChange(row, actor);
      this.assertOpen(row);
      const [project] = (await manager.query(
        `SELECT id, owner_user_id AS "ownerUserId", category_id AS "categoryId",
                contract_id AS "contractId", package_id AS "packageId",
                accepted_outside_at AS "acceptedOutsideAt"
         FROM projects WHERE id = $1 FOR UPDATE`,
        [projectId],
      )) as Array<{
        id: string;
        ownerUserId: string;
        categoryId: string | null;
        contractId: string | null;
        packageId: string | null;
        acceptedOutsideAt: Date | null;
      }>;
      if (!project) {
        throw new NotFoundException({
          code: PACKAGE_ERROR_CODES.PROJECT_NOT_FOUND,
          message: 'Project not found',
        });
      }
      if (project.packageId === id) {
        return false;
      }
      const invalid = (message: string) =>
        new ConflictException({ code: PACKAGE_ERROR_CODES.PROJECT_INVALID, message });
      if (project.packageId) {
        throw new ConflictException({
          code: PACKAGE_ERROR_CODES.PROJECT_IN_OTHER_PACKAGE,
          message: 'The project is already in another package',
        });
      }
      if (project.ownerUserId !== row.partnerGoUserId) {
        throw invalid('The project belongs to another partner');
      }
      if (project.categoryId !== row.categoryId) {
        throw invalid('The project is not of the package category');
      }
      if (project.contractId && project.contractId !== row.contractId) {
        throw invalid('The project is linked to another contract');
      }
      if (project.acceptedOutsideAt) {
        throw invalid('The project was accepted outside AG Go');
      }
      const counted = (await manager.query(
        `SELECT 1 FROM acceptance_item_sources WHERE project_id = $1 AND is_active LIMIT 1`,
        [projectId],
      )) as unknown[];
      if (counted.length > 0) {
        throw invalid('The project is already counted on an acceptance record');
      }
      await manager.query(
        `UPDATE projects SET package_id = $2, contract_id = $3, updated_at = now() WHERE id = $1`,
        [projectId, id, row.contractId],
      );
      await manager.insert(ProjectAuditLogEntity, {
        projectId,
        actorUserId: actor.userId,
        action: 'package_added',
        afterData: { packageId: id, packageCode: row.code },
        metadata: {},
      });
      if (!project.contractId) {
        await manager.insert(ProjectAuditLogEntity, {
          projectId,
          actorUserId: actor.userId,
          action: 'contract_linked',
          afterData: { contractId: row.contractId, contractNumber: row.contractNumber },
          metadata: { source: 'package', packageId: id },
        });
        await requestSpecChecks(manager, projectId);
      }
      return true;
    });
    if (linked) {
      await this.dataSource.transaction((manager) => this.storePreview(manager, id));
    }
    return this.get(id, actor);
  }

  async removeProject(id: string, projectId: string, actor: PartnerActor) {
    await this.dataSource.transaction(async (manager) => {
      const row = await this.findVisible(manager, id, actor, true);
      this.assertCanChange(row, actor);
      this.assertOpen(row);
      const removed = (await manager.query(
        `UPDATE projects SET package_id = NULL, updated_at = now()
         WHERE id = $1 AND package_id = $2 RETURNING id`,
        [projectId, id],
      )) as [unknown[], number];
      if ((removed[0] ?? []).length === 0) {
        throw new NotFoundException({
          code: PACKAGE_ERROR_CODES.PROJECT_NOT_FOUND,
          message: 'The project is not in this package',
        });
      }
      await manager.insert(ProjectAuditLogEntity, {
        projectId,
        actorUserId: actor.userId,
        action: 'package_removed',
        beforeData: { packageId: id, packageCode: row.code },
        metadata: {},
      });
      await this.storePreview(manager, id);
    });
    return this.get(id, actor);
  }

  /** open → submitted, refused below tier 1 (FR-K-04, TC-10); evaluated at once if it already is. */
  async submit(id: string, actor: PartnerActor) {
    await this.dataSource.transaction(async (manager) => {
      const row = await this.findVisible(manager, id, actor, true);
      this.assertCanChange(row, actor);
      this.assertTransition(row, 'submit');
      if (row.projectCount === 0) {
        throw new UnprocessableEntityException({
          code: PACKAGE_ERROR_CODES.EMPTY,
          message: 'Add projects to the package before submitting it',
        });
      }
      const pricing = await pricePackage(manager, row, today(), 'provisional');
      if (!pricing.result) {
        throw new UnprocessableEntityException({
          code: PACKAGE_ERROR_CODES.NOT_PRICED,
          message: pricing.problems.map((problem) => problem.message).join('; '),
          details: { problems: pricing.problems },
        });
      }
      if (pricing.result.belowTier1) {
        const warning = pricing.result.warnings.find((item) => item.code === 'BELOW_TIER_1');
        throw new UnprocessableEntityException({
          code: PACKAGE_ERROR_CODES.BELOW_TIER_1,
          message: warning?.message ?? 'Gói chưa đạt Mức 1',
          details: { next: pricing.result.next },
        });
      }
      const summary = previewSummary(pricing);
      await patchPackage(manager, id, {
        status: 'submitted',
        submittedAt: new Date(),
        submittedBy: actor.userId,
        returnedReason: null,
        returnedAt: null,
        returnedBy: null,
        preview: summary,
        previewAt: new Date(),
        submittedPreview: summary,
      });
      await refreshPackageProgress(manager, id);
    });
    return this.afterTransition(id, 'submit', actor);
  }

  /** submitted → open by the partner or the manager (FR-K-05). */
  withdraw(id: string, actor: PartnerActor) {
    return this.userTransition(id, 'withdraw', actor, (row) => {
      this.assertCanChange(row, actor);
      return { submittedAt: null, submittedBy: null };
    });
  }

  /** submitted / evaluated → open by an evaluator, with a reason (FR-K-05). */
  returnPackage(id: string, reason: string, actor: PartnerActor) {
    return this.userTransition(
      id,
      'return',
      actor,
      (row) => {
        if (!hasPermission(actor, GO_PERMISSIONS.PROJECT_EVALUATE)) {
          throw this.forbidden('Returning a package needs go.project.evaluate');
        }
        this.assertNotHeld(row);
        return {
          returnedReason: reason.trim(),
          returnedAt: new Date(),
          returnedBy: actor.userId,
          evaluatedAt: null,
        };
      },
      { reason: reason.trim() },
    );
  }

  /** evaluated → open to add projects after one was rejected (FR-K-08). */
  reopen(id: string, actor: PartnerActor) {
    return this.userTransition(id, 'reopen', actor, (row) => {
      this.assertCanChange(row, actor);
      this.assertNotHeld(row);
      return { evaluatedAt: null };
    });
  }

  /** open → cancelled; its projects are released. */
  cancel(id: string, actor: PartnerActor) {
    return this.userTransition(id, 'cancel', actor, async (row, manager) => {
      this.assertCanChange(row, actor);
      await manager.query(`UPDATE projects SET package_id = NULL WHERE package_id = $1`, [id]);
      return { cancelledAt: new Date() };
    });
  }

  // -------------------------------------------------------------------------

  private async userTransition(
    id: string,
    action: UserPackageAction,
    actor: PartnerActor,
    apply: (
      row: PackageRow,
      manager: EntityManager,
    ) => Partial<ProductPackageEntity> | Promise<Partial<ProductPackageEntity>>,
    metadata: Record<string, unknown> = {},
  ) {
    await this.dataSource.transaction(async (manager) => {
      const row = await this.findVisible(manager, id, actor, true);
      const status = this.assertTransition(row, action);
      const changes = await apply(row, manager);
      await patchPackage(manager, id, { ...changes, status });
    });
    return this.afterTransition(id, action, actor, metadata);
  }

  private async afterTransition(
    id: string,
    action: PackageAction,
    actor: PartnerActor,
    metadata: Record<string, unknown> = {},
  ) {
    const detail = await this.get(id, actor);
    await this.audit(actor, `PACKAGE_${action.toUpperCase()}`, detail, {
      to: detail.status,
      ...metadata,
    });
    return detail;
  }

  private async livePricing(manager: EntityManager, row: PackageRow, store = false) {
    const mode = row.status === 'open' || row.status === 'submitted' ? 'provisional' : 'final';
    const pricing = await pricePackage(manager, row, today(), mode);
    if (store || row.status === 'open') {
      await patchPackage(manager, row.id, {
        preview: previewSummary(pricing),
        previewAt: new Date(),
      });
    }
    return pricing;
  }

  private async storePreview(manager: EntityManager, id: string) {
    const [row] = (await manager.query(
      `SELECT id, contract_id AS "contractId", category_id AS "categoryId" FROM product_packages WHERE id = $1`,
      [id],
    )) as Array<{ id: string; contractId: string; categoryId: string }>;
    const pricing = await pricePackage(manager, row, today(), 'provisional');
    await patchPackage(manager, id, {
      preview: previewSummary(pricing),
      previewAt: new Date(),
    });
  }

  /** The contract a new package goes under (FR-K-01), checked for the actor. */
  private async contractForCreate(
    manager: EntityManager,
    dto: CreatePackageDto,
    actor: PartnerActor,
  ) {
    const candidates = (await manager.query(
      `SELECT contract.id, contract.partner_id AS "partnerId", contract.status,
              contract.pricing_model AS "pricingModel", contract.pricing_config AS "pricingConfig",
              contract.manager_user_id AS "managerUserId", partner.go_user_id AS "goUserId",
              partner.status AS "partnerStatus"
       FROM contracts contract
       INNER JOIN partners partner ON partner.id = contract.partner_id
       WHERE ${dto.contractId ? 'contract.id = $1' : `partner.go_user_id = $1 AND contract.status = 'active' AND contract.pricing_model = 'package_tier'`}`,
      [dto.contractId ?? actor.userId],
    )) as Array<{
      id: string;
      partnerId: string;
      status: string;
      pricingModel: string;
      pricingConfig: { category_ids?: string[] };
      managerUserId: string;
      goUserId: string;
      partnerStatus: string;
    }>;
    const matching = dto.contractId
      ? candidates
      : candidates.filter((contract) =>
          (contract.pricingConfig.category_ids ?? []).includes(dto.categoryId),
        );
    if (!dto.contractId && matching.length !== 1) {
      throw new BadRequestException({
        code: PACKAGE_ERROR_CODES.CONTRACT_REQUIRED,
        message:
          matching.length === 0
            ? 'No active package_tier contract of yours covers this category'
            : 'Several contracts cover this category: choose one (contractId)',
      });
    }
    const contract = matching[0];
    if (!contract) {
      throw new NotFoundException({
        code: PACKAGE_ERROR_CODES.CONTRACT_INVALID,
        message: 'Contract not found',
      });
    }
    const owner = contract.goUserId === actor.userId;
    if (!owner && !this.canPrepare(contract.managerUserId, actor)) {
      throw this.forbidden('Only the partner or the contract manager creates its packages');
    }
    if (
      contract.status !== 'active' ||
      contract.pricingModel !== 'package_tier' ||
      contract.partnerStatus !== 'active'
    ) {
      throw new ConflictException({
        code: PACKAGE_ERROR_CODES.CONTRACT_INVALID,
        message: 'Packages need an active package_tier contract of an active partner',
      });
    }
    if (!(contract.pricingConfig.category_ids ?? []).includes(dto.categoryId)) {
      throw new BadRequestException({
        code: PACKAGE_ERROR_CODES.CATEGORY_INVALID,
        message: 'The category is not one of the contract products',
      });
    }
    const pricing = await pricePackage(
      manager,
      {
        id: '00000000-0000-0000-0000-000000000000',
        contractId: contract.id,
        categoryId: dto.categoryId,
      },
      today(),
      'provisional',
    );
    const perSource = pricing.problems.find((problem) => problem.code === 'CATEGORY_PER_SOURCE');
    if (perSource) {
      throw new BadRequestException({
        code: PACKAGE_ERROR_CODES.CATEGORY_INVALID,
        message:
          'This product is paid per source: its projects go to the acceptance record without a package',
      });
    }
    return contract;
  }

  private async findVisible(manager: EntityManager, id: string, actor: PartnerActor, lock = false) {
    if (lock) {
      await manager.query(`SELECT id FROM product_packages WHERE id = $1 FOR UPDATE`, [id]);
    }
    const [row] = (await manager.query(`${SELECT_PACKAGE} WHERE package.id = $1`, [
      id,
    ])) as PackageRow[];
    if (!row || !this.canSee(row, actor)) {
      throw new NotFoundException({
        code: PACKAGE_ERROR_CODES.NOT_FOUND,
        message: 'Package not found',
      });
    }
    return row;
  }

  private isOwner(row: Pick<PackageRow, 'partnerGoUserId'>, actor: PartnerActor) {
    return row.partnerGoUserId === actor.userId;
  }

  private canSeeAllPrepared(actor: PartnerActor) {
    return (
      hasPermission(actor, GO_PERMISSIONS.PROJECT_EVALUATE) ||
      (hasPermission(actor, GO_PERMISSIONS.ACCEPTANCE_PREPARE) &&
        hasPermission(actor, GO_PERMISSIONS.CONTRACT_READ_ALL))
    );
  }

  private canPrepare(managerUserId: string, actor: PartnerActor) {
    return (
      hasPermission(actor, GO_PERMISSIONS.ACCEPTANCE_PREPARE) &&
      (managerUserId === actor.userId || hasPermission(actor, GO_PERMISSIONS.CONTRACT_READ_ALL))
    );
  }

  private canSee(row: PackageRow, actor: PartnerActor) {
    return (
      this.isOwner(row, actor) ||
      this.canPrepare(row.contractManagerUserId, actor) ||
      hasPermission(actor, GO_PERMISSIONS.PROJECT_EVALUATE)
    );
  }

  private canChange(row: PackageRow, actor: PartnerActor) {
    return this.isOwner(row, actor) || this.canPrepare(row.contractManagerUserId, actor);
  }

  private assertCanChange(row: PackageRow, actor: PartnerActor) {
    if (!this.canChange(row, actor)) {
      throw this.forbidden('Only the partner or the contract manager changes this package');
    }
  }

  private assertOpen(row: PackageRow) {
    if (row.status !== 'open') {
      throw new ConflictException({
        code: PACKAGE_ERROR_CODES.LOCKED,
        message: 'Projects change only while the package is open (withdraw it first)',
      });
    }
  }

  private assertNotHeld(row: PackageRow) {
    if (row.acceptanceId) {
      throw new ConflictException({
        code: PACKAGE_ERROR_CODES.LOCKED,
        message: 'The package is on an acceptance record; take it off the record first',
      });
    }
  }

  private assertTransition(row: PackageRow, action: PackageAction) {
    try {
      return nextPackageStatus(row.status, action);
    } catch (error) {
      if (error instanceof PackageTransitionError) {
        throw new ConflictException({
          code: PACKAGE_ERROR_CODES.INVALID_TRANSITION,
          message: error.message,
          details: { status: row.status, action },
        });
      }
      throw error;
    }
  }

  private allowedActions(row: PackageRow, actor: PartnerActor): PackageAllowedAction[] {
    const actions: PackageAllowedAction[] = [];
    const change = this.canChange(row, actor);
    for (const action of USER_PACKAGE_ACTIONS) {
      if (!canTransitionPackage(row.status, action)) continue;
      if (action === 'return') {
        if (hasPermission(actor, GO_PERMISSIONS.PROJECT_EVALUATE) && !row.acceptanceId) {
          actions.push(action);
        }
      } else if (change && !(action === 'reopen' && row.acceptanceId)) {
        actions.push(action);
      }
    }
    if (change && row.status === 'open') {
      actions.push('rename', 'add_project', 'remove_project');
    }
    return actions;
  }

  private toResponse(row: PackageRow, actor: PartnerActor): PackageResponse {
    const {
      partnerCode,
      partnerName,
      partnerGoUserId,
      contractNumber,
      contractStatus,
      contractManagerUserId,
      categoryName,
      ...rest
    } = row;
    return {
      ...rest,
      partner: {
        id: row.partnerId,
        code: partnerCode,
        displayName: partnerName,
        goUserId: partnerGoUserId,
      },
      contract: {
        id: row.contractId,
        contractNumber,
        status: contractStatus,
        managerUserId: contractManagerUserId,
      },
      category: { id: row.categoryId, name: categoryName },
      allowedActions: this.allowedActions(row, actor),
    };
  }

  private forbidden(message: string) {
    return new ForbiddenException({ code: PACKAGE_ERROR_CODES.FORBIDDEN, message });
  }

  private async audit(
    actor: PartnerActor,
    action: string,
    pkg: { id: string; code: string; contractId: string; partnerId: string },
    metadata: Record<string, unknown>,
  ) {
    await this.systemLog.write({
      level: 'info',
      category: PACKAGE_AUDIT_CATEGORY,
      action,
      message: `${action} ${pkg.code} (${pkg.id})`,
      requestId: actor.requestId ?? null,
      userId: actor.userId,
      metadata: {
        packageId: pkg.id,
        contractId: pkg.contractId,
        partnerId: pkg.partnerId,
        ...metadata,
      },
    });
  }
}
