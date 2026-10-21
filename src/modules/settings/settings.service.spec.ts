import { SettingsService } from './settings.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => () => undefined,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createService(storedSetting: Record<string, unknown> | null = null) {
  const repo = {
    findOne: jest
      .fn()
      .mockResolvedValue(storedSetting !== null ? { key: 'web', value: storedSetting } : null),
    save: jest.fn().mockImplementation(async (v: Record<string, unknown>) => ({
      key: 'web',
      value: v.value ?? {},
    })),
  };

  const service = new SettingsService(repo as never);
  return { service, repo };
}

// ---------------------------------------------------------------------------
// getPublic() / get()
// ---------------------------------------------------------------------------

describe('SettingsService.getPublic', () => {
  it('returns all default values when no setting is stored', async () => {
    const { service } = createService(null);
    const result = await service.getPublic();
    expect(result).toMatchObject({
      siteName: 'AG Go',
      siteDescription: 'AG Go internal media workspace',
      logoUrl: null,
      faviconUrl: null,
      loginBackgroundUrl: null,
      supportEmail: null,
      supportUrl: null,
      primaryColor: null,
    });
  });

  it('merges stored values over the defaults', async () => {
    const { service } = createService({ siteName: 'Custom Name', primaryColor: '#ff0000' });
    const result = await service.getPublic();
    expect(result.siteName).toBe('Custom Name');
    expect(result.primaryColor).toBe('#ff0000');
    // Defaults still apply for non-overridden keys
    expect(result.supportEmail).toBeNull();
  });
});

describe('SettingsService.get', () => {
  it('returns defaults when no setting exists', async () => {
    const { service } = createService(null);
    const result = await service.get();
    expect(result.siteName).toBe('AG Go');
  });

  it('returns stored values merged with defaults', async () => {
    const { service } = createService({ supportEmail: 'help@example.com' });
    const result = await service.get();
    expect(result.supportEmail).toBe('help@example.com');
    expect(result.siteName).toBe('AG Go'); // default preserved
  });
});

// ---------------------------------------------------------------------------
// update()
// ---------------------------------------------------------------------------

describe('SettingsService.update', () => {
  it('saves the merged value and returns it', async () => {
    const stored = { siteName: 'Old Name', primaryColor: '#000' };
    const { service, repo } = createService(stored);
    repo.save.mockResolvedValue({
      key: 'web',
      value: { ...stored, siteName: 'New Name', primaryColor: '#000' },
    });
    const result = await service.update({ siteName: 'New Name' } as never, 'admin-1');
    expect(result.siteName).toBe('New Name');
    expect(result.primaryColor).toBe('#000'); // previous value preserved
  });

  it('creates a new row when no setting exists yet', async () => {
    const { service, repo } = createService(null);
    repo.save.mockResolvedValue({ key: 'web', value: { siteName: 'Fresh' } });
    const result = await service.update({ siteName: 'Fresh' } as never, 'admin-1');
    // The save call should include updatedBy
    expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ updatedBy: 'admin-1' }));
    expect(result.siteName).toBe('Fresh');
  });

  it('deep-merges partial updates without removing unrelated keys', async () => {
    const stored = { siteName: 'AG Go', supportEmail: 'a@b.com', primaryColor: '#333' };
    const { service, repo } = createService(stored);
    repo.save.mockResolvedValue({
      key: 'web',
      value: { ...stored, primaryColor: '#fff' },
    });
    const result = await service.update({ primaryColor: '#fff' } as never, 'admin-1');
    expect(result.supportEmail).toBe('a@b.com');
    expect(result.primaryColor).toBe('#fff');
  });
});
