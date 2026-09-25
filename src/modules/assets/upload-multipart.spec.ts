import { describePartMismatch, multipartLayout } from './upload-multipart';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

describe('multipartLayout', () => {
  it('uses 16 MiB parts for files up to about 156 GiB', () => {
    expect(multipartLayout(6 * GIB)).toEqual({ partSize: 16 * MIB, partCount: 384 });
    expect(multipartLayout(100 * MIB + 1)).toEqual({ partSize: 16 * MIB, partCount: 7 });
  });

  it('grows the part size so no file needs more than 10,000 parts', () => {
    const size = 500 * GIB;
    const { partSize, partCount } = multipartLayout(size);

    expect(partCount).toBeLessThanOrEqual(10_000);
    expect(partSize % MIB).toBe(0);
    expect(partSize * partCount).toBeGreaterThanOrEqual(size);
  });
});

describe('describePartMismatch', () => {
  const size = 40 * MIB;
  const complete = [
    { partNumber: 1, sizeBytes: 16 * MIB },
    { partNumber: 2, sizeBytes: 16 * MIB },
    { partNumber: 3, sizeBytes: 8 * MIB },
  ];

  it('accepts every part with the expected size', () => {
    expect(describePartMismatch(complete, size)).toBeNull();
  });

  it('reports missing parts', () => {
    expect(describePartMismatch([complete[0], complete[2]], size)).toBe('missing parts 2');
  });

  it('reports parts with the wrong size', () => {
    expect(
      describePartMismatch([complete[0], complete[1], { partNumber: 3, sizeBytes: 1 }], size),
    ).toBe('parts with the wrong size 3');
  });

  it('reports parts beyond the declared size', () => {
    expect(describePartMismatch([...complete, { partNumber: 4, sizeBytes: 1 }], size)).toBe(
      'unexpected parts 4',
    );
  });
});
