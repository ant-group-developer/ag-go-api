import ExcelJS from 'exceljs';
import { buildWorkbook, sheet } from './payment-excel';

describe('buildWorkbook', () => {
  it('writes the title, header, rows as numbers and a total of the money columns', async () => {
    const buffer = await buildWorkbook([
      sheet({
        name: 'Danh sách chi trả',
        title: 'DANH SÁCH CHI TRẢ',
        subtitle: ['Ngày xuất: 2026-11-03'],
        total: true,
        columns: [
          { header: 'Đối tác', key: 'name' },
          { header: 'Thực lĩnh', key: 'net', money: true },
        ],
        rows: [
          { name: 'Nguyễn Văn Cường', net: 16_470_000 },
          { name: 'Nguyễn Hữu Hoàng', net: 65_250_000 },
        ],
      }),
    ]);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const worksheet = workbook.getWorksheet('Danh sách chi trả')!;
    expect(worksheet.getCell('A1').value).toBe('DANH SÁCH CHI TRẢ');
    expect(worksheet.getCell('A2').value).toBe('Ngày xuất: 2026-11-03');
    expect(worksheet.getRow(4).values).toEqual([undefined, 'Đối tác', 'Thực lĩnh']);
    expect(worksheet.getCell('B5').value).toBe(16_470_000);
    expect(worksheet.getCell('B5').numFmt).toBe('#,##0');
    expect(worksheet.getRow(7).values).toEqual([undefined, 'Tổng cộng', 81_720_000]);
  });
});
