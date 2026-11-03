import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { PartnerEntity } from '../../database/entities/partner.entity';
import type { AccountApiService } from '../account/account-api.service';
import type { AccountContractProfile } from '../account/account.types';
import type { SystemLogService } from '../logs/system-log.service';
import type { PartnerActor } from './partner-actor';
import { PartnersService } from './partners.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => () => undefined,
}));
jest.mock('uuid', () => ({ v7: () => 'partner-new' }));

const manager: PartnerActor = {
  userId: 'manager-1',
  sub: 'auth0|manager-1',
  userType: 'USER',
  permissions: ['go.partner.read', 'go.partner.manage'],
  requestId: 'req-1',
};

function partner(overrides: Partial<PartnerEntity> = {}): PartnerEntity {
  return {
    id: 'partner-1',
    accountUserId: 'acc-1',
    goUserId: 'user-1',
    code: 'NHH',
    displayName: 'Nguyễn Hữu Hoàng',
    managerUserId: 'manager-1',
    status: 'active',
    profileCheckedAt: null,
    profileMissingFields: null,
    note: null,
    createdBy: 'manager-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function profile(overrides: Partial<AccountContractProfile> = {}): AccountContractProfile {
  return {
    user_id: 'acc-1',
    name: 'Nguyễn Hữu Hoàng',
    citizen_id_number: '035086000130',
    id_issued_date: '2021-05-01',
    id_issued_place: 'Cục CS',
    tax_number: '035086000130',
    phone_number: '0912345678',
    birthday: '1986-02-03',
    address: null,
    permanent_address: 'Hà Nam',
    passport_number: null,
    contract_number: null,
    contract_date: null,
    bank_account_name: 'NGUYEN HUU HOANG',
    bank_account_number: '0011006167',
    bank_code: '970436',
    bank_name: 'Vietcombank',
    tax_mode: 'WITHHOLD_10',
    bank_account_last4: '6167',
    passport_unreadable: false,
    bank_account_unreadable: false,
    updated_at: null,
    version: 'v-1',
    ...overrides,
  };
}

function setup(rows: PartnerEntity[] = []) {
  const codeQuery = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([{ code: 'NHH' }]),
  };
  const repository = {
    findOne: jest.fn(async ({ where }: { where: Partial<PartnerEntity> }) => {
      return (
        rows.find((row) =>
          Object.entries(where).every(([key, value]) => row[key as keyof PartnerEntity] === value),
        ) ?? null
      );
    }),
    find: jest.fn().mockResolvedValue(rows),
    exists: jest.fn().mockResolvedValue(false),
    insert: jest.fn().mockResolvedValue(undefined),
    save: jest.fn(async (value: PartnerEntity) => value),
    update: jest.fn().mockResolvedValue(undefined),
    create: jest.fn((value: Partial<PartnerEntity>) => value),
    findOneByOrFail: jest.fn(async ({ id }: { id: string }) => partner({ id })),
    createQueryBuilder: jest.fn(() => codeQuery),
    manager: { query: jest.fn().mockResolvedValue([]) },
  };
  const accountApi = {
    resolveBySub: jest.fn(async (sub: string) => ({
      user_id: sub === 'auth0|manager-1' ? 'acc-manager' : 'acc-1',
      user_type: 'USER',
      permissions: ['go.project.edit'],
      is_active: true,
    })),
    getUsersByIds: jest.fn(
      async () => new Map([['acc-1', { id: 'acc-1', name: 'Nguyễn Hữu Hoàng' }]]),
    ),
    getContractProfile: jest.fn(async () => profile()),
    patchContractProfile: jest.fn(async () => ({
      ...profile({ phone_number: '0987654321', version: 'v-2' }),
      changed_fields: ['phone_number'],
    })),
    searchApplicationUsers: jest.fn(),
  };
  const systemLog = { write: jest.fn().mockResolvedValue(undefined) };
  const service = new PartnersService(
    repository as unknown as Repository<PartnerEntity>,
    accountApi as unknown as AccountApiService,
    systemLog as unknown as SystemLogService,
  );
  return { service, repository, accountApi, systemLog, codeQuery };
}

describe('PartnersService.create', () => {
  it('resolves the AG Account id by subject and generates the next free code', async () => {
    const { service, repository, accountApi, systemLog } = setup();

    await service.create({ goUserId: 'google-oauth2|42' }, manager);

    expect(accountApi.resolveBySub).toHaveBeenCalledWith('google-oauth2|42');
    expect(repository.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'partner-new',
        accountUserId: 'acc-1',
        goUserId: 'google-oauth2|42',
        code: 'NHH2',
        displayName: 'Nguyễn Hữu Hoàng',
        managerUserId: 'manager-1',
        status: 'active',
        createdBy: 'manager-1',
      }),
    );
    expect(systemLog.write).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'partner', action: 'PARTNER_CREATED' }),
    );
  });

  it('rebuilds the Auth0 subject of a plain AG Go id', async () => {
    const { service, accountApi } = setup();
    await service.create({ goUserId: 'user-1', code: 'ABC' }, manager);
    expect(accountApi.resolveBySub).toHaveBeenCalledWith('auth0|user-1');
  });

  it('refuses a user already partner, by AG Go or AG Account id', async () => {
    await expect(
      setup([partner()]).service.create({ goUserId: 'user-1' }, manager),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      setup([partner({ goUserId: 'other' })]).service.create({ goUserId: 'user-1' }, manager),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses a picked AG Account user that does not match the AG Go user', async () => {
    await expect(
      setup().service.create({ goUserId: 'user-1', accountUserId: 'acc-other' }, manager),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a user who is not a member of AG Go', async () => {
    const { service, accountApi, repository } = setup();
    accountApi.resolveBySub.mockResolvedValueOnce({
      user_id: 'acc-1',
      user_type: 'USER',
      permissions: [],
      is_active: true,
    });

    const error = await service.create({ goUserId: 'user-1' }, manager).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).getResponse()).toMatchObject({
      code: 'ACCOUNT_USER_NOT_IN_APPLICATION',
    });
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('refuses a taken code', async () => {
    const { service, repository } = setup();
    repository.exists.mockResolvedValueOnce(true);
    await expect(service.create({ goUserId: 'user-1', code: 'NHH' }, manager)).rejects.toThrow(
      ConflictException,
    );
  });
});

describe('PartnersService scope', () => {
  it('hides partners managed by someone else without read_all', async () => {
    const { service } = setup([partner({ managerUserId: 'someone-else' })]);
    await expect(service.findVisible('partner-1', manager)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      service.findVisible('partner-1', { ...manager, permissions: ['go.partner.read_all'] }),
    ).resolves.toMatchObject({ id: 'partner-1' });
    await expect(
      service.findVisible('partner-1', { ...manager, userType: 'ADMIN', permissions: [] }),
    ).resolves.toMatchObject({ id: 'partner-1' });
  });
});

describe('PartnersService profile', () => {
  it('returns the profile masked, acting as the AG Account user, and audits the view', async () => {
    const { service, accountApi, systemLog, repository } = setup([partner()]);

    const view = await service.getProfile('partner-1', false, manager);

    expect(accountApi.resolveBySub).toHaveBeenCalledWith('auth0|manager-1');
    expect(accountApi.getContractProfile).toHaveBeenCalledWith('acc-1', 'acc-manager');
    expect(view.fields.citizenIdNumber).toBe('0350******30');
    expect(view.completeness.complete).toBe(true);
    expect(systemLog.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PARTNER_PROFILE_VIEWED',
        userId: 'manager-1',
        requestId: 'req-1',
        metadata: expect.objectContaining({ reveal: false, fields: [] }),
      }),
    );
    // Only field names are audited, never values.
    expect(JSON.stringify(systemLog.write.mock.calls)).not.toContain('035086000130');
    expect(repository.update).toHaveBeenCalledWith(
      'partner-1',
      expect.objectContaining({ profileMissingFields: [], profileCheckedAt: expect.any(Date) }),
    );
  });

  it('reveals the values only with go.partner.pii_read', async () => {
    const { service, accountApi } = setup([partner()]);
    await expect(service.getProfile('partner-1', true, manager)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(accountApi.getContractProfile).not.toHaveBeenCalled();

    const view = await service.getProfile('partner-1', true, {
      ...manager,
      permissions: [...manager.permissions!, 'go.partner.pii_read'],
    });
    expect(view.revealed).toBe(true);
    expect(view.fields.citizenIdNumber).toBe('035086000130');
  });

  it('records a missing field found on view', async () => {
    const { service, accountApi, repository } = setup([partner()]);
    accountApi.getContractProfile.mockResolvedValueOnce(profile({ tax_mode: null }));

    const view = await service.getProfile('partner-1', false, manager);

    expect(view.completeness).toEqual({ complete: false, missing: ['taxMode'] });
    expect(repository.update).toHaveBeenCalledWith(
      'partner-1',
      expect.objectContaining({ profileMissingFields: ['taxMode'], profileCheckedAt: null }),
    );
  });

  it('patches through AG Account with If-Match and audits the changed field names', async () => {
    const { service, accountApi, systemLog } = setup([partner()]);

    const result = await service.updateProfile(
      'partner-1',
      { version: 'v-1', phoneNumber: '0987654321' },
      manager,
    );

    expect(accountApi.patchContractProfile).toHaveBeenCalledWith(
      'acc-1',
      { phone_number: '0987654321' },
      { version: 'v-1', actingUserId: 'acc-manager' },
    );
    expect(result.changedFields).toEqual(['phoneNumber']);
    expect(result.version).toBe('v-2');
    expect(result.fields.phoneNumber).toBe('09******21');
    expect(systemLog.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PARTNER_PROFILE_UPDATED',
        metadata: expect.objectContaining({ fields: ['phoneNumber'] }),
      }),
    );
    expect(JSON.stringify(systemLog.write.mock.calls)).not.toContain('0987654321');
  });

  it('refuses an update without any field', async () => {
    const { service, accountApi } = setup([partner()]);
    await expect(
      service.updateProfile('partner-1', { version: 'v-1' }, manager),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(accountApi.patchContractProfile).not.toHaveBeenCalled();
  });
});

describe('PartnersService webhooks', () => {
  it('refreshes cached names that changed', async () => {
    const { service, repository, accountApi } = setup([
      partner({ displayName: 'Old name' }),
      partner({ id: 'partner-2', accountUserId: 'acc-2', displayName: 'Same' }),
    ]);
    accountApi.getUsersByIds.mockResolvedValueOnce(
      new Map([
        ['acc-1', { id: 'acc-1', name: 'New name' }],
        ['acc-2', { id: 'acc-2', name: 'Same' }],
      ]),
    );

    await expect(service.refreshDisplayNames(['acc-1', 'acc-2'])).resolves.toBe(1);
    expect(repository.update).toHaveBeenCalledTimes(1);
    expect(repository.update).toHaveBeenCalledWith('partner-1', { displayName: 'New name' });
  });

  it('voids the last completeness check when the contract profile changed', async () => {
    const { service, repository } = setup();
    await service.markProfileChanged('acc-1');
    expect(repository.update).toHaveBeenCalledWith(
      { accountUserId: 'acc-1' },
      { profileCheckedAt: null, profileMissingFields: null },
    );
  });
});
