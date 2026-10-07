import { ConflictException } from '@nestjs/common';
import { CategoriesService } from './categories.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => () => undefined,
}));
// The ESM build of uuid does not load under ts-jest; these tests create no ids with it.
jest.mock('uuid', () => ({ v7: () => '00000000-0000-7000-9000-000000000000' }));

describe('CategoriesService.remove', () => {
  const category = { id: 'news', name: 'News', isActive: true };

  function createService(projectCount: number, removeError?: unknown) {
    const categoryRepository = {
      findOne: jest.fn().mockResolvedValue(category),
      remove: removeError
        ? jest.fn().mockRejectedValue(removeError)
        : jest.fn().mockResolvedValue(category),
    };
    const projectRepository = { count: jest.fn().mockResolvedValue(projectCount) };
    return {
      service: new CategoriesService(categoryRepository as never, projectRepository as never),
      categoryRepository,
    };
  }

  it('refuses a category still used by projects', async () => {
    const { service, categoryRepository } = createService(3);

    await expect(service.remove('news')).rejects.toThrow(ConflictException);
    expect(categoryRepository.remove).not.toHaveBeenCalled();
  });

  it('answers 409 when a project takes the category right before the delete', async () => {
    const { service } = createService(0, { driverError: { code: '23503' } });

    await expect(service.remove('news')).rejects.toThrow(ConflictException);
  });

  it('lets other database errors through', async () => {
    const failure = new Error('connection lost');
    const { service } = createService(0, failure);

    await expect(service.remove('news')).rejects.toBe(failure);
  });

  it('deletes an unused category', async () => {
    const { service, categoryRepository } = createService(0);

    await expect(service.remove('news')).resolves.toBeUndefined();
    expect(categoryRepository.remove).toHaveBeenCalledWith(category);
  });
});
