import { ConflictException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { CategoryEntity } from '../../database/entities/category.entity';
import type { ProjectEntity } from '../../database/entities/project.entity';
import { CategoriesService } from './categories.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => () => undefined,
}));
jest.mock('uuid', () => ({ v7: () => 'generated-uuid' }));

function createService(duplicate: unknown = null) {
  const queryBuilder = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(duplicate),
  };
  const categoryRepository = {
    findOne: jest.fn().mockResolvedValue({
      id: 'cat-1',
      name: 'Biển',
      slug: 'bien',
      description: 'Cũ',
      sortOrder: 1,
      isActive: true,
    }),
    save: jest.fn((category: CategoryEntity) => Promise.resolve(category)),
    remove: jest.fn(),
    createQueryBuilder: jest.fn(() => queryBuilder),
  };
  const projectRepository = { count: jest.fn().mockResolvedValue(0) };
  return {
    queryBuilder,
    categoryRepository,
    projectRepository,
    service: new CategoriesService(
      categoryRepository as unknown as Repository<CategoryEntity>,
      projectRepository as unknown as Repository<ProjectEntity>,
    ),
  };
}

describe('CategoriesService.update', () => {
  it('updates provided fields and excludes itself from the duplicate check', async () => {
    const { service, queryBuilder } = createService();

    await expect(
      service.update('cat-1', { name: 'Núi', slug: 'Nui', description: '  ' }),
    ).resolves.toMatchObject({ name: 'Núi', slug: 'nui', description: null, sortOrder: 1 });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('category.id <> :excludeId', {
      excludeId: 'cat-1',
    });
  });

  it('rejects a name or slug used by another category', async () => {
    const { service, categoryRepository } = createService({ id: 'cat-2' });

    await expect(service.update('cat-1', { name: 'Núi' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(categoryRepository.save).not.toHaveBeenCalled();
  });
});

describe('CategoriesService.remove', () => {
  it('deletes an unused category', async () => {
    const { service, categoryRepository } = createService();

    await service.remove('cat-1');

    expect(categoryRepository.remove).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cat-1' }),
    );
  });

  it('refuses to delete a category assigned to projects', async () => {
    const { service, categoryRepository, projectRepository } = createService();
    projectRepository.count.mockResolvedValue(3);

    await expect(service.remove('cat-1')).rejects.toBeInstanceOf(ConflictException);
    expect(categoryRepository.remove).not.toHaveBeenCalled();
  });
});
