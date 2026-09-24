import { BadGatewayException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccountApiService } from './account-api.service';

describe('AccountApiService', () => {
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'ACCOUNT_API_URL') return 'http://account.test/v2/';
      if (key === 'ACCOUNT_API_KEY') return 'ak_test';
      return undefined;
    }),
  } as unknown as ConfigService;

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('calls the Account API with the server-side API key and unwraps its response', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          statusCode: 200,
          message: 'Success',
          data: {
            data: [{ id: 'user-1', name: 'User 1' }],
            meta: { total: 1, page: 1, page_size: 20, total_pages: 1 },
          },
          timestamp: new Date().toISOString(),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const service = new AccountApiService(config);
    const result = await service.getUsers('user-1', { fields: 'id,name' });

    expect(result.data[0]).toEqual({ id: 'user-1', name: 'User 1' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://account.test/v2/public/users?user_ids=user-1&fields=id%2Cname',
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-api-key': 'ak_test' }),
      }),
    );
  });

  it('adds the Account API v2 prefix when the configured URL is an origin', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [],
          meta: { total: 0, page: 1, page_size: 20, total_pages: 0 },
        }),
        { status: 200 },
      ),
    );
    const originConfig = {
      get: jest.fn((key: string) => {
        if (key === 'ACCOUNT_API_URL') return 'http://account.test';
        if (key === 'ACCOUNT_API_KEY') return 'ak_test';
        return undefined;
      }),
    } as unknown as ConfigService;

    await new AccountApiService(originConfig).getUsers('user-1');

    expect(fetchMock.mock.calls[0]?.[0]).toContain('http://account.test/v2/public/users');
  });

  it('throws when the requested user does not exist', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          statusCode: 200,
          data: {
            data: [],
            meta: { total: 0, page: 1, page_size: 20, total_pages: 0 },
          },
        }),
        { status: 200 },
      ),
    );

    const service = new AccountApiService(config);
    await expect(service.getUserById('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('gets applications from the Account API', async () => {
    const applications = [
      { id: 'app-1', name: 'AG Go', code: 'AG_GO', website: 'https://go.test' },
    ];
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          statusCode: 200,
          message: 'Success',
          data: applications,
          timestamp: new Date().toISOString(),
        }),
        { status: 200 },
      ),
    );

    const service = new AccountApiService(config);
    await expect(service.getApplications()).resolves.toEqual(applications);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://account.test/v2/public/applications');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { Accept: 'application/json' },
    });
    expect(fetchMock.mock.calls[0]?.[1]).not.toMatchObject({
      headers: { 'x-api-key': expect.any(String) },
    });
  });

  it('searches users with the bearer token only and keeps the summary fields', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'user-1',
              name: ' TRẦN MỸ HẠNH',
              email: 'hanh@test.dev',
              avatar: 'https://avatar.test/1.png',
              department: 'MKT',
              last_ip: '127.0.0.1',
              group_memberships: [],
            },
          ],
          meta: {
            total: 329,
            page: 1,
            limit: 20,
            totalPages: 17,
            hasNextPage: true,
            hasPreviousPage: false,
          },
        }),
        { status: 200 },
      ),
    );

    const result = await new AccountApiService(config).searchUsers('token-1', {
      keyword: ' hanh ',
    });

    expect(result).toEqual({
      data: [
        {
          id: 'user-1',
          name: 'TRẦN MỸ HẠNH',
          email: 'hanh@test.dev',
          avatar: 'https://avatar.test/1.png',
        },
      ],
      meta: { total: 329, page: 1, limit: 20, totalPages: 17, hasNextPage: true },
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(
      'http://account.test/v2/users?page=1&limit=20&is_active=true&sort_by=name&sort_order=asc&keyword=hanh',
    );
    expect(init).toMatchObject({ headers: { authorization: 'Bearer token-1' } });
    expect(init).not.toMatchObject({ headers: { 'x-api-key': expect.any(String) } });
  });

  it('forwards an Account API denial on user search as forbidden', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('denied', { status: 403 }));

    await expect(new AccountApiService(config).searchUsers('token-1', {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('maps upstream failures to a gateway error', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('error', { status: 500 }));

    const service = new AccountApiService(config);
    await expect(service.getUsers('user-1')).rejects.toBeInstanceOf(BadGatewayException);
  });
});
