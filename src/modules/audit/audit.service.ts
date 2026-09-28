import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ActorEnrichmentService } from '../../common/actor-enrichment.service';
import { ProjectAuditLogEntity } from '../../database/entities/project-audit-log.entity';
import { ProjectEntity } from '../../database/entities/project.entity';
import { FolderAccessService } from '../folders/folder-access.service';
import {
  addFileToUploadBatchSummary,
  MEDIA_UPLOADED_AUDIT_ACTION,
  type UploadedFile,
} from './media-upload-batch-summary';

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
    const fileNames = await this.findMediaFileNames(
      rows.map((row) => row.projectMediaId).filter((id): id is string => Boolean(id)),
    );
    const enriched = await this.actorEnrichment.enrich(
      rows.map((row) => ({
        ...row,
        // Entries written before file names were recorded only carry the media id.
        mediaFileName: (row.projectMediaId && fileNames.get(row.projectMediaId)) ?? null,
      })) as unknown as Array<Record<string, unknown>>,
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

  /** Current file name of each still-existing project media, keyed by media id. */
  private async findMediaFileNames(mediaIds: string[]): Promise<Map<string, string>> {
    if (mediaIds.length === 0) {
      return new Map();
    }
    const rows = (await this.auditRepository.manager.query(
      `SELECT media.id, asset.original_filename AS "fileName"
       FROM project_media media
       INNER JOIN assets asset ON asset.id = media.asset_id
       WHERE media.id = ANY($1::uuid[])`,
      [[...new Set(mediaIds)]],
    )) as Array<{ id: string; fileName: string }>;
    return new Map(rows.map((row) => [row.id, row.fileName]));
  }

  /**
   * Direct uploads are logged once per batch: the first completed file creates the entry and the
   * following ones update its counters. The advisory lock serialises files of the same batch that
   * finish at the same moment (uploads run in parallel), so none of them is lost or duplicated.
   */
  async recordMediaUpload(input: {
    projectId: string;
    actorUserId: string;
    uploadBatchId: string;
    file: UploadedFile;
  }) {
    await this.auditRepository.manager.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `media-upload:${input.uploadBatchId}`,
      ]);
      const existing = await manager
        .createQueryBuilder(ProjectAuditLogEntity, 'log')
        .where('log.project_id = :projectId', { projectId: input.projectId })
        .andWhere('log.action = :action', { action: MEDIA_UPLOADED_AUDIT_ACTION })
        .andWhere("log.metadata ->> 'uploadBatchId' = :uploadBatchId", {
          uploadBatchId: input.uploadBatchId,
        })
        .getOne();
      const summary = addFileToUploadBatchSummary(
        existing?.afterData,
        input.uploadBatchId,
        input.file,
        new Date(),
      );
      if (existing) {
        await manager.update(ProjectAuditLogEntity, existing.id, { afterData: summary });
        return;
      }
      await manager.save(
        manager.create(ProjectAuditLogEntity, {
          projectId: input.projectId,
          projectMediaId: null,
          actorUserId: input.actorUserId,
          action: MEDIA_UPLOADED_AUDIT_ACTION,
          beforeData: null,
          afterData: summary,
          metadata: { uploadBatchId: input.uploadBatchId, source: 'upload' },
        }),
      );
    });
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

  /** Bulk variant of `record`, saved in chunks so one query stays within Postgres' parameter limit. */
  async recordMany(inputs: Array<Parameters<AuditService['record']>[0]>) {
    if (inputs.length === 0) {
      return;
    }
    await this.auditRepository.save(
      inputs.map((input) =>
        this.auditRepository.create({
          projectId: input.projectId ?? null,
          projectMediaId: input.projectMediaId ?? null,
          actorUserId: input.actorUserId,
          action: input.action,
          beforeData: input.beforeData ?? null,
          afterData: input.afterData ?? null,
          metadata: input.metadata ?? {},
        }),
      ),
      { chunk: 500 },
    );
  }
}
