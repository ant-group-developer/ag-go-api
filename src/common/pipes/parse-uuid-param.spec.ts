import { BadRequestException, ParseUUIDPipe } from '@nestjs/common';

describe('ParseUUIDPipe', () => {
  const pipe = new ParseUUIDPipe();

  it('accepts valid UUID v4 and v7', async () => {
    const v4 = '800aa999-9172-4235-91c4-e99a6d6b3150';
    const v7 = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
    expect(await pipe.transform(v4, { type: 'param', data: 'id' })).toBe(v4);
    expect(await pipe.transform(v7, { type: 'param', data: 'id' })).toBe(v7);
  });

  it('rejects invalid UUID strings with BadRequestException', async () => {
    await expect(pipe.transform('not-a-uuid', { type: 'param', data: 'id' })).rejects.toThrow(
      BadRequestException,
    );

    await expect(pipe.transform('12345', { type: 'param', data: 'id' })).rejects.toThrow(
      BadRequestException,
    );
  });
});
