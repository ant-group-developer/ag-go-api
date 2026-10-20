import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ListDriveImportItemsQueryDto,
  ListDriveImportsQueryDto,
} from './list-drive-imports-query.dto';

async function failedFields(dto: object): Promise<string[]> {
  return (await validate(dto)).map((error) => error.property);
}

describe('ListDriveImportsQueryDto', () => {
  it('accepts empty input', async () => {
    const dto = plainToInstance(ListDriveImportsQueryDto, {});
    expect(await failedFields(dto)).toEqual([]);
  });

  it('validates projectId as UUID', async () => {
    const valid = plainToInstance(ListDriveImportsQueryDto, {
      projectId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
    });
    expect(await failedFields(valid)).toEqual([]);

    const invalid = plainToInstance(ListDriveImportsQueryDto, {
      projectId: 'invalid-uuid-format',
    });
    expect(await failedFields(invalid)).toContain('projectId');
  });

  it('validates status against IMPORT_HISTORY_STATUS_FILTERS', async () => {
    const valid = plainToInstance(ListDriveImportsQueryDto, { status: 'active' });
    expect(await failedFields(valid)).toEqual([]);

    const invalid = plainToInstance(ListDriveImportsQueryDto, { status: 'invalid_status' });
    expect(await failedFields(invalid)).toContain('status');
  });

  it('normalizes sortOrder and validates sortBy', async () => {
    const valid = plainToInstance(ListDriveImportsQueryDto, {
      sortBy: 'createdAt',
      sortOrder: 'desc',
    });
    expect(await failedFields(valid)).toEqual([]);
    expect(valid.sortOrder).toBe('DESC');

    const invalidSort = plainToInstance(ListDriveImportsQueryDto, { sortBy: 'badColumn' });
    expect(await failedFields(invalidSort)).toContain('sortBy');
  });
});

describe('ListDriveImportItemsQueryDto', () => {
  it('validates item status and trims search string', async () => {
    const valid = plainToInstance(ListDriveImportItemsQueryDto, {
      status: 'active',
      search: '  video.mp4  ',
    });
    expect(await failedFields(valid)).toEqual([]);
    expect(valid.search).toBe('video.mp4');

    const invalidStatus = plainToInstance(ListDriveImportItemsQueryDto, { status: 'unknown' });
    expect(await failedFields(invalidStatus)).toContain('status');

    const invalidSearch = plainToInstance(ListDriveImportItemsQueryDto, {
      search: 'a'.repeat(201),
    });
    expect(await failedFields(invalidSearch)).toContain('search');
  });
});
