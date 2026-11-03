import ExcelJS from 'exceljs';
import { DEFAULT_DURATION_RULE, type DurationRule } from '../pricing-engine/durations';
import {
  CTV_LEVELS,
  type CtvLevel,
  type LevelRuleData,
  type RateCardContent,
  type RateCardItemData,
} from '../pricing-engine/rate-card';

/**
 * Excel import / export of a rate card in the layout of "Bảng lương CTV (chuẩn)" (D7, spec 2.1.1):
 * one sheet per tiered product with an LV1 / LV2 / LV3 block of "Mức 1–3" rows and the extra-scene
 * note beside each header; a "Lái xe" sheet with the per-source products. A "Thông tin" sheet
 * carries the version details on export and is ignored on import.
 */

export type ExcelCategory = { id: string; name: string; slug: string };

export const MAX_RATE_CARD_FILE_SIZE_BYTES = 5 * 1024 * 1024;
const PER_SOURCE_SHEET = 'Lái xe';
const INFO_SHEET = 'Thông tin';

/** "KHÁM PHÁ" → "kham-pha", "Đời sống" → "doi-song". */
export function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function formatMoney(value: number): string {
  return value.toLocaleString('de-DE');
}

function durationText(rule: DurationRule): string {
  const preferred = Math.round(rule.preferredRatio * 100);
  return `${preferred}% >= ${rule.preferredSeconds}s/1source\n${100 - preferred}% >= ${rule.minSeconds}s/1source`;
}

function sheetName(name: string, used: Set<string>): string {
  const base =
    name
      .replace(/[\\/*?:[\]]/g, ' ')
      .slice(0, 31)
      .trim() || 'Sheet';
  let candidate = base;
  for (let index = 2; used.has(candidate.toLowerCase()); index += 1) {
    candidate = `${base.slice(0, 28)} ${index}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

export type ExportInfo = {
  code: string;
  version: number;
  status: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  note: string | null;
};

/** Workbook of a rate card in the D7 layout. */
export async function buildRateCardWorkbook(
  content: RateCardContent,
  categories: readonly ExcelCategory[],
  info: ExportInfo,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'AG Go';
  const byId = new Map(categories.map((category) => [category.id, category]));
  const used = new Set<string>([PER_SOURCE_SHEET.toLowerCase(), INFO_SHEET.toLowerCase()]);
  const rules = new Map(content.levelRules.map((rule) => [rule.level, rule]));
  const bold = { bold: true };

  const tierCategories = [
    ...new Set(
      content.items.filter((item) => item.pricingType === 'tier').map((item) => item.categoryId),
    ),
  ];
  for (const categoryId of tierCategories) {
    const productName = (byId.get(categoryId)?.name ?? categoryId).toUpperCase();
    const sheet = workbook.addWorksheet(sheetName(productName, used));
    sheet.columns = [
      { width: 4 },
      { width: 10 },
      { width: 18 },
      { width: 14 },
      { width: 14 },
      { width: 22 },
      { width: 4 },
      { width: 22 },
      { width: 20 },
      { width: 20 },
      { width: 20 },
      { width: 20 },
    ];
    sheet.mergeCells('B1:L3');
    Object.assign(sheet.getCell('B1'), {
      value: productName,
      font: { bold: true, size: 16 },
      alignment: { horizontal: 'center', vertical: 'middle' },
    });
    sheet.mergeCells('H4:I4');
    sheet.getCell('H4').value = 'Yêu cầu chung thời lượng';
    sheet.getCell('J4').value = durationText(content.durationRule);
    sheet.getCell('J4').alignment = { wrapText: true };
    let row = 6;
    for (const level of CTV_LEVELS) {
      const tiers = content.items
        .filter(
          (item) =>
            item.pricingType === 'tier' && item.categoryId === categoryId && item.level === level,
        )
        .sort((left, right) => (left.tier as number) - (right.tier as number));
      if (tiers.length === 0) {
        continue;
      }
      sheet.getCell(`B${row}`).value = level;
      sheet.getCell(`B${row}`).font = bold;
      row += 2;
      const header = sheet.getRow(row);
      header.values = [
        undefined,
        'STT',
        'Tên sản phẩm',
        'Source',
        'Bối cảnh',
        'Đơn giá (vnd/ sản phẩm)',
        undefined,
        'Note ',
      ];
      header.font = bold;
      const rule = rules.get(level);
      if (rule) {
        sheet.mergeCells(`I${row}:L${row + 2}`);
        Object.assign(sheet.getCell(`I${row}`), {
          value: `Đối với mỗi bối cảnh phát sinh vượt quá MỨC ${tiers.length}, Bên A có trách nhiệm thanh toán bổ sung cho Bên B với mức phí ${formatMoney(rule.extraScenePrice)} VNĐ/bối cảnh phát sinh. Tối thiểu 1 bối cảnh ${rule.extraSceneMinSources} source`,
          alignment: { wrapText: true, vertical: 'top' },
        });
      }
      for (const item of tiers) {
        row += 1;
        sheet.getRow(row).values = [
          undefined,
          `Mức ${item.tier}`,
          productName,
          item.sourceMax === null ? `${item.sourceMin}` : `${item.sourceMin} - ${item.sourceMax}`,
          `${item.sceneMin} bối cảnh`,
          item.price,
        ];
        sheet.getCell(`F${row}`).numFmt = '#,##0';
      }
      row += 3;
    }
  }

  const perSource = content.items.filter((item) => item.pricingType === 'per_source');
  if (perSource.length > 0) {
    const sheet = workbook.addWorksheet(PER_SOURCE_SHEET);
    sheet.columns = [{ width: 6 }, { width: 20 }, { width: 10 }, { width: 22 }, { width: 16 }];
    sheet.getRow(1).values = [
      'STT',
      'Tên sản phẩm',
      'Source',
      'Đơn giá (vnd/sản phẩm)',
      'Yêu cầu chung thời lượng',
    ];
    sheet.getRow(1).font = bold;
    sheet.mergeCells('E1:F1');
    perSource.forEach((item, index) => {
      const seconds = item.minSourceSeconds ?? 0;
      sheet.getRow(index + 2).values = [
        index + 1,
        byId.get(item.categoryId)?.name ?? item.categoryId,
        1,
        item.price,
        seconds % 60 === 0 ? `${seconds / 60} phút / 1 source` : `${seconds} giây / 1 source`,
      ];
      sheet.getCell(`D${index + 2}`).numFmt = '#,##0';
    });
  }

  const sheet = workbook.addWorksheet(INFO_SHEET);
  sheet.columns = [{ width: 20 }, { width: 60 }];
  sheet.addRows([
    ['Mã bảng giá', info.code],
    ['Phiên bản', info.version],
    ['Trạng thái', info.status],
    ['Hiệu lực từ', info.effectiveFrom],
    ['Hiệu lực đến', info.effectiveTo ?? ''],
    ['Ghi chú', info.note ?? ''],
  ]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export type ParsedRateCard = {
  content: RateCardContent;
  errors: string[];
  warnings: string[];
};

function text(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'object') {
    if ('richText' in value) {
      return value.richText.map((part) => part.text).join('');
    }
    if ('result' in value) {
      return text(value.result as ExcelJS.CellValue);
    }
    if ('text' in value) {
      return String(value.text);
    }
    if (value instanceof Date) {
      return value.toISOString().slice(0, 10);
    }
    return '';
  }
  return String(value);
}

/** 800000, "800.000", "800,000đ" → 800000; null when not a whole amount. */
function money(value: ExcelJS.CellValue): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  const raw = text(value).replace(/[.,\s]|đ|vnd|vnđ/gi, '');
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

function columnOf(row: ExcelJS.Row, pattern: RegExp): number | null {
  let found: number | null = null;
  row.eachCell((cell, column) => {
    if (found === null && pattern.test(text(cell.value).trim())) {
      found = column;
    }
  });
  return found;
}

function rowText(row: ExcelJS.Row): string {
  const parts: string[] = [];
  row.eachCell((cell) => {
    parts.push(text(cell.value));
  });
  return parts.join(' ');
}

function parseDurationRule(value: string): DurationRule | null {
  const match = /(\d+)\s*%\s*>=?\s*(\d+)\s*s[\s\S]*?(\d+)\s*%\s*>=?\s*(\d+)\s*s/i.exec(value);
  if (!match) {
    return null;
  }
  return {
    preferredRatio: Number(match[1]) / 100,
    preferredSeconds: Number(match[2]),
    minSeconds: Number(match[4]),
  };
}

function parseLevelNote(value: string): { price: number; minSources: number } | null {
  const price = /([\d.,]+)\s*VNĐ\s*\/\s*bối cảnh/i.exec(value);
  const minSources = /tối thiểu\s*1\s*bối cảnh\s*(\d+)\s*source/i.exec(value);
  if (!price || !minSources) {
    return null;
  }
  return { price: Number(price[1].replace(/[.,]/g, '')), minSources: Number(minSources[1]) };
}

function parseSeconds(value: string): number | null {
  const minutes = /(\d+)\s*phút/i.exec(value);
  if (minutes) {
    return Number(minutes[1]) * 60;
  }
  const seconds = /(\d+)\s*(giây|s)\b/i.exec(value);
  return seconds ? Number(seconds[1]) : null;
}

/**
 * Reads a workbook in the D7 layout. Products are matched to categories by unaccented name or
 * slug; problems are returned as errors (the import is all or nothing) or warnings.
 */
export async function parseRateCardWorkbook(
  buffer: Buffer,
  categories: readonly ExcelCategory[],
): Promise<ParsedRateCard> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    return {
      content: { durationRule: DEFAULT_DURATION_RULE, items: [], levelRules: [] },
      errors: ['Không đọc được file Excel (.xlsx).'],
      warnings,
    };
  }
  const byName = new Map<string, ExcelCategory>();
  for (const category of categories) {
    byName.set(normalizeName(category.slug), category);
    byName.set(normalizeName(category.name), category);
  }
  const resolve = (name: string, where: string): string | null => {
    const category = byName.get(normalizeName(name));
    if (!category) {
      errors.push(`${where}: không tìm thấy danh mục "${name.trim()}"`);
      return null;
    }
    return category.id;
  };

  const items: RateCardItemData[] = [];
  const levelRules = new Map<CtvLevel, LevelRuleData>();
  let durationRule: DurationRule | null = null;

  for (const sheet of workbook.worksheets) {
    if (sheet.name.trim().toLowerCase() === INFO_SHEET.toLowerCase()) {
      continue;
    }
    let level: CtvLevel | null = null;
    let tierColumns: Record<'stt' | 'name' | 'source' | 'scene' | 'price', number> | null = null;
    let perSourceColumns: { name: number; price: number } | null = null;
    let perSourceSeconds: number | null = null;
    let inPerSource = false;
    sheet.eachRow((row, rowNumber) => {
      const where = `${sheet.name}!${rowNumber}`;
      const all = rowText(row);
      if (!durationRule) {
        durationRule = parseDurationRule(all);
      }
      perSourceSeconds ??= /source/i.test(all) && /phút|giây/i.test(all) ? parseSeconds(all) : null;
      const levelMatch = /^\s*LV\s*([123])\s*$/i.exec(text(row.getCell(2).value));
      if (levelMatch) {
        level = `LV${levelMatch[1]}` as CtvLevel;
        tierColumns = null;
        return;
      }
      const name = columnOf(row, /^tên sản phẩm$/i);
      const price = columnOf(row, /^đơn giá/i);
      if (name !== null && price !== null) {
        const scene = columnOf(row, /^bối cảnh$/i);
        const source = columnOf(row, /^source$/i);
        const stt = columnOf(row, /^stt$/i);
        if (scene !== null && source !== null && stt !== null) {
          tierColumns = { stt, name, source, scene, price };
          inPerSource = false;
          const note = parseLevelNote(all);
          if (note && level) {
            const existing = levelRules.get(level);
            if (!existing) {
              levelRules.set(level, {
                level,
                extraScenePrice: note.price,
                extraSceneMinSources: note.minSources,
              });
            } else if (
              existing.extraScenePrice !== note.price ||
              existing.extraSceneMinSources !== note.minSources
            ) {
              warnings.push(`${where}: phụ trội ${level} khác các sheet khác, giữ giá trị đầu`);
            }
          }
        } else if (scene === null) {
          perSourceColumns = { name, price };
          inPerSource = true;
          tierColumns = null;
        }
        return;
      }
      if (inPerSource && perSourceColumns) {
        const productName = text(row.getCell(perSourceColumns.name).value).trim();
        const amount = money(row.getCell(perSourceColumns.price).value);
        if (!productName || amount === null) {
          inPerSource = false;
          return;
        }
        const categoryId = resolve(productName, where);
        const rowSeconds = parseSeconds(all.replace(productName, ''));
        if (categoryId) {
          items.push({
            categoryId,
            level: 'ALL',
            pricingType: 'per_source',
            tier: null,
            sourceMin: null,
            sourceMax: null,
            sceneMin: null,
            price: amount,
            minSourceSeconds: rowSeconds,
          });
        }
        return;
      }
      if (tierColumns && level) {
        const tierMatch = /^\s*mức\s*(\d+)/i.exec(text(row.getCell(tierColumns.stt).value));
        if (!tierMatch) {
          return;
        }
        const productName = text(row.getCell(tierColumns.name).value).trim() || sheet.name;
        const sources = /(\d+)(?:\s*-\s*(\d+))?/.exec(text(row.getCell(tierColumns.source).value));
        const scenes = /(\d+)/.exec(text(row.getCell(tierColumns.scene).value));
        const amount = money(row.getCell(tierColumns.price).value);
        if (!sources || !scenes || amount === null) {
          errors.push(`${where}: cần Source, Bối cảnh và Đơn giá của Mức ${tierMatch[1]}`);
          return;
        }
        const categoryId = resolve(productName, where);
        if (categoryId) {
          items.push({
            categoryId,
            level,
            pricingType: 'tier',
            tier: Number(tierMatch[1]),
            sourceMin: Number(sources[1]),
            sourceMax: sources[2] === undefined ? null : Number(sources[2]),
            sceneMin: Number(scenes[1]),
            price: amount,
            minSourceSeconds: null,
          });
        }
      }
    });
    for (const item of items) {
      if (item.pricingType === 'per_source' && item.minSourceSeconds === null) {
        item.minSourceSeconds = perSourceSeconds;
      }
    }
  }
  if (items.length === 0) {
    errors.push('Không tìm thấy ô giá nào theo bố cục bảng lương CTV.');
  }
  if (!durationRule) {
    warnings.push('Không thấy yêu cầu thời lượng, dùng mặc định 80% ≥ 20s, tối thiểu 10s.');
  }
  return {
    content: {
      durationRule: durationRule ?? { ...DEFAULT_DURATION_RULE },
      items,
      levelRules: CTV_LEVELS.flatMap((level) => {
        const rule = levelRules.get(level);
        return rule ? [rule] : [];
      }),
    },
    errors,
    warnings,
  };
}
