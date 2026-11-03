import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import type { DataSource, Repository } from 'typeorm';
import { PiiCipherService } from '../../common/crypto/pii-cipher.service';
import type { ContractAmendmentEntity } from '../../database/entities/contract-amendment.entity';
import type { ContractEntity } from '../../database/entities/contract.entity';
import type { PartnerEntity } from '../../database/entities/partner.entity';
import type { AccountContractProfile } from '../account/account.types';
import type { SystemLogService } from '../logs/system-log.service';
import type { PartnerActor } from '../partners/partner-actor';
import type { PartnersService } from '../partners/partners.service';
import { ContractsService, type PartnerSnapshot } from './contracts.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectDataSource: () => () => undefined,
  InjectRepository: () => () => undefined,
}));
jest.mock('uuid', () => ({ v7: () => 'contract-new' }));

const actor: PartnerActor = {
  userId: 'manager-1',
  userType: 'USER',
  permissions: ['go.contract.read', 'go.contract.manage'],
  requestId: 'req-1',
};
const admin: PartnerActor = { ...actor, userType: 'ADMIN' };

const partner = {
  id: 'partner-1',
  accountUserId: 'acc-1',
  goUserId: 'user-1',
  code: 'NHH',
  displayName: 'Nguyễn Hữu Hoàng',
  managerUserId: 'manager-1',
  status: 'active',
} as PartnerEntity;

function contract(overrides: Partial<ContractEntity> = {}): ContractEntity {
  return {
    id: 'contract-1',
    partnerId: 'partner-1',
    contractNumber: '010826/HĐSXND/AG-NHH',
    contractType: 'content_production',
    signedDate: null,
    startDate: '2026-08-01',
    endDate: null,
    status: 'draft',
    pricingModel: 'per_unit',
    pricingConfig: { unit: 'shot', unit_price: 300_000 },
    capAmount: 50_000_000,
    advanceAmount: 0,
    advanceDueBusinessDays: null,
    advanceOffsetRule: 'full_first',
    acceptanceCycle: 'monthly',
    deliveryRule: null,
    paymentTermBusinessDays: 10,
    techSpec: { min_width: 3840 },
    penaltyPercent: 8,
    originalityMinPercent: null,
    similarityMaxPercent: 30,
    nonCompeteMonths: 24,
    templateVersionId: null,
    managerUserId: 'manager-1',
    partnerSnapshotEnc: undefined as unknown as null,
    partnerSnapshotAt: null,
    lastAppendixNumber: 0,
    source: 'system',
    legacyAcceptedAmount: null,
    legacyPaidAmount: null,
    legacyAdvanceBalance: null,
    signedFileId: null,
    activationNote: null,
    suspendedReason: null,
    terminatedReason: null,
    note: null,
    issuedAt: null,
    issuedBy: null,
    activatedAt: null,
    activatedBy: null,
    closedAt: null,
    createdBy: 'manager-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const profile = {
  user_id: 'acc-1',
  name: 'Nguyễn Hữu Hoàng',
  citizen_id_number: '035086000130',
  bank_account_number: '0011006167',
  passport_unreadable: false,
  version: 'v-7',
} as AccountContractProfile;

function setup(row: ContractEntity) {
  const state = { row: { ...row } };
  const contractRepository = {
    findOne: jest.fn(async () => ({ ...state.row })),
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn(async (value: ContractEntity) => {
      state.row = { ...value };
      return value;
    }),
    create: jest.fn((value: Partial<ContractEntity>) => value),
    delete: jest.fn(),
    createQueryBuilder: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([{ contractNumber: '010826/HĐSXND/AG-NHH' }]),
    })),
    manager: { query: jest.fn().mockResolvedValue([]) },
  };
  const amendmentRepository = {
    find: jest.fn().mockResolvedValue([]),
  };
  const partnerRepository = {
    findOneByOrFail: jest.fn(async () => partner),
    find: jest.fn(async () => [partner]),
  };
  const dataSource = {
    transaction: jest.fn(async (callback: (manager: unknown) => Promise<unknown>) =>
      callback({ getRepository: () => contractRepository }),
    ),
  };
  const partners = {
    findVisible: jest.fn(async () => partner),
    readProfileForDocument: jest.fn(
      async (): Promise<{
        profile: AccountContractProfile;
        completeness: { complete: boolean; missing: string[] };
      }> => ({ profile, completeness: { complete: true, missing: [] } }),
    ),
    canSee: jest.fn(() => true),
  };
  const key = randomBytes(32).toString('base64');
  const cipher = new PiiCipherService({
    get: (name: string) => (name === 'PARTNER_PII_ENCRYPTION_KEY' ? key : undefined),
  } as unknown as ConfigService);
  const systemLog = { write: jest.fn().mockResolvedValue(undefined) };
  const service = new ContractsService(
    dataSource as unknown as DataSource,
    contractRepository as unknown as Repository<ContractEntity>,
    amendmentRepository as unknown as Repository<ContractAmendmentEntity>,
    partnerRepository as unknown as Repository<PartnerEntity>,
    partners as unknown as PartnersService,
    cipher,
    systemLog as unknown as SystemLogService,
  );
  return { service, state, contractRepository, partners, cipher, systemLog };
}

describe('ContractsService.create', () => {
  const dto = {
    partnerId: 'partner-1',
    startDate: '2026-08-01',
    pricingModel: 'per_unit' as const,
    pricingConfig: { unit: 'shot', unit_price: 300_000 },
    acceptanceCycle: 'monthly' as const,
    paymentTermBusinessDays: 10,
  };

  it('numbers a draft from the start date (BR-05) and fills the default tech spec', async () => {
    const { service, contractRepository } = setup(contract());

    await service.create(dto, actor);

    expect(contractRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'contract-new',
        contractNumber: '010826/HĐSXND/AG-NHH-2',
        status: 'draft',
        managerUserId: 'manager-1',
        techSpec: expect.objectContaining({ min_width: 3840, fps: { target: 60, tolerance: 0.1 } }),
        source: 'system',
      }),
    );
  });

  it('refuses an invalid pricing config with field errors', async () => {
    const { service, contractRepository } = setup(contract());
    const error = await service
      .create({ ...dto, pricingConfig: { unit: 'clip', unit_price: 1 } }, actor)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      code: 'CONTRACT_TERMS_INVALID',
      fieldErrors: { pricingConfig: [expect.stringContaining('max_shots_per_clip')] },
    });
    expect(contractRepository.save).not.toHaveBeenCalled();
  });

  it('refuses a new contract for an inactive partner (FR-P-11)', async () => {
    const { service, partners } = setup(contract());
    partners.findVisible.mockResolvedValueOnce({ ...partner, status: 'inactive' });
    await expect(service.create(dto, actor)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('ContractsService.update', () => {
  it('locks the terms once issued but still changes the manager', async () => {
    const { service, contractRepository } = setup(contract({ status: 'active' }));

    await expect(service.update('contract-1', { capAmount: 1 }, actor)).rejects.toMatchObject({
      response: { code: 'CONTRACT_TERMS_LOCKED' },
    });
    await service.update('contract-1', { managerUserId: 'manager-1', note: 'ghi chú' }, actor);
    expect(contractRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ note: 'ghi chú', capAmount: 50_000_000 }),
    );
  });
});

describe('ContractsService.issue', () => {
  it('stores the AG Account profile encrypted and moves to issued', async () => {
    const { service, state, cipher, partners } = setup(contract());

    const result = await service.issue('contract-1', actor);

    expect(partners.readProfileForDocument).toHaveBeenCalledWith(partner, actor);
    expect(state.row.status).toBe('issued');
    expect(state.row.issuedBy).toBe('manager-1');
    expect(state.row.partnerSnapshotEnc).toMatch(/^1:/);
    expect(state.row.partnerSnapshotEnc).not.toContain('035086000130');
    const snapshot = cipher.decryptJson<PartnerSnapshot>(state.row.partnerSnapshotEnc!);
    expect(snapshot).toMatchObject({
      accountUserId: 'acc-1',
      profileVersion: 'v-7',
      partnerCode: 'NHH',
      fields: { citizenIdNumber: '035086000130', bankAccountNumber: '0011006167' },
    });
    expect(result).not.toHaveProperty('partnerSnapshotEnc');
    expect(result.hasPartnerSnapshot).toBe(true);
  });

  it('is blocked while the partner profile misses a field (FR-P-07)', async () => {
    const { service, state, partners } = setup(contract());
    partners.readProfileForDocument.mockResolvedValueOnce({
      profile,
      completeness: { complete: false, missing: ['bankAccountNumber', 'taxMode'] },
    });

    const error = await service.issue('contract-1', actor).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect((error as UnprocessableEntityException).getResponse()).toMatchObject({
      code: 'PARTNER_PROFILE_INCOMPLETE',
      details: { missing: ['bankAccountNumber', 'taxMode'] },
    });
    expect(state.row.status).toBe('draft');
  });

  it('is blocked when AG Account cannot be read (BR-02)', async () => {
    const { service, state, partners } = setup(contract());
    partners.readProfileForDocument.mockRejectedValueOnce(
      new ServiceUnavailableException('Account API is unavailable'),
    );
    await expect(service.issue('contract-1', actor)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(state.row.status).toBe('draft');
  });

  it('refuses to issue twice without calling AG Account', async () => {
    const { service, partners } = setup(contract({ status: 'issued' }));
    await expect(service.issue('contract-1', actor)).rejects.toMatchObject({
      response: { code: 'CONTRACT_INVALID_TRANSITION' },
    });
    expect(partners.readProfileForDocument).not.toHaveBeenCalled();
  });

  it('drops the snapshot when unissued', async () => {
    const { service, state } = setup(
      contract({ status: 'issued', partnerSnapshotEnc: '1:x', partnerSnapshotAt: new Date() }),
    );
    await service.unissue('contract-1', actor);
    expect(state.row).toMatchObject({ status: 'draft', partnerSnapshotEnc: null, issuedAt: null });
  });
});

describe('ContractsService.activate', () => {
  it('needs the signing date and the signed copy', async () => {
    const { service, state } = setup(contract({ status: 'issued' }));

    await expect(service.activate('contract-1', {}, actor)).rejects.toMatchObject({
      response: { code: 'CONTRACT_SIGNED_DATE_REQUIRED' },
    });
    await expect(
      service.activate('contract-1', { signedDate: '2026-08-01' }, actor),
    ).rejects.toMatchObject({ response: { code: 'CONTRACT_SIGNED_FILE_REQUIRED' } });
    // A non-admin cannot skip the copy, reason or not.
    await expect(
      service.activate(
        'contract-1',
        { signedDate: '2026-08-01', skipSignedFileReason: 'Bản giấy' },
        actor,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(state.row.status).toBe('issued');

    await service.activate(
      'contract-1',
      { signedDate: '2026-08-01', signedFileId: '0190f000-0000-7000-8000-00000000000f' },
      actor,
    );
    expect(state.row).toMatchObject({
      status: 'active',
      signedDate: '2026-08-01',
      activatedBy: 'manager-1',
    });
  });

  it('lets an administrator activate without the copy, with a reason', async () => {
    const { service, state } = setup(contract({ status: 'issued', signedDate: '2026-08-01' }));
    await service.activate('contract-1', { skipSignedFileReason: 'Bản giấy lưu ở kế toán' }, admin);
    expect(state.row).toMatchObject({
      status: 'active',
      activationNote: 'Bản giấy lưu ở kế toán',
      signedFileId: null,
    });
  });
});

describe('ContractsService lifecycle', () => {
  it('suspends, resumes and terminates with a reason, auditing each change', async () => {
    const { service, state, systemLog } = setup(contract({ status: 'active' }));

    await service.suspend('contract-1', 'Chờ bổ sung hồ sơ', actor);
    expect(state.row).toMatchObject({ status: 'suspended', suspendedReason: 'Chờ bổ sung hồ sơ' });
    await service.resume('contract-1', actor);
    expect(state.row.status).toBe('active');
    await service.terminate('contract-1', 'Thoả thuận chấm dứt', actor);
    expect(state.row).toMatchObject({
      status: 'terminated',
      terminatedReason: 'Thoả thuận chấm dứt',
      closedAt: expect.any(Date),
    });
    expect(systemLog.write.mock.calls.map(([entry]) => entry.action)).toEqual([
      'CONTRACT_SUSPEND',
      'CONTRACT_RESUME',
      'CONTRACT_TERMINATE',
    ]);
    await expect(service.resume('contract-1', actor)).rejects.toBeInstanceOf(ConflictException);
  });

  it('hides contracts managed by someone else without read_all', async () => {
    const { service } = setup(contract({ managerUserId: 'other' }));
    await expect(service.get('contract-1', actor)).rejects.toMatchObject({
      response: { code: 'CONTRACT_NOT_FOUND' },
    });
    await expect(
      service.get('contract-1', { ...actor, permissions: ['go.contract.read_all'] }),
    ).resolves.toMatchObject({ id: 'contract-1', allowedActions: ['issue'] });
  });
});
