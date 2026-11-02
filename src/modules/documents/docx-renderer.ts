import Docxtemplater, { type DXT } from 'docxtemplater';
import InspectModule from 'docxtemplater/js/inspect-module.js';
import PizZip from 'pizzip';

/**
 * Fills DOCX templates with docxtemplater + pizzip (spec 13), on the server only so the partner's
 * personal data never reaches a browser. Placeholders are dotted paths (`{partner.full_name}`),
 * loops and conditions `{#items}…{/items}`, `{^x}…{/x}`; a value missing in a loop item is looked up
 * in the outer scopes (docxtemplater's scope chain).
 */

export const DOCX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const PDF_CONTENT_TYPE = 'application/pdf';

/** One tag of a template: a value, or a section (loop / condition) with the tags inside it. */
export type TemplateTag =
  | { type: 'value'; path: string }
  | { type: 'section'; path: string; inverted: boolean; children: TemplateTag[] };

export type TemplateError = { tag: string | null; message: string };

export type ParsedTemplate =
  { ok: true; tags: TemplateTag[] } | { ok: false; errors: TemplateError[] };

type Scope = unknown;

/** Value of a dotted path in one scope; `undefined` lets docxtemplater try the outer scopes. */
export function resolvePath(scope: Scope, path: string): unknown {
  const trimmed = path.trim();
  if (trimmed === '.' || trimmed === 'this') {
    return scope;
  }
  let value: unknown = scope;
  for (const key of trimmed.split('.')) {
    if (value === null || value === undefined || typeof value !== 'object') {
      return undefined;
    }
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function pathParser(tag: string) {
  return { get: (scope: Scope) => resolvePath(scope, tag) };
}

function options(modules: DXT.Module[] = []): DXT.ConstructorOptions {
  return {
    modules,
    paragraphLoop: true,
    linebreaks: true,
    errorLogging: false,
    parser: pathParser,
    // A value missing at render time prints nothing (issue refuses missing data beforehand).
    nullGetter: () => '',
  };
}

type StructuredPart = {
  type: string;
  value?: string;
  module?: string;
  inverted?: boolean;
  subparsed?: StructuredPart[];
};

function toTags(parts: readonly StructuredPart[]): TemplateTag[] {
  const tags: TemplateTag[] = [];
  for (const part of parts) {
    if (part.type !== 'placeholder' || typeof part.value !== 'string') {
      continue;
    }
    const path = part.value.trim();
    if (part.module === 'loop') {
      tags.push({
        type: 'section',
        path,
        inverted: part.inverted === true,
        children: toTags(part.subparsed ?? []),
      });
    } else if (!part.module) {
      tags.push({ type: 'value', path });
    }
  }
  return tags;
}

type DocxtemplaterError = Error & {
  properties?: {
    id?: string;
    xtag?: string;
    explanation?: string;
    errors?: DocxtemplaterError[];
  };
};

function templateErrors(error: unknown): TemplateError[] {
  const failure = error as DocxtemplaterError;
  const nested = failure.properties?.errors;
  const list = nested && nested.length > 0 ? nested : [failure];
  return list.map((item) => ({
    tag: item.properties?.xtag ?? null,
    message: item.properties?.explanation ?? item.message,
  }));
}

/** Opens a DOCX and lists its tags; syntax errors (unclosed tag, loop not closed…) are returned. */
export function parseTemplate(buffer: Buffer): ParsedTemplate {
  let zip: PizZip;
  try {
    zip = new PizZip(buffer);
  } catch {
    return { ok: false, errors: [{ tag: null, message: 'Không đọc được file DOCX.' }] };
  }
  if (!zip.file('word/document.xml')) {
    return { ok: false, errors: [{ tag: null, message: 'File không phải tài liệu Word (DOCX).' }] };
  }
  const inspect = new InspectModule();
  try {
    new Docxtemplater(zip, options([inspect]));
  } catch (error) {
    return { ok: false, errors: templateErrors(error) };
  }
  return {
    ok: true,
    tags: toTags(inspect.getAllStructuredTags() as unknown as StructuredPart[]),
  };
}

/** Fills the template with `data`; throws when the template itself is invalid. */
export function renderDocx(template: Buffer, data: Record<string, unknown>): Buffer {
  const zip = new PizZip(template);
  const document = new Docxtemplater(zip, options());
  document.render(data);
  return document.getZip().generate({
    type: 'nodebuffer',
    compression: 'DEFLATE',
  }) as Buffer;
}

/** Plain text of a DOCX body (paragraphs on their own lines), to check a render in tests. */
export function docxText(buffer: Buffer): string {
  const xml = new PizZip(buffer).file('word/document.xml')?.asText() ?? '';
  return xml
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
