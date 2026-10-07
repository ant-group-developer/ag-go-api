import {
  downloadZipFilename,
  formatDownloadTimestamp,
  projectFolderName,
  sanitizeFilename,
  ZipEntryNamer,
} from './download-naming';

describe('download naming', () => {
  // 07:30:05 UTC is 14:30:05 in Vietnam (UTC+7).
  const createdAt = new Date('2026-10-07T07:30:05Z');

  it('formats the timestamp as YYYYMMddHHmmss in Vietnam time', () => {
    expect(formatDownloadTimestamp(createdAt)).toBe('20261007143005');
    expect(formatDownloadTimestamp(new Date('2026-12-31T17:00:00Z'))).toBe('20270101000000');
  });

  it('keeps Vietnamese letters and replaces reserved characters', () => {
    expect(sanitizeFilename('  Khách sạn: "Đà Nẵng"/2026?  ')).toBe('Khách sạn_ _Đà Nẵng_2026_');
    expect(sanitizeFilename('trailing dots...')).toBe('trailing dots');
  });

  it('joins the folder and project names', () => {
    expect(projectFolderName('Hà Nội', 'Dự án A')).toBe('Hà Nội - Dự án A');
    expect(projectFolderName(null, 'Dự án A')).toBe('Dự án A');
  });

  it('names a single-project archive after its folder and project', () => {
    expect(
      downloadZipFilename([{ name: 'Dự án A', folderName: 'Hà Nội' }], createdAt, 'download-x'),
    ).toBe('Hà Nội - Dự án A - 20261007143005.zip');
  });

  it('gives a multi-project archive a generic name with the project count', () => {
    expect(
      downloadZipFilename(
        [
          { name: 'A', folderName: 'X' },
          { name: 'B', folderName: 'Y' },
        ],
        createdAt,
        'download-x',
      ),
    ).toBe('Dự án (2) - 20261007143005.zip');
  });

  it('falls back when the job has no project left', () => {
    expect(downloadZipFilename([], createdAt, 'download-x')).toBe(
      'download-x - 20261007143005.zip',
    );
  });

  it('numbers repeated entry names within the same folder', () => {
    const namer = new ZipEntryNamer();
    expect(namer.next(null, 'a.jpg')).toBe('a.jpg');
    expect(namer.next(null, 'A.jpg')).toBe('A (2).jpg');
    expect(namer.next('Hà Nội - Dự án', 'a.jpg')).toBe('Hà Nội - Dự án/a.jpg');
    expect(namer.next(null, 'a.jpg')).toBe('a (3).jpg');
    expect(namer.next(null, 'README')).toBe('README');
    expect(namer.next(null, 'README')).toBe('README (2)');
  });
});
