import { parseCsvUpload } from './csv-import';

function file(content: string, originalname = 'data.csv') {
  const buffer = Buffer.from(content, 'utf8');
  return {
    buffer,
    mimetype: 'text/csv',
    originalname,
    size: buffer.length,
  };
}

describe('parseCsvUpload', () => {
  const headers = ['Tên quốc gia', 'Code', 'Flag'] as const;

  it('parses UTF-8 BOM and quoted values', () => {
    const parsed = parseCsvUpload(
      file(
        '\uFEFFTên quốc gia,Code,Flag\n"Congo, Democratic Republic",CD,https://example.com/cd.png',
      ),
      headers,
    );

    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toEqual([
      {
        row: 2,
        values: {
          'Tên quốc gia': 'Congo, Democratic Republic',
          Code: 'CD',
          Flag: 'https://example.com/cd.png',
        },
      },
    ]);
  });

  it('rejects a non-CSV file', () => {
    const parsed = parseCsvUpload(file('name,code\nVietnam,VN', 'data.txt'), headers);

    expect(parsed.errors[0]).toMatchObject({ row: 0, field: 'file' });
  });

  it('rejects missing headers', () => {
    const parsed = parseCsvUpload(file('Name,Code,Flag\nVietnam,VN,'), headers);

    expect(parsed.errors[0]).toMatchObject({ row: 0, field: 'Header' });
  });
});
