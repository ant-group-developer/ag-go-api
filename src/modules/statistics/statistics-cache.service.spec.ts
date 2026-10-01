import { STATISTICS_CACHE_TTL_MS, StatisticsCacheService } from './statistics-cache.service';

describe('StatisticsCacheService', () => {
  const admin = { userId: 'admin-1', userType: 'ADMIN' as const };
  const query = { from: '2026-09-01', to: '2026-10-01' };

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-09-30T10:00:00Z') });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('reuses a response until the TTL expires', async () => {
    const cache = new StatisticsCacheService();
    const load = jest.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second');

    await expect(cache.wrap('summary', admin, query, load)).resolves.toBe('first');
    await expect(cache.wrap('summary', admin, query, load)).resolves.toBe('first');
    jest.advanceTimersByTime(STATISTICS_CACHE_TTL_MS + 1);
    await expect(cache.wrap('summary', admin, query, load)).resolves.toBe('second');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('shares one computation between concurrent requests', async () => {
    const cache = new StatisticsCacheService();
    const load = jest.fn().mockResolvedValue('value');

    await Promise.all([
      cache.wrap('trend', admin, query, load),
      cache.wrap('trend', admin, query, load),
    ]);

    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps callers, endpoints and queries apart', async () => {
    const cache = new StatisticsCacheService();
    const load = jest.fn().mockResolvedValue('value');

    await cache.wrap('summary', admin, query, load);
    await cache.wrap('summary', { userId: 'user-1', userType: 'USER' }, query, load);
    await cache.wrap('trend', admin, query, load);
    await cache.wrap('summary', admin, { ...query, tz: 'UTC' }, load);

    expect(load).toHaveBeenCalledTimes(4);
  });

  it('does not keep a failed response', async () => {
    const cache = new StatisticsCacheService();
    const load = jest.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('ok');

    await expect(cache.wrap('summary', admin, query, load)).rejects.toThrow('boom');
    await expect(cache.wrap('summary', admin, query, load)).resolves.toBe('ok');
  });
});
