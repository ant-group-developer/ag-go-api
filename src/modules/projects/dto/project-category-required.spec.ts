import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateProjectDto } from './create-project.dto';
import { UpdateProjectDto } from './update-project.dto';

const categoryId = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const folderId = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a6c';

async function failedFields(dto: object): Promise<string[]> {
  return (await validate(dto)).map((error) => error.property);
}

describe('Project category is required', () => {
  it('rejects a new project without a category', async () => {
    const dto = plainToInstance(CreateProjectDto, { folderId, name: 'Villa' });

    expect(await failedFields(dto)).toEqual(['categoryId']);
  });

  it('accepts a new project with a category', async () => {
    const dto = plainToInstance(CreateProjectDto, { folderId, name: 'Villa', categoryId });

    expect(await failedFields(dto)).toEqual([]);
  });

  it('keeps the category when an update leaves it out, but cannot clear it', async () => {
    expect(await failedFields(plainToInstance(UpdateProjectDto, { name: 'Villa' }))).toEqual([]);
    expect(await failedFields(plainToInstance(UpdateProjectDto, { categoryId: null }))).toEqual([
      'categoryId',
    ]);
  });
});
