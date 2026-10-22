import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListAutoJobsQueryDto, RenderJobPageQueryDto } from './render-job-page-query.dto';

async function failedFields(dto: object): Promise<string[]> {
  return (await validate(dto)).map((error) => error.property);
}

describe('RenderJobPageQueryDto', () => {
  it('accepts empty input', async () => {
    const dto = plainToInstance(RenderJobPageQueryDto, {});
    expect(await failedFields(dto)).toEqual([]);
  });

  it('validates status against AUTO_JOB_STATUS_FILTERS', async () => {
    const valid = plainToInstance(RenderJobPageQueryDto, { status: 'failed' });
    expect(await failedFields(valid)).toEqual([]);

    const invalid = plainToInstance(RenderJobPageQueryDto, { status: 'unknown_status' });
    expect(await failedFields(invalid)).toContain('status');
  });

  it('normalizes sortOrder to uppercase', async () => {
    const asc = plainToInstance(RenderJobPageQueryDto, { sortOrder: 'asc' });
    expect(await failedFields(asc)).toEqual([]);
    expect(asc.sortOrder).toBe('ASC');

    const desc = plainToInstance(RenderJobPageQueryDto, { sortOrder: 'DESC' });
    expect(await failedFields(desc)).toEqual([]);
    expect(desc.sortOrder).toBe('DESC');

    const invalid = plainToInstance(RenderJobPageQueryDto, { sortOrder: 'sideways' });
    expect(await failedFields(invalid)).toContain('sortOrder');
  });

  it('validates sortBy against AUTO_JOB_SORT_FIELDS', async () => {
    const valid = plainToInstance(RenderJobPageQueryDto, { sortBy: 'createdAt' });
    expect(await failedFields(valid)).toEqual([]);

    const invalid = plainToInstance(RenderJobPageQueryDto, { sortBy: 'nonExistent' });
    expect(await failedFields(invalid)).toContain('sortBy');
  });

  it('rejects search over 200 characters and trims valid search', async () => {
    const valid = plainToInstance(RenderJobPageQueryDto, { search: '  my job  ' });
    expect(await failedFields(valid)).toEqual([]);
    expect(valid.search).toBe('my job');

    const invalid = plainToInstance(RenderJobPageQueryDto, { search: 'a'.repeat(201) });
    expect(await failedFields(invalid)).toContain('search');
  });
});

describe('ListAutoJobsQueryDto', () => {
  it('accepts valid projectId UUID', async () => {
    const dto = plainToInstance(ListAutoJobsQueryDto, {
      projectId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
    });
    expect(await failedFields(dto)).toEqual([]);
  });

  it('rejects invalid projectId non-UUID', async () => {
    const dto = plainToInstance(ListAutoJobsQueryDto, {
      projectId: 'not-a-valid-uuid',
    });
    expect(await failedFields(dto)).toContain('projectId');
  });
});
