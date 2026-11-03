import ExcelJS from 'exceljs';

/**
 * Excel files of the payments module (FR-$-05, spec 6.7): one or more sheets, each a title, a
 * header row and the rows; money columns as whole-đồng numbers formatted `#,##0`, a total row
 * summing them.
 */

export type ExcelColumn<R> = {
  header: string;
  key: keyof R & string;
  width?: number;
  /** Whole đồng: number format and summed on the total row. */
  money?: boolean;
};

export type ExcelSheet<R> = {
  name: string;
  title: string;
  /** Lines under the title (filters, date of the export). */
  subtitle?: string[];
  columns: Array<ExcelColumn<R>>;
  rows: readonly R[];
  /** Adds a total row under the rows (money columns only). */
  total?: boolean;
};

const MONEY_FORMAT = '#,##0';

function addSheet<R>(workbook: ExcelJS.Workbook, sheet: ExcelSheet<R>) {
  const worksheet = workbook.addWorksheet(sheet.name.slice(0, 31));
  worksheet.columns = sheet.columns.map((column) => ({ width: column.width ?? 16 }));
  const titleRow = worksheet.addRow([sheet.title]);
  titleRow.font = { bold: true, size: 14 };
  for (const line of sheet.subtitle ?? []) {
    worksheet.addRow([line]).font = { italic: true };
  }
  worksheet.addRow([]);
  const header = worksheet.addRow(sheet.columns.map((column) => column.header));
  header.font = { bold: true };
  header.alignment = { vertical: 'middle', wrapText: true };
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7EEF7' } };
    cell.border = { bottom: { style: 'thin' } };
  });
  const headerRow = header.number;
  for (const row of sheet.rows) {
    worksheet.addRow(sheet.columns.map((column) => (row[column.key] ?? null) as ExcelJS.CellValue));
  }
  if (sheet.total && sheet.rows.length > 0) {
    const values = sheet.columns.map((column, index) => {
      if (index === 0) {
        return 'Tổng cộng';
      }
      if (!column.money) {
        return null;
      }
      return sheet.rows.reduce((sum, row) => sum + Number(row[column.key] ?? 0), 0);
    });
    worksheet.addRow(values).font = { bold: true };
  }
  sheet.columns.forEach((column, index) => {
    if (column.money) {
      worksheet.getColumn(index + 1).numFmt = MONEY_FORMAT;
    }
  });
  worksheet.views = [{ state: 'frozen', ySplit: headerRow }];
}

export async function buildWorkbook(sheets: ReadonlyArray<ExcelSheet<never>>): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'AG Go';
  workbook.created = new Date();
  for (const sheet of sheets) {
    addSheet(workbook, sheet);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** A sheet typed by its rows, accepted by buildWorkbook. */
export function sheet<R>(definition: ExcelSheet<R>): ExcelSheet<never> {
  return definition as unknown as ExcelSheet<never>;
}
