import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
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
import { GoogleDriveConnectionEntity } from '../../database/entities/google-drive-connection.entity';
import { ImportBatchEntity } from '../../database/entities/import-batch.entity';
import { ProjectEntity } from '../../database/entities/project.entity';
import { ImportQueueService } from '../../infra/queue/import-queue.service';
import { FolderAccessService } from '../folders/folder-access.service';
import { CreateImportDto } from './dto/create-import.dto';

type OAuthState = {
  verifier: string;
  userId: string;
  projectId?: string;
};

type GoogleTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
};

@Injectable()
export class GoogleDriveService implements OnModuleDestroy {
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

  async startConnection(userId: string, projectId?: string) {
    const clientId = this.config.get<string>('GOOGLE_CLIENT_ID')?.trim();
    const redirectUri = this.config.get<string>('GOOGLE_REDIRECT_URI')?.trim();
    if (!clientId || !redirectUri) {
      throw new ServiceUnavailableException('Google Drive OAuth is not configured');
    }
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    await this.getStateStore().set(
      this.stateKey(state),
      JSON.stringify({ verifier, userId, projectId }),
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
    const connection = await this.connectionRepository.save(
      this.connectionRepository.create({
        id: uuidv7(),
        externalUserId: userId,
        googleSubject: profile.sub,
        encryptedRefreshToken,
        scopes: (tokens.scope ?? this.getScopes().join(' ')).split(' ').filter(Boolean),
        expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null,
        status: 'active',
        lastError: null,
        revokedAt: null,
      }),
    );
    return { ...this.getSafeConnection(connection), projectId: stored.projectId };
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
    const sources = (dto.sources?.length
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
    await this.importQueue.addJob({ batchId: batch.id, userId });
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
    item.errorCode = null;
    item.errorMessage = null;
    item.attemptCount += 1;
    await this.itemRepository.save(item);
    await this.batchRepository.update(id, { status: 'processing' });
    await this.importQueue.addJob({ batchId: batch.id, userId });
    return item;
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
    return (
      this.config.get<string>('GOOGLE_SCOPES') ??
      'openid profile email https://www.googleapis.com/auth/drive.readonly'
    )
      .split(/[,\s]+/)
      .map((value) => value.trim())
      .filter(Boolean);
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
