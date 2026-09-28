import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ActorEnrichmentService } from '../../common/actor-enrichment.service';
import { isAdminUserType } from '../../common/auth/user-type';
import { FolderAccessGrantEntity } from '../../database/entities/folder-access-grant.entity';
import { FolderEntity } from '../../database/entities/folder.entity';
import type { AccountUser } from '../account/account.types';
import { FolderAccessUsersQueryDto } from './dto/folder-access-users-query.dto';
import { FolderAccessLevel, FolderAccessService, maxAccessLevel } from './folder-access.service';

const levelRank: Record<FolderAccessLevel, number> = { viewer: 1, editor: 2, manager: 3 };

export type FolderAccessUserSummary = {
  userId: string;
  user: (Pick<AccountUser, 'id'> & { name?: unknown; email?: unknown; avatar?: unknown }) | null;
  folderCount: number;
  highestLevel: FolderAccessLevel;
  lastUpdatedAt: Date;
  folders: Array<{ id: string; name: string; pathText: string; accessLevel: FolderAccessLevel }>;
};

export type FolderAccessUsersPage = {
  data: FolderAccessUserSummary[];
  total: number;
  page: number;
  limit: number;
};

@Injectable()
export class FolderAccessOverviewService {
  constructor(
    @InjectRepository(FolderAccessGrantEntity)
    private readonly grantRepository: Repository<FolderAccessGrantEntity>,
    @InjectRepository(FolderEntity)
    private readonly folderRepository: Repository<FolderEntity>,
    private readonly accessService: FolderAccessService,
    private readonly actorEnrichment: ActorEnrichmentService,
  ) {}

  /** Users with direct grants on folders the requester manages (ADMIN: every active folder). */
  async users(
    query: FolderAccessUsersQueryDto,
    requesterId: string,
    requesterType?: 'ADMIN' | 'USER',
  ): Promise<FolderAccessUsersPage> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    let folderIds: string[] | undefined;
    if (!isAdminUserType(requesterType)) {
      const levels = await this.accessService.accessLevels(requesterId, requesterType);
      folderIds = [...levels].filter(([, level]) => level === 'manager').map(([id]) => id);
      if (folderIds.length === 0) {
        return { data: [], total: 0, page, limit };
      }
    }

    const folders = await this.folderRepository.find({
      where: folderIds ? { id: In(folderIds), isActive: true } : { isActive: true },
      select: { id: true, name: true, pathText: true },
    });
    if (folders.length === 0) {
      return { data: [], total: 0, page, limit };
    }
    const folderById = new Map(folders.map((folder) => [folder.id, folder]));
    const grants = await this.grantRepository.find({
      where: { principalType: 'user', folderId: In([...folderById.keys()]) },
    });

    const summaries = new Map<string, FolderAccessUserSummary>();
    for (const grant of grants) {
      const folder = folderById.get(grant.folderId);
      if (!folder) {
        continue;
      }
      const summary = summaries.get(grant.principalId) ?? {
        userId: grant.principalId,
        user: null,
        folderCount: 0,
        highestLevel: grant.accessLevel,
        lastUpdatedAt: grant.updatedAt,
        folders: [],
      };
      summary.folderCount += 1;
      summary.highestLevel = maxAccessLevel(summary.highestLevel, grant.accessLevel);
      if (grant.updatedAt > summary.lastUpdatedAt) {
        summary.lastUpdatedAt = grant.updatedAt;
      }
      summary.folders.push({
        id: folder.id,
        name: folder.name,
        pathText: folder.pathText,
        accessLevel: grant.accessLevel,
      });
      summaries.set(grant.principalId, summary);
    }

    let rows = (await this.actorEnrichment.enrich(
      [...summaries.values()] as unknown as Array<Record<string, unknown>>,
      [{ id: 'userId', target: 'user' }],
    )) as unknown as FolderAccessUserSummary[];

    const keyword = query.keyword?.trim().toLocaleLowerCase('vi-VN');
    if (keyword) {
      rows = rows.filter((row) =>
        [row.userId, userText(row.user?.name), userText(row.user?.email)].some((value) =>
          value.toLocaleLowerCase('vi-VN').includes(keyword),
        ),
      );
    }

    const direction = query.sortOrder === 'desc' ? -1 : 1;
    const sortBy = query.sortBy ?? 'user';
    rows.sort((a, b) => {
      const result =
        sortBy === 'folderCount'
          ? a.folderCount - b.folderCount
          : sortBy === 'highestLevel'
            ? levelRank[a.highestLevel] - levelRank[b.highestLevel]
            : sortBy === 'updatedAt'
              ? a.lastUpdatedAt.getTime() - b.lastUpdatedAt.getTime()
              : displayName(a).localeCompare(displayName(b), 'vi', { sensitivity: 'base' });
      return result * direction;
    });
    for (const row of rows) {
      row.folders.sort((a, b) => a.pathText.localeCompare(b.pathText, 'vi', { numeric: true }));
    }

    return {
      data: rows.slice((page - 1) * limit, page * limit),
      total: rows.length,
      page,
      limit,
    };
  }
}

function userText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function displayName(row: FolderAccessUserSummary): string {
  return userText(row.user?.name) || userText(row.user?.email) || row.userId;
}
