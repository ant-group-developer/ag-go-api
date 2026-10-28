import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListProjectAuditQueryDto } from './list-project-audit-query.dto';

async function failedFields(dto: object): Promise<string[]> {
  return (await validate(dto)).map((error) => error.property);
}

describe('ListProjectAuditQueryDto', () => {
  it('applies default pageSize 50 and accepts empty input', async () => {
    const dto = plainToInstance(ListProjectAuditQueryDto, {});
    expect(await failedFields(dto)).toEqual([]);
    expect(dto.pageSize).toBe(50);
  });

  it('accepts valid page and pageSize', async () => {
    const dto = plainToInstance(ListProjectAuditQueryDto, { page: '2', pageSize: '25' });
    expect(await failedFields(dto)).toEqual([]);
    expect(dto.page).toBe(2);
    expect(dto.pageSize).toBe(25);
  });

  it('rejects pageSize exceeding 100 or below 1', async () => {
    const tooLarge = plainToInstance(ListProjectAuditQueryDto, { pageSize: '101' });
    expect(await failedFields(tooLarge)).toContain('pageSize');

    const tooSmall = plainToInstance(ListProjectAuditQueryDto, { pageSize: '0' });
    expect(await failedFields(tooSmall)).toContain('pageSize');
  });
});
