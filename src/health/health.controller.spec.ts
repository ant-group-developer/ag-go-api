import { ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import { HealthController } from './health.controller';

jest.mock('@nestjs/typeorm', () => ({
  InjectDataSource: () => () => undefined,
  InjectRepository: () => () => undefined,
}));

interface HealthControllerInternals {
  pingRedis: () => Promise<string>;
  redis?: { quit: () => Promise<string> };
}

describe('HealthController', () => {
  let mockDataSource: { query: jest.Mock };
  let mockConfig: { getOrThrow: jest.Mock };
  let controller: HealthController;
  let internals: HealthControllerInternals;

  beforeEach(() => {
    mockDataSource = {
      query: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    };
    mockConfig = {
      getOrThrow: jest.fn().mockReturnValue('redis://localhost:6379'),
    };
    controller = new HealthController(
      mockDataSource as unknown as DataSource,
      mockConfig as unknown as ConfigService,
    );
    internals = controller as unknown as HealthControllerInternals;
  });

  afterEach(async () => {
    await controller.onModuleDestroy();
  });

  it('returns a healthy response for liveness check', () => {
    const response = controller.getHealth();

    expect(response.status).toBe('ok');
    expect(response.service).toBe('ag-go-api');
    expect(response.uptime).toEqual(expect.any(Number));
  });

  it('returns ready status when database and redis are healthy', async () => {
    jest.spyOn(internals, 'pingRedis').mockResolvedValue('PONG');

    const response = await controller.getReady();

    expect(response).toMatchObject({
      status: 'ok',
      service: 'ag-go-api',
      database: 'ok',
      redis: 'ok',
    });
    expect(mockDataSource.query).toHaveBeenCalledWith('SELECT 1');
  });

  it('throws ServiceUnavailableException when database query fails', async () => {
    mockDataSource.query.mockRejectedValue(new Error('Connection lost'));
    jest.spyOn(internals, 'pingRedis').mockResolvedValue('PONG');

    await expect(controller.getReady()).rejects.toThrow(ServiceUnavailableException);
  });

  it('throws ServiceUnavailableException when redis ping fails', async () => {
    jest.spyOn(internals, 'pingRedis').mockRejectedValue(new Error('Redis timeout'));

    await expect(controller.getReady()).rejects.toThrow(ServiceUnavailableException);
  });

  it('quits redis on module destroy', async () => {
    const mockQuit = jest.fn().mockResolvedValue('OK');
    internals.redis = { quit: mockQuit };

    await controller.onModuleDestroy();

    expect(mockQuit).toHaveBeenCalled();
    expect(internals.redis).toBeUndefined();
  });
});
