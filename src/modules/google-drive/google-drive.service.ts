import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import Redis from 'ioredis';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { ActorEnrichmentService } from '../../common/actor-enrichment.service';
import { isAdminUserType } from '../../common/auth/user-type';
import { AssetImportEntity } from '../../database/entities/asset-import.entity';
import { AssetEntity } from '../../database/entities/asset.entity';
import { GoogleDriveConnectionEntity } from '../../database/entities/google-drive-connection.entity';
import { ImportBatchEntity } from '../../database/entities/import-batch.entity';
import { ProjectMediaEntity } from '../../database/entities/project-media.entity';
import { ProjectEntity } from '../../database/entities/project.entity';
import { ImportQueueService } from '../../infra/queue/import-queue.service';
import { FolderAccessService } from '../folders/folder-access.service';
import { CreateImportDto } from './dto/create-import.dto';
import type { SummarizeSourceDto } from './dto/summarize-sources.dto';

type OAuthState = {
  verifier: string;
  userId: string;
  projectId?: string;
  returnUrl?: string;
};

type GoogleTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
};

type DriveSummaryFile = {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  fileExtension?: string;
  fullFileExtension?: string;
  modifiedTime?: string;
  headRevisionId?: string;
};

@Injectable()
export class GoogleDriveService implements OnModuleDestroy {
  private readonly logger = new Logger(GoogleDriveService.name);
  private stateStore?: Redis;

  constructor(
    private readonly config: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(GoogleDriveConnectionEntity)
    private readonly connectionRepository: Repository<GoogleDriveConnectionEntity>,
    @InjectRepository(ImportBatchEntity)
    private readonly batchRepository: Repository<ImportBatchEntity>,
    @InjectRepository(AssetImportEntity)
    private readonly itemRepository: Repository<AssetImportEntity>,
    @InjectRepository(ProjectEntity)
    private readonly projectRepository: Repository<ProjectEntity>,
    private readonly folderAccess: FolderAccessService,
    private readonly importQueue: ImportQueueService,
    private readonly actorEnrichment: ActorEnrichmentService,
  ) {}

  async getConnection(userId: string) {
    const connection = await this.connectionRepository.findOne({
      where: { externalUserId: userId },
      order: { updatedAt: 'DESC' },
    });
    if (!connection) {
      return null;
    }
    return {
      id: connection.id,
      googleSubject: connection.googleSubject,
      scopes: connection.scopes,
      status: connection.status,
      expiresAt: connection.expiresAt,
      revokedAt: connection.revokedAt,
      lastError: connection.lastError,
    };
  }

  async startConnection(userId: string, projectId?: string, returnUrl?: string) {
    const clientId = this.config.get<string>('GOOGLE_CLIENT_ID')?.trim();
    const redirectUri = this.config.get<string>('GOOGLE_REDIRECT_URI')?.trim();
    if (!clientId || !redirectUri) {
      throw new ServiceUnavailableException('Google Drive OAuth is not configured');
    }
    const normalizedReturnUrl = this.normalizeReturnUrl(returnUrl);
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    await this.getStateStore().set(
      this.stateKey(state),
      JSON.stringify({ verifier, userId, projectId, returnUrl: normalizedReturnUrl }),
      'EX',
      10 * 60,
      'NX',
    );
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      scope: this.getScopes().join(' '),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return {
      authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
      state,
    };
  }

  async completeConnection(code: string, state: string) {
    const stateStore = this.getStateStore();
    const storedValue = (await stateStore.eval(
      "local value = redis.call('GET', KEYS[1]); if value then redis.call('DEL', KEYS[1]); end; return value",
      1,
      this.stateKey(state),
    )) as string | null;
    if (!storedValue) {
      throw new BadRequestException('Invalid or expired Google OAuth state');
    }
    let stored: OAuthState;
    try {
      stored = JSON.parse(storedValue) as OAuthState;
    } catch {
      throw new BadRequestException('Invalid Google OAuth state');
    }
    const userId = stored.userId;
    const clientId = this.config.get<string>('GOOGLE_CLIENT_ID')?.trim();
    const clientSecret = this.config.get<string>('GOOGLE_CLIENT_SECRET')?.trim();
    const redirectUri = this.config.get<string>('GOOGLE_REDIRECT_URI')?.trim();
    if (!clientId || !clientSecret || !redirectUri) {
      throw new ServiceUnavailableException('Google Drive OAuth is not configured');
    }
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code_verifier: stored.verifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new BadRequestException('Google OAuth token exchange failed');
    }
    const tokens = (await response.json()) as GoogleTokenResponse;
    if (!tokens.access_token || !tokens.refresh_token) {
      throw new BadRequestException('Google OAuth did not return a refresh token');
    }
    const userInfo = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!userInfo.ok) {
      throw new BadRequestException('Google user info lookup failed');
    }
    const profile = (await userInfo.json()) as { sub?: string };
    if (!profile.sub) {
      throw new BadRequestException('Google user subject is missing');
    }
    const encryptedRefreshToken = this.encrypt(tokens.refresh_token);
    const scopes = (tokens.scope ?? this.getScopes().join(' ')).split(' ').filter(Boolean);
    const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null;
    const existingConnection = await this.connectionRepository.findOne({
      where: { externalUserId: userId, googleSubject: profile.sub },
    });
    const connection = await this.connectionRepository.save(
      existingConnection
        ? Object.assign(existingConnection, {
            encryptedRefreshToken,
            scopes,
            expiresAt,
            status: 'active' as const,
            lastError: null,
            revokedAt: null,
          })
        : this.connectionRepository.create({
            id: uuidv7(),
            externalUserId: userId,
            googleSubject: profile.sub,
            encryptedRefreshToken,
            scopes,
            expiresAt,
            status: 'active',
            lastError: null,
            revokedAt: null,
          }),
    );
    return {
      ...this.getSafeConnection(connection),
      projectId: stored.projectId,
      returnUrl: stored.returnUrl,
    };
  }

  async getPickerAccessToken(userId: string): Promise<{ accessToken: string; expiresAt: string }> {
    const connection = await this.connectionRepository.findOne({
      where: { externalUserId: userId, status: 'active' },
    });
    if (!connection) {
      throw new ConflictException('Google Drive is not connected');
    }
    const accessToken = await this.getDriveAccessToken(connection.id, userId);
    const expiresAt = new Date(Date.now() + 50 * 60 * 1000).toISOString();
    return { accessToken, expiresAt };
  }

  async disconnect(userId: string) {
    const connection = await this.connectionRepository.findOne({
      where: { externalUserId: userId, status: 'active' },
    });
    if (!connection) {
      return { success: true };
    }
    connection.status = 'revoked';
    connection.revokedAt = new Date();
    connection.encryptedRefreshToken = '';
    await this.connectionRepository.save(connection);
    return { success: true };
  }

  async summarizeSources(sources: SummarizeSourceDto[], projectId: string, userId: string) {
    const project = await this.projectRepository.findOne({ where: { id: projectId } });
    if (!project || !(await this.folderAccess.canAccess(project.folderId, userId, 'viewer'))) {
      throw new ForbiddenException('Insufficient project permission');
    }
    const connection = await this.connectionRepository.findOne({
      where: { externalUserId: userId, status: 'active' },
      order: { updatedAt: 'DESC' },
    });
    if (!connection) {
      throw new ConflictException('Google Drive is not connected');
    }
    const accessToken = await this.getDriveAccessToken(connection.id, userId);
    const discovered = new Map<string, DriveSummaryFile>();
    let folderCount = 0;
    const roots = [...new Map(sources.map((source) => [source.fileId, source])).values()].slice(
      0,
      100,
    );

    for (const source of roots) {
      const root = await this.getDriveFile(accessToken, source.fileId);
      if (root.mimeType === 'application/vnd.google-apps.folder') {
        folderCount += 1;
        await this.collectDriveFolder(accessToken, root.id, source.driveId ?? null, discovered);
      } else {
        discovered.set(root.id, root);
      }
    }

    let imageCount = 0;
    let videoCount = 0;
    let unsupportedCount = 0;
    let totalBytes = 0n;
    for (const file of discovered.values()) {
      if (file.mimeType.startsWith('image/')) {
        imageCount += 1;
        totalBytes += BigInt(file.size ?? 0);
      } else if (file.mimeType.startsWith('video/')) {
        videoCount += 1;
        totalBytes += BigInt(file.size ?? 0);
      } else {
        unsupportedCount += 1;
      }
    }
    const duplicates = await this.findProjectDuplicates(projectId, [...discovered.keys()]);
    return {
      imageCount,
      videoCount,
      fileCount: imageCount + videoCount,
      folderCount,
      unsupportedCount,
      totalBytes: totalBytes.toString(),
      duplicateCount: duplicates.length,
      duplicates,
    };
  }

  async createImport(dto: CreateImportDto, userId: string, userType?: 'ADMIN' | 'USER') {
    const project = await this.projectRepository.findOne({ where: { id: dto.projectId } });
    if (!project) {
      throw new NotFoundException('Project not found');
    }
    if (!(await this.folderAccess.canAccess(project.folderId, userId, 'editor', userType))) {
      throw new ForbiddenException('Insufficient project permission');
    }
    const connection = await this.connectionRepository.findOne({
      where: { externalUserId: userId, status: 'active' },
    });
    if (!connection) {
      throw new ConflictException('Google Drive is not connected');
    }
    const sources = (
      dto.sources?.length
        ? dto.sources
        : dto.sourceRootId
          ? [{ fileId: dto.sourceRootId, driveId: dto.sourceDriveId }]
          : []
    ).slice(0, 100);
    if (sources.length === 0) {
      throw new BadRequestException('At least one Google Drive source is required');
    }
    const key = dto.idempotencyKey?.trim().slice(0, 255) || null;
    if (key) {
      const existing = await this.batchRepository.findOne({
        where: { createdBy: userId, idempotencyKey: key },
      });
      if (existing) {
        if (existing.status === 'queued' && !existing.queueJobId) {
          const queueJobId = await this.importQueue.addJob({ batchId: existing.id, userId });
          await this.batchRepository.update(existing.id, { queueJobId });
          existing.queueJobId = queueJobId;
        }
        return existing;
      }
    }
    const batch = await this.dataSource.transaction(async (manager) => {
      const batch = await manager.save(
        manager.create(ImportBatchEntity, {
          id: uuidv7(),
          projectId: dto.projectId,
          connectionId: connection.id,
          sourceType: 'google_drive',
          sourceDriveId: dto.sourceDriveId ?? null,
          sourceRootId: dto.sourceRootId,
          duplicatePolicy: dto.duplicatePolicy ?? 'reuse_existing',
          status: 'queued',
          totalItems: 0,
          completedItems: 0,
          failedItems: 0,
          progressPercent: 0,
          queueJobId: null,
          idempotencyKey: key,
          errorMessage: null,
          createdBy: userId,
        }),
      );
      await manager.insert(
        AssetImportEntity,
        sources.map((source) => ({
          id: uuidv7(),
          batchId: batch.id,
          projectId: dto.projectId,
          assetId: null,
          connectionId: connection.id,
          sourceType: 'google_drive' as const,
          sourceDriveId: source.driveId ?? dto.sourceDriveId ?? null,
          sourceFileId: source.fileId,
          sourceRevisionId: null,
          sourceName: source.name ?? source.fileId,
          sourceMimeType: source.mimeType ?? null,
          sourceSizeBytes: null,
          resolution: null,
          status: 'queued' as const,
          attemptCount: 0,
          errorCode: null,
          errorMessage: null,
          queueJobId: null,
          startedAt: null,
          finishedAt: null,
        })),
      );
      return batch;
    });
    const queueJobId = await this.importQueue.addJob({ batchId: batch.id, userId });
    await this.batchRepository.update(batch.id, { queueJobId });
    return batch;
  }

  async getDriveAccessToken(connectionId: string, userId: string): Promise<string> {
    const connection = await this.connectionRepository.findOne({
      where: { id: connectionId, externalUserId: userId, status: 'active' },
    });
    if (!connection) {
      throw new NotFoundException('Google Drive connection not found');
    }
    const clientId = this.config.get<string>('GOOGLE_CLIENT_ID')?.trim();
    const clientSecret = this.config.get<string>('GOOGLE_CLIENT_SECRET')?.trim();
    if (!clientId || !clientSecret) {
      throw new ServiceUnavailableException('Google Drive OAuth is not configured');
    }
    try {
      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: this.decrypt(connection.encryptedRefreshToken),
          grant_type: 'refresh_token',
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new Error(`Google token refresh failed with ${response.status}`);
      }
      const tokens = (await response.json()) as GoogleTokenResponse;
      if (!tokens.access_token) {
        throw new Error('Google token refresh did not return an access token');
      }
      await this.connectionRepository.update(connection.id, {
        expiresAt: tokens.expires_in
          ? new Date(Date.now() + tokens.expires_in * 1000)
          : connection.expiresAt,
        lastError: null,
      });
      return tokens.access_token;
    } catch (error) {
      await this.connectionRepository.update(connection.id, {
        status: 'error',
        lastError: error instanceof Error ? error.message.slice(0, 4000) : 'Token refresh failed',
      });
      throw error;
    }
  }

  async getImport(id: string, userId: string, userType?: 'ADMIN' | 'USER') {
    const batch = await this.batchRepository.findOne({
      where: isAdminUserType(userType) ? { id } : { id, createdBy: userId },
    });
    if (!batch) {
      throw new NotFoundException('Import batch not found');
    }
    const items = await this.itemRepository.find({
      where: { batchId: id },
      order: { createdAt: 'ASC' },
    });
    const [enrichedBatch] = await this.actorEnrichment.enrich(
      [batch as unknown as Record<string, unknown>],
      [{ id: 'createdBy', target: 'createdByUser' }],
    );
    return { ...enrichedBatch, items };
  }

  async listImports(projectId: string, userId: string, userType?: 'ADMIN' | 'USER') {
    const project = await this.projectRepository.findOne({ where: { id: projectId } });
    if (
      !project ||
      !(await this.folderAccess.canAccess(project.folderId, userId, 'viewer', userType))
    ) {
      throw new ForbiddenException('Insufficient project permission');
    }
    const batches = await this.batchRepository.find({
      where: { projectId },
      order: { createdAt: 'DESC' },
      take: 50,
    });
    if (!batches.length) {
      return [];
    }
    const stats = await this.itemRepository
      .createQueryBuilder('item')
      .select('item.batch_id', 'batchId')
      .addSelect('COUNT(*)', 'fileCount')
      .addSelect("COUNT(*) FILTER (WHERE item.source_mime_type LIKE 'image/%')", 'imageCount')
      .addSelect("COUNT(*) FILTER (WHERE item.source_mime_type LIKE 'video/%')", 'videoCount')
      .addSelect('COALESCE(SUM(item.source_size_bytes), 0)', 'totalBytes')
      .addSelect(
        "COALESCE(SUM(item.source_size_bytes) FILTER (WHERE item.status = 'completed'), 0)",
        'importedBytes',
      )
      .addSelect("COUNT(*) FILTER (WHERE item.resolution = 'reused')", 'reusedCount')
      .addSelect('MAX(item.finished_at)', 'finishedAt')
      .where('item.batch_id IN (:...batchIds)', { batchIds: batches.map((batch) => batch.id) })
      .andWhere("COALESCE(item.source_mime_type, '') NOT IN ('application/vnd.google-apps.folder')")
      .groupBy('item.batch_id')
      .getRawMany<{
        batchId: string;
        fileCount: string;
        imageCount: string;
        videoCount: string;
        totalBytes: string;
        importedBytes: string;
        reusedCount: string;
        finishedAt: Date | null;
      }>();
    const statsByBatch = new Map(stats.map((row) => [row.batchId, row]));
    const enriched = await this.actorEnrichment.enrich(
      batches as unknown as Record<string, unknown>[],
      [{ id: 'createdBy', target: 'createdByUser' }],
    );
    return enriched.map((batch) => {
      const row = statsByBatch.get(batch.id as string);
      const finished = ['completed', 'partial', 'failed', 'cancelled'].includes(
        batch.status as string,
      );
      return {
        ...batch,
        fileCount: Number(row?.fileCount ?? 0),
        imageCount: Number(row?.imageCount ?? 0),
        videoCount: Number(row?.videoCount ?? 0),
        totalBytes: String(row?.totalBytes ?? 0),
        importedBytes: String(row?.importedBytes ?? 0),
        reusedCount: Number(row?.reusedCount ?? 0),
        finishedAt: finished ? (row?.finishedAt ?? batch.updatedAt) : null,
      };
    });
  }

  async listItems(id: string, userId: string, userType?: 'ADMIN' | 'USER') {
    await this.assertBatchOwner(id, userId, userType);
    return this.itemRepository.find({
      where: { batchId: id },
      order: { createdAt: 'ASC' },
    });
  }

  async cancelImport(id: string, userId: string, userType?: 'ADMIN' | 'USER') {
    const batch = await this.assertBatchOwner(id, userId, userType);
    if (!['completed', 'failed', 'cancelled'].includes(batch.status)) {
      await this.batchRepository.update(id, { status: 'cancelled' });
      await this.itemRepository.update({ batchId: id, status: 'queued' }, { status: 'cancelled' });
    }
    return this.batchRepository.findOneOrFail({ where: { id } });
  }

  async retryItem(id: string, itemId: string, userId: string, userType?: 'ADMIN' | 'USER') {
    const batch = await this.assertBatchOwner(id, userId, userType);
    const item = await this.itemRepository.findOne({ where: { id: itemId, batchId: id } });
    if (!item) {
      throw new NotFoundException('Import item not found');
    }
    item.status = 'queued';
    item.resolution = null;
    item.errorCode = null;
    item.errorMessage = null;
    await this.itemRepository.save(item);
    await this.batchRepository.update(id, { status: 'processing' });
    const queueJobId = await this.importQueue.addJob({ batchId: batch.id, userId });
    await this.batchRepository.update(id, { queueJobId });
    return item;
  }

  private async findProjectDuplicates(projectId: string, fileIds: string[]) {
    if (fileIds.length === 0) {
      return [];
    }
    const rows = await this.dataSource
      .createQueryBuilder()
      .select('asset.google_drive_file_id', 'fileId')
      .addSelect('asset.id', 'assetId')
      .addSelect('media.id', 'projectMediaId')
      .addSelect('asset.original_filename', 'name')
      .addSelect('media.created_at', 'createdAt')
      .from(ProjectMediaEntity, 'media')
      .innerJoin(AssetEntity, 'asset', 'asset.id = media.asset_id')
      .where('media.project_id = :projectId', { projectId })
      .andWhere('asset.google_drive_file_id IN (:...fileIds)', { fileIds })
      .orderBy('media.created_at', 'DESC')
      .getRawMany<{
        fileId: string;
        assetId: string;
        projectMediaId: string;
        name: string;
        createdAt: Date;
      }>();
    const seen = new Set<string>();
    return rows
      .filter((row) => {
        if (seen.has(row.fileId)) {
          return false;
        }
        seen.add(row.fileId);
        return true;
      })
      .map((row) => ({
        fileId: row.fileId,
        name: row.name,
        existingAssetId: row.assetId,
        existingProjectMediaId: row.projectMediaId,
        createdAt: row.createdAt,
      }));
  }

  private async assertBatchOwner(id: string, userId: string, userType?: 'ADMIN' | 'USER') {
    const batch = await this.batchRepository.findOne({
      where: isAdminUserType(userType) ? { id } : { id, createdBy: userId },
    });
    if (!batch) {
      throw new NotFoundException('Import batch not found');
    }
    return batch;
  }

  private getScopes(): string[] {
    const scopes = (
      this.config.get<string>('GOOGLE_SCOPES') ??
      'openid profile email https://www.googleapis.com/auth/drive.readonly'
    )
      .split(/[,\s]+/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (!scopes.includes('https://www.googleapis.com/auth/drive.readonly')) {
      scopes.push('https://www.googleapis.com/auth/drive.readonly');
    }
    return [...new Set(scopes)];
  }

  private async getDriveFile(accessToken: string, fileId: string): Promise<DriveSummaryFile> {
    const params = new URLSearchParams({
      fields: 'id,name,mimeType,size,fileExtension,fullFileExtension,modifiedTime,headRevisionId',
      supportsAllDrives: 'true',
    });
    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${params.toString()}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      throw new BadRequestException(`Google Drive file lookup failed with ${response.status}`);
    }
    const payload = (await response.json()) as DriveSummaryFile;
    this.logger.log(
      `[Google Drive API] file metadata: ${JSON.stringify({
        fileId,
        id: payload.id,
        name: payload.name,
        mimeType: payload.mimeType,
        size: payload.size,
        fileExtension: payload.fileExtension,
        fullFileExtension: payload.fullFileExtension,
        modifiedTime: payload.modifiedTime,
        headRevisionId: payload.headRevisionId,
      })}`,
    );
    return payload;
  }

  private async collectDriveFolder(
    accessToken: string,
    rootId: string,
    driveId: string | null,
    discovered: Map<string, DriveSummaryFile>,
  ): Promise<void> {
    const pending = [rootId];
    const maxFiles = 10_000;
    while (pending.length > 0) {
      const parentId = pending.shift();
      if (!parentId) {
        continue;
      }
      let pageToken: string | undefined;
      do {
        const params = new URLSearchParams({
          q: `'${parentId.replaceAll("'", "\\'")}' in parents and trashed = false`,
          fields:
            'nextPageToken,files(id,name,mimeType,size,fileExtension,fullFileExtension,modifiedTime)',
          pageSize: '1000',
          includeItemsFromAllDrives: 'true',
          supportsAllDrives: 'true',
        });
        if (driveId) {
          params.set('corpora', 'drive');
          params.set('driveId', driveId);
        }
        if (pageToken) {
          params.set('pageToken', pageToken);
        }
        const response = await fetch(
          `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
            signal: AbortSignal.timeout(30_000),
          },
        );
        if (!response.ok) {
          throw new BadRequestException(
            `Google Drive folder lookup failed with ${response.status}`,
          );
        }
        const page = (await response.json()) as {
          nextPageToken?: string;
          files?: DriveSummaryFile[];
        };
        this.logger.log(
          `[Google Drive API] folder page: ${JSON.stringify({
            parentId,
            driveId,
            fileCount: page.files?.length ?? 0,
            files: (page.files ?? []).map((file) => ({
              id: file.id,
              name: file.name,
              mimeType: file.mimeType,
              size: file.size,
              fileExtension: file.fileExtension,
              fullFileExtension: file.fullFileExtension,
              modifiedTime: file.modifiedTime,
            })),
          })}`,
        );
        for (const file of page.files ?? []) {
          if (file.mimeType === 'application/vnd.google-apps.folder') {
            pending.push(file.id);
          } else {
            discovered.set(file.id, file);
          }
          if (discovered.size > maxFiles) {
            throw new BadRequestException(`Google Drive folder exceeds the ${maxFiles} file limit`);
          }
        }
        pageToken = page.nextPageToken;
      } while (pageToken);
    }
  }

  private normalizeReturnUrl(value?: string): string | undefined {
    if (!value?.trim()) {
      return undefined;
    }
    try {
      const frontendOrigin =
        this.config.get<string>('FRONTEND_ORIGIN')?.trim() || 'http://localhost:5173';
      const parsed = new URL(value, frontendOrigin);
      if (
        parsed.origin !== frontendOrigin ||
        !parsed.pathname.startsWith('/') ||
        parsed.pathname.startsWith('//')
      ) {
        throw new Error('Invalid frontend return URL');
      }
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      throw new BadRequestException('Invalid frontend return URL');
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.stateStore?.quit();
  }

  private getStateStore(): Redis {
    if (!this.stateStore) {
      this.stateStore = new Redis(this.config.getOrThrow<string>('REDIS_URL'), {
        maxRetriesPerRequest: null,
      });
    }
    return this.stateStore;
  }

  private stateKey(state: string): string {
    return `${this.config.getOrThrow<string>('QUEUE_PREFIX')}:google-oauth-state:${state}`;
  }

  private encrypt(value: string): string {
    const key = this.getEncryptionKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString(
      'base64url',
    )}`;
  }

  private decrypt(value: string): string {
    const [ivPart, tagPart, encryptedPart] = value.split('.');
    if (!ivPart || !tagPart || !encryptedPart) {
      throw new Error('Invalid encrypted token');
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.getEncryptionKey(),
      Buffer.from(ivPart, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  private getEncryptionKey(): Buffer {
    const raw = this.config.get<string>('GOOGLE_TOKEN_ENCRYPTION_KEY')?.trim();
    if (!raw) {
      throw new ServiceUnavailableException('Google token encryption is not configured');
    }
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) {
      throw new ServiceUnavailableException('Google token encryption key must be 32 bytes');
    }
    return key;
  }

  private getSafeConnection(connection: GoogleDriveConnectionEntity) {
    return {
      id: connection.id,
      googleSubject: connection.googleSubject,
      scopes: connection.scopes,
      status: connection.status,
      expiresAt: connection.expiresAt,
      revokedAt: connection.revokedAt,
    };
  }
}
