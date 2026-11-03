import ExcelJS from 'exceljs';
import { existsSync, readFileSync } from 'node:fs';
import { D7_EXPLORATION_SURCHARGE, d7RateCard } from '../pricing-engine/d7-price-table';
import { validateRateCard, type RateCardItemData } from '../pricing-engine/rate-card';
import {
  buildRateCardWorkbook,
  normalizeName,
  parseRateCardWorkbook,
  type ExcelCategory,
} from './rate-card-excel';

const CATEGORIES: ExcelCategory[] = [
  { id: 'c-camping', name: 'Camping', slug: 'camping' },
  { id: 'c-kham-pha', name: 'Khám phá', slug: 'kham-pha' },
  { id: 'c-doi-song', name: 'Đời sống', slug: 'doi-song' },
  { id: 'c-canh', name: 'Cảnh', slug: 'canh' },
  { id: 'c-flycam', name: 'Flycam', slug: 'flycam' },
  { id: 'c-lai-xe', name: 'Lái xe', slug: 'lai-xe' },
];
const IDS = {
  camping: 'c-camping',
  'kham-pha': 'c-kham-pha',
  'doi-song': 'c-doi-song',
  canh: 'c-canh',
  flycam: 'c-flycam',
  'lai-xe': 'c-lai-xe',
};
const INFO = {
  code: 'CTV-2026',
  version: 2,
  status: 'published',
  effectiveFrom: '2026-07-15',
  effectiveTo: null,
  note: 'Khám phá +200k',
};

function sorted(items: readonly RateCardItemData[]) {
  return [...items]
    .map((item) => ({ ...item, id: undefined }))
    .sort((left, right) =>
      `${left.categoryId}|${left.level}|${left.tier}`.localeCompare(
        `${right.categoryId}|${right.level}|${right.tier}`,
      ),
    );
}

describe('rate card Excel (D7 layout)', () => {
  it('normalises product names', () => {
    expect(normalizeName('KHÁM PHÁ')).toBe('kham-pha');
    expect(normalizeName(' Đời  sống ')).toBe('doi-song');
    expect(normalizeName('Lái xe')).toBe('lai-xe');
  });

  it('exports and imports back the same card', async () => {
    const card = d7RateCard(IDS, D7_EXPLORATION_SURCHARGE);
    const buffer = await buildRateCardWorkbook(card, CATEGORIES, INFO);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      'CAMPING',
      'KHÁM PHÁ',
      'ĐỜI SỐNG',
      'CẢNH',
      'Lái xe',
      'Thông tin',
    ]);
    const exploration = workbook.getWorksheet('KHÁM PHÁ')!;
    expect(exploration.getCell('B6').value).toBe('LV1');
    expect(exploration.getCell('F9').value).toBe(1_000_000);
    expect(String(exploration.getCell('I8').value)).toContain('80.000 VNĐ/bối cảnh phát sinh');

    const parsed = await parseRateCardWorkbook(buffer, CATEGORIES);
    expect(parsed.errors).toEqual([]);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.content.durationRule).toEqual(card.durationRule);
    expect(parsed.content.levelRules).toEqual(card.levelRules);
    expect(sorted(parsed.content.items)).toEqual(sorted(card.items));
    expect(validateRateCard(parsed.content)).toEqual([]);
  });

  it('reports unknown products, broken rows and unreadable files', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('MỚI');
    sheet.getCell('B5').value = 'LV1';
    sheet.getRow(7).values = [undefined, 'STT', 'Tên sản phẩm', 'Source', 'Bối cảnh', 'Đơn giá'];
    sheet.getRow(8).values = [undefined, 'Mức 1', 'SẢN PHẨM LẠ', '70 - 100', '7 bối cảnh', 800_000];
    sheet.getRow(9).values = [undefined, 'Mức 2', 'CAMPING', '', '', 'abc'];
    const parsed = await parseRateCardWorkbook(
      Buffer.from(await workbook.xlsx.writeBuffer()),
      CATEGORIES,
    );
    expect(parsed.errors).toEqual([
      'MỚI!8: không tìm thấy danh mục "SẢN PHẨM LẠ"',
      'MỚI!9: cần Source, Bối cảnh và Đơn giá của Mức 2',
      'Không tìm thấy ô giá nào theo bố cục bảng lương CTV.',
    ]);
    expect(parsed.warnings).toEqual([
      'Không thấy yêu cầu thời lượng, dùng mặc định 80% ≥ 20s, tối thiểu 10s.',
    ]);

    const broken = await parseRateCardWorkbook(Buffer.from('not a workbook'), CATEGORIES);
    expect(broken.errors).toEqual(['Không đọc được file Excel (.xlsx).']);
  });

  // The real D7 file is a business document kept outside the repository; checked when present.
  const d7Path =
    process.env['D7_XLSX_PATH'] ?? 'E:/Tai lieu AG/AG Go/C Ly/Bảng lương ctv( chuẩn).xlsx';
  (existsSync(d7Path) ? it : it.skip)('reads the real "Bảng lương CTV (chuẩn)" file', async () => {
    const parsed = await parseRateCardWorkbook(readFileSync(d7Path), CATEGORIES);
    expect(parsed.errors).toEqual([]);
    const card = d7RateCard(IDS);
    expect(parsed.content.levelRules).toEqual(card.levelRules);
    expect(parsed.content.durationRule).toEqual(card.durationRule);
    expect(sorted(parsed.content.items)).toEqual(sorted(card.items));
  });
});
