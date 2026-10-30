import type { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import type { SystemSettingEntity } from '../../database/entities/system-setting.entity';
import { SettingsService } from './settings.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => () => undefined,
}));

const ENV_MAX_UPLOAD = 10 * 1024 ** 3;

function createService(stored: Record<string, unknown> | null) {
  const repository = {
    findOne: jest.fn().mockResolvedValue(stored ? { key: 'web', value: stored } : null),
    save: jest.fn(async (entity: SystemSettingEntity) => entity),
  };
  const config = { getOrThrow: () => ENV_MAX_UPLOAD } as unknown as ConfigService;
  const service = new SettingsService(
    repository as unknown as Repository<SystemSettingEntity>,
    config,
  );
  return { service, repository };
}

describe('SettingsService upload limit', () => {
  it('falls back to MAX_UPLOAD_SIZE_BYTES when nothing is stored', async () => {
    const { service } = createService(null);

    await expect(service.getMaxUploadSizeBytes()).resolves.toBe(ENV_MAX_UPLOAD);
    await expect(service.getPublic()).resolves.toMatchObject({
      maxUploadSizeBytes: ENV_MAX_UPLOAD,
    });
  });

  it('uses the limit saved by an admin', async () => {
    const { service } = createService({ siteName: 'AG Go', maxUploadSizeBytes: 2 * 1024 ** 3 });

    await expect(service.getMaxUploadSizeBytes()).resolves.toBe(2 * 1024 ** 3);
  });

  it('goes back to the default when the saved limit is cleared', async () => {
    const { service } = createService({ siteName: 'AG Go', maxUploadSizeBytes: 2 * 1024 ** 3 });

    const updated = await service.update({ siteName: 'AG Go', maxUploadSizeBytes: null }, 'user-1');

    expect(updated.maxUploadSizeBytes).toBe(ENV_MAX_UPLOAD);
  });
});
