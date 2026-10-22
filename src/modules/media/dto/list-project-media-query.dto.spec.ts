import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListProjectMediaQueryDto } from './list-project-media-query.dto';

async function failedFields(dto: object): Promise<string[]> {
  return (await validate(dto)).map((error) => error.property);
}

describe('ListProjectMediaQueryDto', () => {
  it('applies default limit 50 and accepts empty input', async () => {
    const dto = plainToInstance(ListProjectMediaQueryDto, {});
    expect(await failedFields(dto)).toEqual([]);
    expect(dto.limit).toBe(50);
  });

  it('accepts valid cursor and limit', async () => {
    const dto = plainToInstance(ListProjectMediaQueryDto, {
      cursor: 'cursor-token-123',
      limit: '20',
    });
    expect(await failedFields(dto)).toEqual([]);
    expect(dto.cursor).toBe('cursor-token-123');
    expect(dto.limit).toBe(20);
  });

  it('rejects limit exceeding 100 or below 1', async () => {
    const tooLarge = plainToInstance(ListProjectMediaQueryDto, { limit: '101' });
    expect(await failedFields(tooLarge)).toContain('limit');

    const tooSmall = plainToInstance(ListProjectMediaQueryDto, { limit: '0' });
    expect(await failedFields(tooSmall)).toContain('limit');
  });

  it('rejects cursor exceeding 500 characters', async () => {
    const dto = plainToInstance(ListProjectMediaQueryDto, { cursor: 'a'.repeat(501) });
    expect(await failedFields(dto)).toContain('cursor');
  });
});
