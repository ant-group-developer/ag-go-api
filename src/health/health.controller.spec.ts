import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('returns a healthy response', () => {
    const response = new HealthController().getHealth();

    expect(response.status).toBe('ok');
    expect(response.service).toBe('ag-go-api');
    expect(response.uptime).toEqual(expect.any(Number));
  });
});
