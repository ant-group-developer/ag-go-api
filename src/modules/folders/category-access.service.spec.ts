jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => () => undefined,
}));

// uuid ships as ESM; mock it so Jest (CommonJS mode) can load it.
jest.mock('uuid', () => ({ v7: () => 'mock-uuid-v7', v4: () => 'mock-uuid-v4' }));

import { NotFoundException } from '@nestjs/common';
import { CategoryAccessService } from './category-access.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGrant(overrides: Record<string, unknown> = {}) {
  return {
    id: 'grant-1',
    categoryId: 'cat-1',
    principalType: 'user' as const,
    principalId: 'user-1',
    grantedBy: 'admin-1',
    updatedAt: new Date('2024-06-01'),
    ...overrides,
  };
}

function makeCategory(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cat-1',
    name: 'News',
    isActive: true,
    ...overrides,
  };
}

function createService(
  overrides: {
    grants?: ReturnType<typeof makeGrant>[];
    category?: ReturnType<typeof makeCategory> | null;
    activeCount?: number;
    deleteAffected?: number;
  } = {},
) {
  const {
    grants = [makeGrant()],
    category = makeCategory(),
    activeCount = 1,
    deleteAffected = 1,
  } = overrides;

  const insertQb = {
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    orIgnore: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({}),
  };

  const grantRepo = {
    find: jest.fn().mockResolvedValue(grants),
    delete: jest.fn().mockResolvedValue({ affected: deleteAffected }),
    createQueryBuilder: jest.fn().mockReturnValue(insertQb),
  };

  const categoryRepo = {
    find: jest.fn().mockResolvedValue(category ? [category] : []),
    findOne: jest.fn().mockResolvedValue(category),
    count: jest.fn().mockResolvedValue(activeCount),
  };

  const actorEnrichment = {
    enrich: jest.fn().mockImplementation((items: unknown[]) => Promise.resolve(items)),
  };

  const service = new CategoryAccessService(
    grantRepo as never,
    categoryRepo as never,
    actorEnrichment as never,
  );

  return { service, grantRepo, categoryRepo, actorEnrichment, insertQb };
}

// ---------------------------------------------------------------------------
// users()
// ---------------------------------------------------------------------------

describe('CategoryAccessService.users', () => {
  it('returns empty page when there are no grants', async () => {
    const { service } = createService({ grants: [] });
    const result = await service.users({});
    expect(result.data).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('aggregates grants per user with category count', async () => {
    const grants = [
      makeGrant({ principalId: 'user-1', categoryId: 'cat-1' }),
      makeGrant({ principalId: 'user-1', categoryId: 'cat-2', id: 'grant-2' }),
    ];
    const { service, categoryRepo } = createService({ grants });
    categoryRepo.find.mockResolvedValue([
      makeCategory({ id: 'cat-1', name: 'News' }),
      makeCategory({ id: 'cat-2', name: 'Sport' }),
    ]);
    const result = await service.users({});
    expect(result.data).toHaveLength(1);
    expect(result.data[0].userId).toBe('user-1');
    expect(result.data[0].categoryCount).toBe(2);
    expect(result.total).toBe(1);
  });

  it('skips grants whose category is not found', async () => {
    const grants = [makeGrant({ categoryId: 'ghost-cat' })];
    const { service, categoryRepo } = createService({ grants });
    // No category returned
    categoryRepo.find.mockResolvedValue([]);
    const result = await service.users({});
    expect(result.data).toHaveLength(0);
  });

  it('respects page and limit pagination', async () => {
    // Two users in separate grants
    const grants = [
      makeGrant({ principalId: 'user-A', id: 'g1' }),
      makeGrant({ principalId: 'user-B', id: 'g2', updatedAt: new Date('2024-01-01') }),
    ];
    const { service } = createService({ grants });
    const result = await service.users({ page: 1, limit: 1 });
    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(2);
    expect(result.limit).toBe(1);
  });

  it('filters by keyword on userId when user has no name/email', async () => {
    const grants = [
      makeGrant({ principalId: 'alice-uuid', id: 'g1' }),
      makeGrant({ principalId: 'bob-uuid', id: 'g2' }),
    ];
    const { service } = createService({ grants });
    const result = await service.users({ keyword: 'alice' });
    expect(result.data).toHaveLength(1);
    expect(result.data[0].userId).toBe('alice-uuid');
  });

  it('sorts by categoryCount descending', async () => {
    const grants = [
      makeGrant({ principalId: 'user-A', id: 'g1' }),
      makeGrant({ principalId: 'user-B', id: 'g2' }),
      makeGrant({ principalId: 'user-B', id: 'g3', categoryId: 'cat-2' }),
    ];
    const { service, categoryRepo } = createService({ grants });
    categoryRepo.find.mockResolvedValue([
      makeCategory({ id: 'cat-1' }),
      makeCategory({ id: 'cat-2' }),
    ]);
    const result = await service.users({ sortBy: 'categoryCount', sortOrder: 'desc' });
    expect(result.data[0].userId).toBe('user-B');
  });

  it('limits category preview to at most 3 categories', async () => {
    const grants = ['c1', 'c2', 'c3', 'c4'].map((id, i) =>
      makeGrant({ principalId: 'user-1', categoryId: id, id: `g${i}` }),
    );
    const { service, categoryRepo } = createService({ grants });
    categoryRepo.find.mockResolvedValue(
      ['c1', 'c2', 'c3', 'c4'].map((id) => makeCategory({ id, name: id })),
    );
    const result = await service.users({});
    expect(result.data[0].categories).toHaveLength(3);
    expect(result.data[0].categoryCount).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// userGrants()
// ---------------------------------------------------------------------------

describe('CategoryAccessService.userGrants', () => {
  it('returns empty array when user has no grants', async () => {
    const { service } = createService({ grants: [] });
    const result = await service.userGrants('user-1');
    expect(result).toEqual([]);
  });

  it('includes category details on each grant', async () => {
    const { service } = createService({ grants: [makeGrant()] });
    const result = await service.userGrants('user-1');
    expect(result[0]).toMatchObject({
      category: { id: 'cat-1', name: 'News', isActive: true },
    });
  });

  it('skips grants with a missing category', async () => {
    const { service, categoryRepo } = createService({ grants: [makeGrant()] });
    categoryRepo.find.mockResolvedValue([]); // no category
    const result = await service.userGrants('user-1');
    expect(result).toHaveLength(0);
  });

  it('sorts grants alphabetically by category name', async () => {
    const grants = [
      makeGrant({ id: 'g1', categoryId: 'cat-z' }),
      makeGrant({ id: 'g2', categoryId: 'cat-a' }),
    ];
    const { service, categoryRepo } = createService({ grants });
    categoryRepo.find.mockResolvedValue([
      makeCategory({ id: 'cat-z', name: 'Zebra' }),
      makeCategory({ id: 'cat-a', name: 'Apple' }),
    ]);
    const result = await service.userGrants('user-1');
    expect(result[0].category.name).toBe('Apple');
    expect(result[1].category.name).toBe('Zebra');
  });
});

// ---------------------------------------------------------------------------
// categoryGrants()
// ---------------------------------------------------------------------------

describe('CategoryAccessService.categoryGrants', () => {
  it('throws NotFoundException when category does not exist', async () => {
    const { service } = createService({ category: null });
    await expect(service.categoryGrants('cat-1')).rejects.toThrow(NotFoundException);
  });

  it('returns grants for an existing category', async () => {
    const { service } = createService({ grants: [makeGrant()] });
    const result = await service.categoryGrants('cat-1');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ category: { id: 'cat-1' } });
  });

  it('returns empty array when no grants exist for the category', async () => {
    const { service } = createService({ grants: [] });
    const result = await service.categoryGrants('cat-1');
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// addGrants()
// ---------------------------------------------------------------------------

describe('CategoryAccessService.addGrants', () => {
  it('throws NotFoundException when one or more categories are not active', async () => {
    const { service } = createService({ activeCount: 0 });
    await expect(service.addGrants('user-1', ['cat-1'], 'admin-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('deduplicates category ids before inserting', async () => {
    const { service, insertQb } = createService({ activeCount: 1 });
    await service.addGrants('user-1', ['cat-1', 'cat-1', 'cat-1'], 'admin-1');
    const valuesArg: unknown[] = (insertQb.values as jest.Mock).mock.calls[0][0] as unknown[];
    expect(valuesArg).toHaveLength(1);
  });

  it('uses orIgnore so existing grants are not duplicated', async () => {
    const { service, insertQb } = createService({ activeCount: 1 });
    await service.addGrants('user-1', ['cat-1'], 'admin-1');
    expect(insertQb.orIgnore).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// removeGrant()
// ---------------------------------------------------------------------------

describe('CategoryAccessService.removeGrant', () => {
  it('throws NotFoundException when the grant does not exist', async () => {
    const { service } = createService({ deleteAffected: 0 });
    await expect(service.removeGrant('user-1', 'cat-1')).rejects.toThrow(NotFoundException);
  });

  it('resolves without error when the grant exists', async () => {
    const { service } = createService({ deleteAffected: 1 });
    await expect(service.removeGrant('user-1', 'cat-1')).resolves.toBeUndefined();
  });
});
