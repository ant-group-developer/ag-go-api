import type { TemplateTag } from './docx-renderer';
import { buildRenderData, type DocumentKind, type RenderData } from './render-data';
import { sampleRenderInputs } from './render-samples';

/**
 * Placeholders a template of each kind may use (read from the builder's own output on sample data,
 * so the list cannot drift), the check of an uploaded template (unknown tags refused, recommended
 * tags missing reported) and the check before issue that no placeholder used would print empty
 * (FR-D-03).
 */

export type PlaceholderInfo = {
  /** `company.name`; inside a loop the field name relative to it (`line_no`). */
  path: string;
  /** Loop the field belongs to (`items`), null for top-level placeholders. */
  loop: string | null;
  /** `value`, `loop` (`{#items}…{/items}`) or `condition` (`{#pricing.is_clip}…{/}`). */
  type: 'value' | 'loop' | 'condition';
  /** May print empty without blocking issue. */
  optional: boolean;
  example: string;
};

/** Printed empty without blocking issue (data AG Account / settings may not have). */
export const OPTIONAL_PLACEHOLDERS: ReadonlySet<string> = new Set([
  'partner.email',
  'partner.code',
  'company.phone',
  'company.email',
  'company.bank_account_number',
  'company.bank_name',
  'acceptance.delivery_note',
]);

/** Loops that must have at least one row to issue. */
const REQUIRED_LOOPS: ReadonlySet<string> = new Set(['items']);

/** Tags a template of the kind should have (any one of each group); missing ones are warnings. */
export const RECOMMENDED_PLACEHOLDERS: Record<DocumentKind, string[][]> = {
  contract: [
    ['contract.number'],
    ['company.name'],
    ['company.representative'],
    ['partner.full_name'],
    ['partner.id_number'],
  ],
  amendment: [['amendment.number'], ['contract.number'], ['partner.full_name']],
  acceptance: [
    ['acceptance.appendix_number'],
    ['contract.number'],
    ['partner.full_name'],
    ['items'],
    ['acceptance.net', 'actual_amount_received_number'],
    ['acceptance.net_words', 'actual_amount_received_string'],
  ],
};

type Catalog = {
  values: Map<string, string>;
  conditions: Map<string, string>;
  loops: Map<string, Map<string, string>>;
};

function walk(
  data: RenderData,
  prefix: string,
  catalog: Catalog,
  loopFields: Map<string, string> | null,
): void {
  for (const [key, value] of Object.entries(data)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(value)) {
      const fields = catalog.loops.get(path) ?? new Map<string, string>();
      catalog.loops.set(path, fields);
      for (const element of value) {
        if (element && typeof element === 'object') {
          walk(
            element as RenderData,
            '',
            { ...catalog, values: fields, loops: catalog.loops },
            fields,
          );
        }
      }
    } else if (typeof value === 'boolean') {
      (loopFields ?? catalog.conditions).set(path, String(value));
    } else if (value && typeof value === 'object') {
      walk(value as RenderData, path, catalog, loopFields);
    } else if (!catalog.values.has(path) || catalog.values.get(path) === '—') {
      catalog.values.set(path, String(value ?? ''));
    }
  }
}

const catalogs = new Map<DocumentKind, Catalog>();

function catalogOf(kind: DocumentKind): Catalog {
  const cached = catalogs.get(kind);
  if (cached) {
    return cached;
  }
  const catalog: Catalog = { values: new Map(), conditions: new Map(), loops: new Map() };
  for (const input of sampleRenderInputs(kind)) {
    walk(buildRenderData(input), '', catalog, null);
  }
  catalogs.set(kind, catalog);
  return catalog;
}

/** Every placeholder of the kind, for the template screen. */
export function placeholderCatalog(kind: DocumentKind): PlaceholderInfo[] {
  const catalog = catalogOf(kind);
  const list: PlaceholderInfo[] = [];
  for (const [path, example] of catalog.values) {
    list.push({
      path,
      loop: null,
      type: 'value',
      optional: OPTIONAL_PLACEHOLDERS.has(path),
      example,
    });
  }
  for (const [path, example] of catalog.conditions) {
    list.push({ path, loop: null, type: 'condition', optional: true, example });
  }
  for (const [loop, fields] of catalog.loops) {
    list.push({
      path: loop,
      loop: null,
      type: 'loop',
      optional: !REQUIRED_LOOPS.has(loop),
      example: '',
    });
    for (const [field, example] of fields) {
      list.push({ path: field, loop, type: 'value', optional: false, example });
    }
  }
  return list;
}

export type TemplateCheck = {
  /** Tags the builder never fills (`items[].foo` inside a loop): the template is refused. */
  unknown: string[];
  /** Recommended tags absent (one name per group): a warning. */
  missingRecommended: string[];
  /** Every tag used, as `path` or `loop[].field`. */
  used: string[];
};

/** Checks the tags of an uploaded template against the catalog of its kind. */
export function checkTemplateTags(kind: DocumentKind, tags: readonly TemplateTag[]): TemplateCheck {
  const catalog = catalogOf(kind);
  const unknown = new Set<string>();
  const used = new Set<string>();

  const inLoop = (path: string, loops: readonly string[]) =>
    loops.some((loop) => catalog.loops.get(loop)?.has(path));

  const visit = (list: readonly TemplateTag[], loops: readonly string[]) => {
    const where = (path: string) => {
      const loop = [...loops].reverse().find((name) => catalog.loops.get(name)?.has(path));
      return loop ? `${loop}[].${path}` : path;
    };
    for (const tag of list) {
      if (tag.type === 'value') {
        if (catalog.values.has(tag.path) || inLoop(tag.path, loops)) {
          used.add(where(tag.path));
        } else {
          unknown.add(loops.length > 0 ? `${loops[loops.length - 1]}[].${tag.path}` : tag.path);
        }
        continue;
      }
      if (catalog.loops.has(tag.path)) {
        used.add(tag.path);
        visit(tag.children, [...loops, tag.path]);
      } else if (
        catalog.conditions.has(tag.path) ||
        catalog.values.has(tag.path) ||
        inLoop(tag.path, loops)
      ) {
        used.add(where(tag.path));
        visit(tag.children, loops);
      } else {
        unknown.add(loops.length > 0 ? `${loops[loops.length - 1]}[].${tag.path}` : tag.path);
        visit(tag.children, loops);
      }
    }
  };
  visit(tags, []);

  const missingRecommended = RECOMMENDED_PLACEHOLDERS[kind]
    .filter((group) => !group.some((path) => used.has(path)))
    .map((group) => group[0]);
  return { unknown: [...unknown], missingRecommended, used: [...used] };
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && !value.trim());
}

function lookup(scopes: readonly unknown[], path: string): unknown {
  for (let index = scopes.length - 1; index >= 0; index -= 1) {
    let value: unknown = scopes[index];
    for (const key of path.split('.')) {
      if (value === null || value === undefined || typeof value !== 'object') {
        value = undefined;
        break;
      }
      value = (value as Record<string, unknown>)[key];
    }
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

/**
 * Placeholders the template uses that would print empty with `data` (FR-D-03): issue lists them
 * instead of making the file. Sections not rendered (false condition) are not checked.
 */
export function missingValues(tags: readonly TemplateTag[], data: RenderData): string[] {
  const missing = new Set<string>();
  const visit = (list: readonly TemplateTag[], scopes: readonly unknown[], loop: string | null) => {
    for (const tag of list) {
      const name = loop ? `${loop}[].${tag.path}` : tag.path;
      const value = lookup(scopes, tag.path);
      if (tag.type === 'value') {
        if (isEmpty(value) && !OPTIONAL_PLACEHOLDERS.has(tag.path)) {
          missing.add(name);
        }
        continue;
      }
      if (Array.isArray(value)) {
        if (tag.inverted) {
          if (value.length === 0) visit(tag.children, scopes, loop);
          continue;
        }
        if (value.length === 0 && REQUIRED_LOOPS.has(tag.path)) {
          missing.add(name);
        }
        for (const element of value) {
          visit(tag.children, [...scopes, element], tag.path);
        }
        continue;
      }
      const truthy = Boolean(value) && !isEmpty(value);
      if (tag.inverted ? !truthy : truthy) {
        visit(tag.children, value && typeof value === 'object' ? [...scopes, value] : scopes, loop);
      }
    }
  };
  visit(tags, [data], null);
  return [...missing];
}
