import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { TagEntity } from '../../database/entities/tag.entity';
import { TagsService } from './tags.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => () => undefined,
}));
jest.mock('uuid', () => ({ v7: () => 'generated-uuid' }));

function createService(overrides: Partial<Record<keyof Repository<TagEntity>, jest.Mock>> = {}) {
  const repository = {
    findOne: jest.fn(),
    save: jest.fn((tag: TagEntity) => Promise.resolve(tag)),
    remove: jest.fn(),
    query: jest.fn(),
    ...overrides,
  };
  return {
    repository,
    service: new TagsService(repository as unknown as Repository<TagEntity>),
  };
}

const tag = { id: 'tag-1', name: 'Du lịch', normalizedName: 'du lịch', createdBy: 'u1' };

describe('TagsService.update', () => {
  it('renames the tag and refreshes the normalized name', async () => {
    const { service, repository } = createService();
    repository.findOne.mockResolvedValueOnce({ ...tag }).mockResolvedValueOnce(null);

    await expect(service.update('tag-1', { name: '  Ẩm Thực ' })).resolves.toMatchObject({
      name: 'Ẩm Thực',
      normalizedName: 'ẩm thực',
    });
  });

  it('rejects a name used by another tag', async () => {
    const { service, repository } = createService();
    repository.findOne.mockResolvedValueOnce({ ...tag }).mockResolvedValueOnce({ id: 'tag-2' });

    await expect(service.update('tag-1', { name: 'Ẩm thực' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('throws when the tag does not exist', async () => {
    const { service, repository } = createService();
    repository.findOne.mockResolvedValueOnce(null);

    await expect(service.update('missing', { name: 'x' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('TagsService.remove', () => {
  it('deletes an unused tag', async () => {
    const { service, repository } = createService();
    repository.findOne.mockResolvedValueOnce({ ...tag });
    repository.query.mockResolvedValueOnce([{ count: 0 }]);

    await service.remove('tag-1');

    expect(repository.remove).toHaveBeenCalledWith(expect.objectContaining({ id: 'tag-1' }));
  });

  it('refuses to delete a tag attached to projects', async () => {
    const { service, repository } = createService();
    repository.findOne.mockResolvedValueOnce({ ...tag });
    repository.query.mockResolvedValueOnce([{ count: 2 }]);

    await expect(service.remove('tag-1')).rejects.toBeInstanceOf(ConflictException);
    expect(repository.remove).not.toHaveBeenCalled();
  });
});
