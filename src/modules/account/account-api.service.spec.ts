import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
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

  it('asks for the caller permissions in this application, whatever web app issued the token', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          statusCode: 200,
          data: { id: 'user-1', user_type: 'USER', permissions: ['go.footage.search'] },
        }),
        { status: 200 },
      ),
    );

    const me = await new AccountApiService(config).getCurrentUser('studio-token');

    expect(me.permissions).toEqual(['go.footage.search']);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://account.test/v2/users/me?application=ant-go-v2',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer studio-token' }),
      }),
    );
  });

  it('passes is_active through from the act-as access lookup', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          statusCode: 200,
          data: {
            user_id: 'u-9',
            application: 'ant-go-v2',
            is_active: false,
            user_type: 'USER',
            permissions: [],
          },
        }),
        { status: 200 },
      ),
    );

    await expect(new AccountApiService(config).getUserAccess('u-9')).resolves.toEqual({
      user_type: 'USER',
      permissions: [],
      is_active: false,
    });
  });

  it('maps upstream failures to a gateway error', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('error', { status: 500 }));

    const service = new AccountApiService(config);
    await expect(service.getUsers('user-1')).rejects.toBeInstanceOf(BadGatewayException);
  });

  describe('contract profile', () => {
    const profile = {
      user_id: 'acc-1',
      name: 'Nguyễn Hữu Hoàng',
      citizen_id_number: '035086000130',
      tax_number: '035086000130',
      bank_account_last4: '6167',
      passport_unreadable: false,
      bank_account_unreadable: false,
      updated_at: null,
      version: 'v-1',
    };

    it('reads it with the API key and the acting AG Account user', async () => {
      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(
          new Response(JSON.stringify({ statusCode: 200, data: profile }), { status: 200 }),
        );

      await expect(
        new AccountApiService(config).getContractProfile('acc-1', 'acting-1'),
      ).resolves.toEqual(profile);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://account.test/v2/public/users/acc-1/contract-profile',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'x-api-key': 'ak_test',
            'X-Acting-User-Id': 'acting-1',
          }),
        }),
      );
    });

    it('leaves out an acting user id Account API would refuse', async () => {
      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify(profile), { status: 200 }));

      await new AccountApiService(config).getContractProfile('acc-1', 'waad|' + 'x'.repeat(40));

      const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
      expect(headers['X-Acting-User-Id']).toBeUndefined();
    });

    it('maps 404 to a not-a-member error and 403 to unavailable', async () => {
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(new Response('{"message":"x"}', { status: 404 }))
        .mockResolvedValueOnce(new Response('{"message":"x"}', { status: 403 }));
      const service = new AccountApiService(config);

      const notFound = await service.getContractProfile('acc-1').catch((error: unknown) => error);
      expect(notFound).toBeInstanceOf(NotFoundException);
      expect((notFound as NotFoundException).getResponse()).toMatchObject({
        code: 'ACCOUNT_USER_NOT_IN_APPLICATION',
      });
      await expect(service.getContractProfile('acc-1')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('maps a network failure to unavailable', async () => {
      jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(
        new AccountApiService(config).getContractProfile('acc-1'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('patches only the given fields with If-Match', async () => {
      const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            data: { ...profile, version: 'v-2', changed_fields: ['phone_number'] },
            statusCode: 200,
          }),
          { status: 200 },
        ),
      );

      const result = await new AccountApiService(config).patchContractProfile(
        'acc-1',
        { phone_number: '0912345678', address: null },
        { version: 'v-1', actingUserId: 'acting-1' },
      );

      expect(result.version).toBe('v-2');
      expect(result.changed_fields).toEqual(['phone_number']);
      const init = fetchMock.mock.calls[0]?.[1];
      expect(init).toMatchObject({
        method: 'PATCH',
        headers: {
          'If-Match': 'v-1',
          'X-Acting-User-Id': 'acting-1',
          'Content-Type': 'application/json',
        },
      });
      expect(JSON.parse(init?.body as string)).toEqual({
        phone_number: '0912345678',
        address: null,
      });
    });

    it('maps 409 to a version conflict and 400 to the Account API messages', async () => {
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(new Response('{"message":"conflict"}', { status: 409 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              statusCode: 400,
              message: ['citizen_id_number đã thuộc người dùng khác'],
            }),
            { status: 400 },
          ),
        );
      const service = new AccountApiService(config);

      const conflict = await service
        .patchContractProfile('acc-1', { phone_number: null }, { version: 'old' })
        .catch((error: unknown) => error);
      expect(conflict).toBeInstanceOf(ConflictException);
      expect((conflict as ConflictException).getResponse()).toMatchObject({
        code: 'CONTRACT_PROFILE_VERSION_CONFLICT',
      });

      const invalid = await service
        .patchContractProfile('acc-1', { citizen_id_number: '1' }, { version: 'v' })
        .catch((error: unknown) => error);
      expect(invalid).toBeInstanceOf(BadRequestException);
      expect((invalid as BadRequestException).getResponse()).toMatchObject({
        code: 'CONTRACT_PROFILE_INVALID',
        details: { messages: ['citizen_id_number đã thuộc người dùng khác'] },
      });
    });
  });

  describe('resolveBySub', () => {
    it('looks the subject up for this application and caches it for 10 minutes', async () => {
      const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              statusCode: 200,
              data: {
                user_id: 'acc-1',
                application: 'ant-go-v2',
                is_active: true,
                user_type: 'USER',
                permissions: ['go.project.edit'],
              },
            }),
            { status: 200 },
          ),
      );
      const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
      const service = new AccountApiService(config);

      const first = await service.resolveBySub('google-oauth2|123');
      await service.resolveBySub('google-oauth2|123');
      now.mockReturnValue(1_000_000 + 9 * 60 * 1000);
      await service.resolveBySub('google-oauth2|123');

      expect(first).toEqual({
        user_id: 'acc-1',
        application: 'ant-go-v2',
        is_active: true,
        user_type: 'USER',
        permissions: ['go.project.edit'],
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        'http://account.test/v2/public/users/by-sub/access?sub=google-oauth2%7C123&application=ant-go-v2',
      );

      now.mockReturnValue(1_000_000 + 11 * 60 * 1000);
      await service.resolveBySub('google-oauth2|123');
      expect(fetchMock).toHaveBeenCalledTimes(2);

      service.forgetAccountUsers(['acc-1']);
      await service.resolveBySub('google-oauth2|123');
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('refuses an unexpected response shape', async () => {
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify({ user_id: 'acc-1' }), { status: 200 }));

      await expect(new AccountApiService(config).resolveBySub('auth0|x')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });

  it('searches members of the application with the API key', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: 'acc-1', name: 'A' }],
          meta: { total: 1, page: 1, page_size: 20, total_pages: 1 },
        }),
        { status: 200 },
      ),
    );

    await new AccountApiService(config).searchApplicationUsers({ keyword: 'an', limit: 20 });

    const url = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(url.pathname).toBe('/v2/public/users');
    expect(url.searchParams.get('application')).toBe('ant-go-v2');
    expect(url.searchParams.get('keyword')).toBe('an');
    expect(url.searchParams.get('page_size')).toBe('20');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ headers: { 'x-api-key': 'ak_test' } });
  });
});
