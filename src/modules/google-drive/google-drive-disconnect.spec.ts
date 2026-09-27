import type { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import type { DataSource, Repository } from 'typeorm';
import type { ActorEnrichmentService } from '../../common/actor-enrichment.service';
import type { GoogleDriveConnectionEntity } from '../../database/entities/google-drive-connection.entity';
import type { ImportQueueService } from '../../infra/queue/import-queue.service';
import type { AuditService } from '../audit/audit.service';
import type { FolderAccessService } from '../folders/folder-access.service';
import { GoogleDriveService } from './google-drive.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectDataSource: () => () => undefined,
  InjectRepository: () => () => undefined,
}));
jest.mock('uuid', () => ({ v7: () => 'generated-uuid' }));

const ENCRYPTION_KEY = randomBytes(32).toString('base64');

function createService(connections: Partial<GoogleDriveConnectionEntity>[]) {
  const config = {
    get: (key: string) => (key === 'GOOGLE_TOKEN_ENCRYPTION_KEY' ? ENCRYPTION_KEY : undefined),
  } as unknown as ConfigService;
  const connectionRepository = {
    find: jest.fn().mockResolvedValue(connections),
    save: jest.fn(async (connection: unknown) => connection),
  };
  const service = new GoogleDriveService(
    config,
    {} as DataSource,
    connectionRepository as unknown as Repository<GoogleDriveConnectionEntity>,
    {} as Repository<never>,
    {} as Repository<never>,
    {} as Repository<never>,
    {} as FolderAccessService,
    {} as ImportQueueService,
    {} as ActorEnrichmentService,
    {} as AuditService,
  );
  const encrypt = (value: string) =>
    (service as unknown as { encrypt(value: string): string }).encrypt(value);
  return { service, connectionRepository, encrypt };
}

describe('GoogleDriveService.disconnect', () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('revokes the grant at Google and wipes the stored token', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const connection: Partial<GoogleDriveConnectionEntity> = { status: 'active' };
    const { service, connectionRepository, encrypt } = createService([connection]);
    connection.encryptedRefreshToken = encrypt('refresh-token-1');

    await expect(service.disconnect('user-1')).resolves.toEqual({ success: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://oauth2.googleapis.com/revoke');
    expect((init.body as URLSearchParams).get('token')).toBe('refresh-token-1');
    expect(connectionRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'revoked', encryptedRefreshToken: '' }),
    );
    expect(connection.revokedAt).toBeInstanceOf(Date);
  });

  it('still wipes the token when Google cannot be reached', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const connection: Partial<GoogleDriveConnectionEntity> = { status: 'error' };
    const { service, connectionRepository, encrypt } = createService([connection]);
    connection.encryptedRefreshToken = encrypt('refresh-token-2');

    await expect(service.disconnect('user-1')).resolves.toEqual({ success: true });

    expect(connectionRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'revoked', encryptedRefreshToken: '' }),
    );
  });

  it('does not call Google when there is no stored token', async () => {
    const { service } = createService([{ status: 'error', encryptedRefreshToken: '' }]);

    await service.disconnect('user-1');

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
