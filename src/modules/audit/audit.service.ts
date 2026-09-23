import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ActorEnrichmentService } from '../../common/actor-enrichment.service';
import { ProjectAuditLogEntity } from '../../database/entities/project-audit-log.entity';
import { ProjectEntity } from '../../database/entities/project.entity';
import { FolderAccessService } from '../folders/folder-access.service';

@Injectable()
export class AuditService {
  constructor(
    @InjectRepository(ProjectAuditLogEntity)
    private readonly auditRepository: Repository<ProjectAuditLogEntity>,
    @InjectRepository(ProjectEntity)
    private readonly projectRepository: Repository<ProjectEntity>,
    private readonly folderAccess: FolderAccessService,
    private readonly actorEnrichment: ActorEnrichmentService,
  ) {}

  async listProject(
    projectId: string,
    userId: string,
    userType?: 'ADMIN' | 'USER',
    page = 1,
    pageSize = 50,
  ) {
    const project = await this.projectRepository.findOne({ where: { id: projectId } });
    if (!project) {
      throw new NotFoundException('Project not found');
    }
    if (!(await this.folderAccess.canAccess(project.folderId, userId, 'viewer', userType))) {
      throw new ForbiddenException('Insufficient audit permission');
    }

    const [rows, total] = await this.auditRepository.findAndCount({
      where: { projectId },
      order: { createdAt: 'DESC' },
      skip: Math.max(0, page - 1) * pageSize,
      take: Math.min(Math.max(pageSize, 1), 100),
    });
    const enriched = await this.actorEnrichment.enrich(
      rows as unknown as Array<Record<string, unknown>>,
      [{ id: 'actorUserId', target: 'actorUser' }],
    );
    return {
      items: enriched,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async record(input: {
    projectId?: string | null;
    projectMediaId?: string | null;
    actorUserId: string;
    action: string;
    beforeData?: Record<string, unknown> | null;
    afterData?: Record<string, unknown> | null;
    metadata?: Record<string, unknown>;
  }) {
    return this.auditRepository.save(
      this.auditRepository.create({
        projectId: input.projectId ?? null,
        projectMediaId: input.projectMediaId ?? null,
        actorUserId: input.actorUserId,
        action: input.action,
        beforeData: input.beforeData ?? null,
        afterData: input.afterData ?? null,
        metadata: input.metadata ?? {},
      }),
    );
  }
}
