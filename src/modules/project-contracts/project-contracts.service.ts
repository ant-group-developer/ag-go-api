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
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { ListResponseDto } from '../../common/dto/list-response.dto';
import { ProjectEntity } from '../../database/entities/project.entity';
import { AuditService } from '../audit/audit.service';
import { ContractsService } from '../contracts/contracts.service';
import { FolderAccessService } from '../folders/folder-access.service';
import { hasPermission, type PartnerActor } from '../partners/partner-actor';
import { PartnersService } from '../partners/partners.service';
import type { ContractSummary } from './contract-summaries';
import type {
  ListContractProjectsQueryDto,
  ListPartnerProjectsQueryDto,
  UpdateProjectContractDto,
} from './dto/project-contract.dto';
import { ProjectContractsOutboxService } from './project-contracts-outbox.service';
import { contractDay, contractsInForce } from './project-delivery';
import type { SpecLevel } from './spec-check';
import { SpecChecksService } from './spec-checks.service';

export const PROJECT_CONTRACT_ERROR_CODES = {
  PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND',
  PROJECT_FORBIDDEN: 'PROJECT_FORBIDDEN',
  CONTRACT_NOT_ACTIVE: 'CONTRACT_NOT_ACTIVE',
  CONTRACT_OTHER_PARTNER: 'CONTRACT_OTHER_PARTNER',
  DELIVERED_AT_INVALID: 'PROJECT_DELIVERED_AT_INVALID',
  CONTRACT_MANAGE_REQUIRED: 'CONTRACT_MANAGE_REQUIRED',
} as const;

export type ProjectContractLink = {
  projectId: string;
  ownerUserId: string;
  contractId: string | null;
  contract: ContractSummary | null;
  /** The owner's partner record, null when the owner is not a partner. */
  partner: { id: string; code: string; displayName: string; status: string } | null;
  deliveredAt: Date | null;
  acceptedOutsideAt: Date | null;
  acceptedOutsideNote: string | null;
  /** Day the candidates are in force on: the delivery day, or today before delivery. */
  candidateDay: string;
  /** Active contracts of the owner in force that day (several: the manager chooses, FR-P-09). */
  candidates: ContractSummary[];
};

export type ProjectContractItem = Pick<
  ProjectEntity,
  | 'id'
  | 'name'
  | 'ownerUserId'
  | 'folderId'
  | 'categoryId'
  | 'evaluationStatus'
  | 'mediaCount'
  | 'videoCount'
  | 'contractId'
  | 'deliveredAt'
  | 'acceptedOutsideAt'
> & {
  contract: ContractSummary | null;
  /** Stored check results of its videos still in play (rejected ones left out). */
  specChecks: Record<SpecLevel, number> | null;
};

/**
 * Project ↔ contract links (FR-C-08, FR-P-09, spec 7.4 and 15.3) and the technical checks shown on
 * the evaluation screen (FR-T-02, FR-T-03). Evaluation itself is unchanged: the results are
 * suggestions next to `project_media.evaluation_status`.
 */
@Injectable()
export class ProjectContractsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly specChecks: SpecChecksService,
    private readonly outbox: ProjectContractsOutboxService,
    private readonly contracts: ContractsService,
    private readonly partners: PartnersService,
    private readonly folderAccess: FolderAccessService,
    private readonly audit: AuditService,
  ) {}

  async getLink(projectId: string, actor: PartnerActor): Promise<ProjectContractLink> {
    const project = await this.viewableProject(projectId, actor);
    return this.link(this.dataSource.manager, project);
  }

  /**
   * Links / unlinks the contract, corrects the delivery time or marks the project accepted outside
   * AG Go. A new link queues the analyses its videos miss (FR-T-01); the checks are then run.
   */
  async update(projectId: string, dto: UpdateProjectContractDto, actor: PartnerActor) {
    if (
      (dto.deliveredAt !== undefined ||
        dto.acceptedOutside !== undefined ||
        dto.acceptedOutsideNote !== undefined) &&
      !hasPermission(actor, GO_PERMISSIONS.CONTRACT_MANAGE)
    ) {
      throw new ForbiddenException({
        code: PROJECT_CONTRACT_ERROR_CODES.CONTRACT_MANAGE_REQUIRED,
        message: 'Changing the delivery time or the outside acceptance needs go.contract.manage',
      });
    }
    const deliveredAt = dto.deliveredAt === undefined ? undefined : new Date(dto.deliveredAt);
    if (deliveredAt && deliveredAt.getTime() > Date.now()) {
      throw new BadRequestException({
        code: PROJECT_CONTRACT_ERROR_CODES.DELIVERED_AT_INVALID,
        message: 'deliveredAt must not be in the future',
      });
    }
    await this.viewableProject(projectId, actor);

    const changes = await this.dataSource.transaction(async (manager) => {
      const project = await manager.findOne(ProjectEntity, {
        where: { id: projectId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!project) {
        throw this.projectNotFound();
      }
      const before = {
        contractId: project.contractId,
        deliveredAt: project.deliveredAt,
        acceptedOutsideAt: project.acceptedOutsideAt,
        acceptedOutsideNote: project.acceptedOutsideNote,
      };
      let contractNumber: string | null = null;
      if (dto.contractId !== undefined && dto.contractId !== project.contractId) {
        // Moving a project off a contract needs to see that contract too.
        if (project.contractId) {
          await this.contracts.findVisible(project.contractId, actor);
        }
        if (dto.contractId !== null) {
          contractNumber = await this.assertLinkable(manager, project, dto.contractId, actor);
        }
        project.contractId = dto.contractId;
      }
      if (deliveredAt) {
        project.deliveredAt = deliveredAt;
      }
      if (dto.acceptedOutside === true) {
        project.acceptedOutsideAt = project.acceptedOutsideAt ?? new Date();
      } else if (dto.acceptedOutside === false) {
        project.acceptedOutsideAt = null;
        project.acceptedOutsideNote = null;
      }
      if (dto.acceptedOutsideNote !== undefined && project.acceptedOutsideAt) {
        project.acceptedOutsideNote = dto.acceptedOutsideNote?.trim() || null;
      }
      await manager.update(ProjectEntity, projectId, {
        contractId: project.contractId,
        deliveredAt: project.deliveredAt,
        acceptedOutsideAt: project.acceptedOutsideAt,
        acceptedOutsideNote: project.acceptedOutsideNote,
      });
      const linked = project.contractId !== null && project.contractId !== before.contractId;
      const queued =
        linked && !project.acceptedOutsideAt
          ? await this.outbox.enqueueMissingAnalyses(manager, projectId, actor.userId)
          : 0;
      return { before, project, contractNumber, queued };
    });

    await this.recordAudit(changes.before, changes.project, changes.contractNumber, actor, {
      queuedAnalyses: changes.queued,
    });
    const specChecks = await this.specChecks.refreshProject(projectId);
    return {
      ...(await this.link(this.dataSource.manager, changes.project)),
      queuedAnalyses: changes.queued,
      specChecks,
    };
  }

  /** Results of the project's checks, the stale ones run again first. */
  async getSpecChecks(projectId: string, actor: PartnerActor) {
    await this.viewableProject(projectId, actor);
    return this.specChecks.refreshProject(projectId);
  }

  /** Queues the missing analyses, then checks every video again (FR-T-05). */
  async recheck(projectId: string, actor: PartnerActor) {
    const project = await this.viewableProject(projectId, actor);
    let queued = 0;
    if (project.contractId && !project.acceptedOutsideAt) {
      queued = await this.dataSource.transaction((manager) =>
        this.outbox.enqueueMissingAnalyses(manager, projectId, actor.userId),
      );
    }
    const specChecks = await this.specChecks.refreshProject(projectId, { force: true });
    if (!specChecks) {
      throw this.projectNotFound();
    }
    return { queuedAnalyses: queued, ...specChecks };
  }

  /** Projects of a partner (owned by its AG Go user), to link the unlinked ones. */
  async listPartnerProjects(
    partnerId: string,
    query: ListPartnerProjectsQueryDto,
    actor: PartnerActor,
  ) {
    const partner = await this.partners.findVisible(partnerId, actor);
    const conditions = ['project.owner_user_id = $1'];
    if (query.link === 'linked') {
      conditions.push('project.contract_id IS NOT NULL');
    } else if (query.link === 'unlinked') {
      conditions.push('project.contract_id IS NULL');
    }
    if (query.delivered === 'true') {
      conditions.push('project.delivered_at IS NOT NULL');
    } else if (query.delivered === 'false') {
      conditions.push('project.delivered_at IS NULL');
    }
    return this.projectPage(conditions.join(' AND '), [partner.goUserId], query);
  }

  /** Projects delivered under a contract. */
  async listContractProjects(
    contractId: string,
    query: ListContractProjectsQueryDto,
    actor: PartnerActor,
  ) {
    await this.contracts.findVisible(contractId, actor);
    return this.projectPage('project.contract_id = $1', [contractId], query);
  }

  private async projectPage(
    where: string,
    params: unknown[],
    query: { page: number; pageSize: number; skip: number },
  ) {
    const [{ total }] = (await this.dataSource.query(
      `SELECT count(*)::int AS total FROM projects project WHERE ${where}`,
      params,
    )) as Array<{ total: number }>;
    const rows = (await this.dataSource.query(
      `SELECT project.id, project.name, project.owner_user_id AS "ownerUserId",
              project.folder_id AS "folderId", project.category_id AS "categoryId",
              project.evaluation_status AS "evaluationStatus", project.media_count AS "mediaCount",
              project.video_count AS "videoCount", project.contract_id AS "contractId",
              project.delivered_at AS "deliveredAt", project.accepted_outside_at AS "acceptedOutsideAt"
       FROM projects project
       WHERE ${where}
       ORDER BY project.delivered_at DESC NULLS LAST, project.created_at DESC, project.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, query.pageSize, query.skip],
    )) as Array<Omit<ProjectContractItem, 'contract' | 'specChecks'>>;
    const contracts = await this.specChecks.contractSummaries(
      this.dataSource.manager,
      rows.flatMap((row) => (row.contractId ? [row.contractId] : [])),
    );
    const counts = await this.specChecks.countsForProjects(rows.map((row) => row.id));
    const items: ProjectContractItem[] = rows.map((row) => ({
      ...row,
      contract: row.contractId ? (contracts.get(row.contractId) ?? null) : null,
      specChecks: row.contractId ? (counts.get(row.id) ?? null) : null,
    }));
    return new ListResponseDto(items, query.page, query.pageSize, Number(total));
  }

  /** The contract id is visible, active and the owner's (FR-C-08); returns its number. */
  private async assertLinkable(
    manager: EntityManager,
    project: ProjectEntity,
    contractId: string,
    actor: PartnerActor,
  ): Promise<string> {
    const contract = await this.contracts.findVisible(contractId, actor);
    if (contract.status !== 'active') {
      throw new ConflictException({
        code: PROJECT_CONTRACT_ERROR_CODES.CONTRACT_NOT_ACTIVE,
        message: 'Only an active contract takes projects',
        details: { status: contract.status },
      });
    }
    const [owner] = (await manager.query(
      `SELECT go_user_id AS "goUserId" FROM partners WHERE id = $1`,
      [contract.partnerId],
    )) as Array<{ goUserId: string }>;
    if (owner?.goUserId !== project.ownerUserId) {
      throw new UnprocessableEntityException({
        code: PROJECT_CONTRACT_ERROR_CODES.CONTRACT_OTHER_PARTNER,
        message: "The contract is not with the project's owner",
      });
    }
    return contract.contractNumber;
  }

  private async link(
    manager: EntityManager,
    project: Pick<
      ProjectEntity,
      | 'id'
      | 'ownerUserId'
      | 'contractId'
      | 'deliveredAt'
      | 'acceptedOutsideAt'
      | 'acceptedOutsideNote'
    >,
  ): Promise<ProjectContractLink> {
    const [partner] = (await manager.query(
      `SELECT id, code, display_name AS "displayName", status FROM partners WHERE go_user_id = $1`,
      [project.ownerUserId],
    )) as Array<ProjectContractLink['partner'] & object>;
    const candidateDay = contractDay(project.deliveredAt ?? new Date());
    const inForce = partner
      ? await contractsInForce(manager, project.ownerUserId, candidateDay)
      : [];
    const summaries = await this.specChecks.contractSummaries(manager, [
      ...inForce.map((contract) => contract.id),
      ...(project.contractId ? [project.contractId] : []),
    ]);
    return {
      projectId: project.id,
      ownerUserId: project.ownerUserId,
      contractId: project.contractId,
      contract: project.contractId ? (summaries.get(project.contractId) ?? null) : null,
      partner: partner ?? null,
      deliveredAt: project.deliveredAt,
      acceptedOutsideAt: project.acceptedOutsideAt,
      acceptedOutsideNote: project.acceptedOutsideNote,
      candidateDay,
      candidates: inForce.flatMap((contract) => {
        const summary = summaries.get(contract.id);
        return summary ? [summary] : [];
      }),
    };
  }

  private async viewableProject(projectId: string, actor: PartnerActor): Promise<ProjectEntity> {
    const project = await this.dataSource
      .getRepository(ProjectEntity)
      .findOne({ where: { id: projectId } });
    if (!project) {
      throw this.projectNotFound();
    }
    const allowed = await this.folderAccess.canViewProject(
      project,
      actor.userId,
      actor.userType,
      undefined,
      actor.permissions,
    );
    if (!allowed) {
      throw new ForbiddenException({
        code: PROJECT_CONTRACT_ERROR_CODES.PROJECT_FORBIDDEN,
        message: 'Insufficient project permission',
      });
    }
    return project;
  }

  private projectNotFound() {
    return new NotFoundException({
      code: PROJECT_CONTRACT_ERROR_CODES.PROJECT_NOT_FOUND,
      message: 'Project not found',
    });
  }

  private async recordAudit(
    before: Pick<
      ProjectEntity,
      'contractId' | 'deliveredAt' | 'acceptedOutsideAt' | 'acceptedOutsideNote'
    >,
    after: ProjectEntity,
    contractNumber: string | null,
    actor: PartnerActor,
    metadata: Record<string, unknown>,
  ) {
    const entries: Array<Parameters<AuditService['record']>[0]> = [];
    if (before.contractId !== after.contractId) {
      entries.push({
        projectId: after.id,
        actorUserId: actor.userId,
        action: after.contractId ? 'contract_linked' : 'contract_unlinked',
        beforeData: { contractId: before.contractId },
        afterData: { contractId: after.contractId, contractNumber },
        metadata: { source: 'manual', ...metadata },
      });
    }
    if (before.deliveredAt?.getTime() !== after.deliveredAt?.getTime()) {
      entries.push({
        projectId: after.id,
        actorUserId: actor.userId,
        action: 'delivery_changed',
        beforeData: { deliveredAt: before.deliveredAt?.toISOString() ?? null },
        afterData: { deliveredAt: after.deliveredAt?.toISOString() ?? null },
      });
    }
    if (
      (before.acceptedOutsideAt === null) !== (after.acceptedOutsideAt === null) ||
      before.acceptedOutsideNote !== after.acceptedOutsideNote
    ) {
      entries.push({
        projectId: after.id,
        actorUserId: actor.userId,
        action: 'accepted_outside_changed',
        beforeData: {
          acceptedOutsideAt: before.acceptedOutsideAt?.toISOString() ?? null,
          note: before.acceptedOutsideNote,
        },
        afterData: {
          acceptedOutsideAt: after.acceptedOutsideAt?.toISOString() ?? null,
          note: after.acceptedOutsideNote,
        },
      });
    }
    await this.audit.recordMany(entries);
  }
}
