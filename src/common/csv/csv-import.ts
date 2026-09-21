import { parse } from 'csv-parse/sync';

export const MAX_CSV_FILE_SIZE_BYTES = 5 * 1024 * 1024;

export type CsvUploadFile = {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
};

export type CsvImportError = {
  row: number;
  field: string;
  value: string;
  reason: string;
};

export type CsvImportResult = {
  totalRows: number;
  inserted: number;
  failed: number;
  errors: CsvImportError[];
};

export type ParsedCsvRow = {
  row: number;
  values: Record<string, string>;
};

export type ParsedCsv = {
  rows: ParsedCsvRow[];
  errors: CsvImportError[];
};

type CsvRecordWithInfo = {
  record: string[];
  info: {
    lines: number;
  };
};

export function parseCsvUpload(
  file: CsvUploadFile | undefined,
  expectedHeaders: readonly string[],
): ParsedCsv {
  if (!file) {
    return failure('file', '', 'Vui lòng chọn file CSV.');
  }
  if (!file.originalname.toLocaleLowerCase().endsWith('.csv')) {
    return failure('file', file.originalname, 'Chỉ chấp nhận file có phần mở rộng .csv.');
  }
  if (file.size === 0 || file.buffer.length === 0) {
    return failure('file', file.originalname, 'File CSV không được để trống.');
  }
  if (file.size > MAX_CSV_FILE_SIZE_BYTES) {
    return failure('file', file.originalname, 'File CSV không được vượt quá 5 MB.');
  }

  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(file.buffer);
  } catch {
    return failure('file', file.originalname, 'File CSV phải sử dụng mã hóa UTF-8.');
  }

  let records: CsvRecordWithInfo[];
  try {
    records = parse(content, {
      bom: true,
      info: true,
      skip_empty_lines: true,
      skip_records_with_empty_values: true,
    }) as unknown as CsvRecordWithInfo[];
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Không thể đọc file CSV.';
    return failure('file', file.originalname, `File CSV không đúng định dạng: ${message}`);
  }

  if (records.length === 0) {
    return failure('file', file.originalname, 'File CSV không được để trống.');
  }

  const headers = records[0].record.map((header) => header.trim());
  if (
    headers.length !== expectedHeaders.length ||
    expectedHeaders.some((header) => !headers.includes(header)) ||
    new Set(headers).size !== headers.length
  ) {
    return failure(
      'Header',
      toErrorValue(headers.join(',')),
      `Header bắt buộc: ${expectedHeaders.join(', ')}.`,
    );
  }

  const rows = records.slice(1).map(({ record, info }) => ({
    row: info.lines,
    values: Object.fromEntries(
      headers.map((header, index) => [header, (record[index] ?? '').trim()]),
    ),
  }));

  if (rows.length === 0) {
    return failure('file', file.originalname, 'File CSV không có dòng dữ liệu.');
  }

  return { rows, errors: [] };
}

export function failedImportResult(totalRows: number, errors: CsvImportError[]): CsvImportResult {
  const failedRows = new Set(errors.filter((error) => error.row > 0).map((error) => error.row));
  return {
    totalRows,
    inserted: 0,
    failed: failedRows.size || (errors.length > 0 ? 1 : 0),
    errors: [...errors].sort((left, right) => left.row - right.row),
  };
}

export function successfulImportResult(totalRows: number): CsvImportResult {
  return {
    totalRows,
    inserted: totalRows,
    failed: 0,
    errors: [],
  };
}

export function toErrorValue(value: string): string {
  return value.length <= 200 ? value : `${value.slice(0, 197)}...`;
}

function failure(field: string, value: string, reason: string): ParsedCsv {
  return {
    rows: [],
    errors: [{ row: 0, field, value: toErrorValue(value), reason }],
  };
}
