import PizZip from 'pizzip';

/**
 * A minimal WordprocessingML writer for the interim templates bundled with AG Go: paragraphs with
 * bold / italic runs and tables, Times New Roman 13 pt on A4. Enough for Word, LibreOffice
 * (Gotenberg) and docxtemplater; business replaces these templates with their own Word files.
 */

export type Run = { text: string; bold?: boolean; italic?: boolean; color?: string };

export type Paragraph = {
  kind: 'paragraph';
  runs: Run[];
  align?: 'left' | 'center' | 'right' | 'both';
  /** Font size in points. */
  size?: number;
  indent?: boolean;
  spacingAfter?: number;
};

export type Cell = {
  paragraphs: Paragraph[];
  /** Columns spanned. */
  span?: number;
  shade?: boolean;
};

export type Table = {
  kind: 'table';
  /** Column widths in twentieths of a point. */
  widths: number[];
  rows: Cell[][];
  borders?: boolean;
};

export type Block = Paragraph | Table;

const FONT = 'Times New Roman';
const BASE_SIZE = 13;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** `**bold**` and `__italic__` spans in a line, for readable template definitions. */
export function runs(line: string): Run[] {
  const parts: Run[] = [];
  const pattern = /\*\*(.+?)\*\*|__(.+?)__/g;
  let last = 0;
  for (const match of line.matchAll(pattern)) {
    if (match.index > last) {
      parts.push({ text: line.slice(last, match.index) });
    }
    if (match[1] !== undefined) {
      parts.push({ text: match[1], bold: true });
    } else {
      parts.push({ text: match[2], italic: true });
    }
    last = match.index + match[0].length;
  }
  if (last < line.length) {
    parts.push({ text: line.slice(last) });
  }
  return parts.length > 0 ? parts : [{ text: '' }];
}

export function p(line: string, options: Omit<Paragraph, 'kind' | 'runs'> = {}): Paragraph {
  return { kind: 'paragraph', runs: runs(line), align: 'both', ...options };
}

export function center(line: string, options: Omit<Paragraph, 'kind' | 'runs'> = {}): Paragraph {
  return p(line, { align: 'center', ...options });
}

export function cell(
  line: string,
  options: Omit<Cell, 'paragraphs'> & { align?: Paragraph['align'] } = {},
): Cell {
  const { align, ...rest } = options;
  return { paragraphs: [p(line, { align: align ?? 'left', spacingAfter: 0 })], ...rest };
}

function runXml(run: Run, size: number): string {
  const properties = [
    `<w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:cs="${FONT}" w:eastAsia="${FONT}"/>`,
    run.bold ? '<w:b/><w:bCs/>' : '',
    run.italic ? '<w:i/><w:iCs/>' : '',
    run.color ? `<w:color w:val="${run.color}"/>` : '',
    `<w:sz w:val="${size * 2}"/><w:szCs w:val="${size * 2}"/>`,
  ].join('');
  return `<w:r><w:rPr>${properties}</w:rPr><w:t xml:space="preserve">${escapeXml(run.text)}</w:t></w:r>`;
}

function paragraphXml(paragraph: Paragraph): string {
  const size = paragraph.size ?? BASE_SIZE;
  const properties = [
    `<w:spacing w:before="0" w:after="${paragraph.spacingAfter ?? 80}" w:line="276" w:lineRule="auto"/>`,
    paragraph.indent ? '<w:ind w:firstLine="567"/>' : '',
    `<w:jc w:val="${paragraph.align ?? 'both'}"/>`,
  ].join('');
  return `<w:p><w:pPr>${properties}</w:pPr>${paragraph.runs.map((run) => runXml(run, size)).join('')}</w:p>`;
}

function tableXml(table: Table): string {
  const border = table.borders === false ? 'none' : 'single';
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((side) => `<w:${side} w:val="${border}" w:sz="4" w:space="0" w:color="000000"/>`)
    .join('');
  const total = table.widths.reduce((sum, width) => sum + width, 0);
  const grid = table.widths.map((width) => `<w:gridCol w:w="${width}"/>`).join('');
  const rows = table.rows
    .map((row) => {
      let column = 0;
      const cells = row
        .map((item) => {
          const span = item.span ?? 1;
          const width = table.widths.slice(column, column + span).reduce((sum, w) => sum + w, 0);
          column += span;
          const properties = [
            `<w:tcW w:w="${width}" w:type="dxa"/>`,
            span > 1 ? `<w:gridSpan w:val="${span}"/>` : '',
            item.shade ? '<w:shd w:val="clear" w:color="auto" w:fill="E7E6E6"/>' : '',
            '<w:vAlign w:val="center"/>',
          ].join('');
          return `<w:tc><w:tcPr>${properties}</w:tcPr>${item.paragraphs.map(paragraphXml).join('')}</w:tc>`;
        })
        .join('');
      return `<w:tr>${cells}</w:tr>`;
    })
    .join('');
  return [
    '<w:tbl>',
    `<w:tblPr><w:tblW w:w="${total}" w:type="dxa"/><w:jc w:val="center"/><w:tblBorders>${borders}</w:tblBorders>`,
    '<w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr>',
    `<w:tblGrid>${grid}</w:tblGrid>`,
    rows,
    '</w:tbl>',
  ].join('');
}

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/></Relationships>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W_NS}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:cs="${FONT}" w:eastAsia="${FONT}"/><w:sz w:val="${BASE_SIZE * 2}"/><w:szCs w:val="${BASE_SIZE * 2}"/><w:lang w:val="vi-VN" w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>`;

const SETTINGS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="${W_NS}"><w:defaultTabStop w:val="720"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;

function coreXml(title: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(title)}</dc:title><dc:creator>AG Go</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">2026-11-03T00:00:00Z</dcterms:created></cp:coreProperties>`;
}

const APP = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>AG Go</Application></Properties>`;

/** A DOCX made of `blocks` (A4, margins 2 cm / 3 cm left). Same input, same bytes. */
export function buildDocx(title: string, blocks: readonly Block[]): Buffer {
  const body = blocks
    .map((block) =>
      block.kind === 'table' ? `${tableXml(block)}${paragraphXml(p(''))}` : paragraphXml(block),
    )
    .join('');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1701" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const zip = new PizZip();
  const date = new Date('2026-11-03T00:00:00Z');
  const files: Array<[string, string]> = [
    ['[Content_Types].xml', CONTENT_TYPES],
    ['_rels/.rels', ROOT_RELS],
    ['docProps/core.xml', coreXml(title)],
    ['docProps/app.xml', APP],
    ['word/document.xml', document],
    ['word/_rels/document.xml.rels', DOCUMENT_RELS],
    ['word/styles.xml', STYLES],
    ['word/settings.xml', SETTINGS],
  ];
  for (const [name, content] of files) {
    zip.file(name, content, { date });
  }
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer;
}
