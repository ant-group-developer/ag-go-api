import PizZip from 'pizzip';
import { PRICING_MODELS } from '../../database/entities/contract.entity';
import { DEFAULT_TEMPLATES } from './default-templates';
import { checkTemplateTags, missingValues, placeholderCatalog } from './document-placeholders';
import { buildDocx, center, p } from './docx-builder';
import { docxText, parseTemplate, renderDocx, resolvePath } from './docx-renderer';
import { buildRenderData, type RenderData } from './render-data';
import { sampleRenderInput } from './render-samples';

function template(...lines: string[]): Buffer {
  return buildDocx(
    'test',
    lines.map((line) => p(line)),
  );
}

describe('DOCX rendering (docxtemplater + pizzip)', () => {
  it('resolves dotted paths', () => {
    expect(resolvePath({ a: { b: 1 } }, 'a.b')).toBe(1);
    expect(resolvePath({ a: 1 }, 'a.b')).toBeUndefined();
    expect(resolvePath('x', '.')).toBe('x');
  });

  it('fills values, loops reaching outer scopes and conditions, into a DOCX that opens again', () => {
    const output = renderDocx(
      template(
        'Bên A: {company.name}',
        '{#items}',
        '{line_no}. {label} – {company.name}',
        '{/items}',
        '{#flag}có{/flag}{^flag}không{/flag}',
        'Thiếu: [{nothing.here}]',
      ),
      {
        company: { name: 'ANT & Co <VN>' },
        items: [
          { line_no: 1, label: 'A' },
          { line_no: 2, label: 'B' },
        ],
        flag: false,
      },
    );
    const reopened = new PizZip(output);
    expect(reopened.file('word/document.xml')).toBeTruthy();
    const text = docxText(output);
    expect(text).toContain('Bên A: ANT & Co <VN>');
    expect(text).toContain('1. A – ANT & Co <VN>');
    expect(text).toContain('2. B – ANT & Co <VN>');
    expect(text).toContain('không');
    expect(text).not.toContain('có\n');
    expect(text).toContain('Thiếu: []');
    expect(text).not.toContain('{');
  });

  it('lists the tags of a template as a tree', () => {
    const parsed = parseTemplate(template('{a.b} {#items}{x}{#flag}{y}{/flag}{/items}{^c}z{/c}'));
    expect(parsed).toEqual({
      ok: true,
      tags: [
        { type: 'value', path: 'a.b' },
        {
          type: 'section',
          path: 'items',
          inverted: false,
          children: [
            { type: 'value', path: 'x' },
            {
              type: 'section',
              path: 'flag',
              inverted: false,
              children: [{ type: 'value', path: 'y' }],
            },
          ],
        },
        { type: 'section', path: 'c', inverted: true, children: [] },
      ],
    });
  });

  it('reports syntax errors and files that are not DOCX', () => {
    const broken = parseTemplate(template('{#items}{x}', '{unclosed'));
    expect(broken.ok).toBe(false);
    expect(broken.ok === false && broken.errors.length).toBeGreaterThan(0);
    expect(parseTemplate(Buffer.from('not a zip'))).toEqual({
      ok: false,
      errors: [{ tag: null, message: 'Không đọc được file DOCX.' }],
    });
    const zip = new PizZip();
    zip.file('a.txt', 'x');
    expect(parseTemplate(zip.generate({ type: 'nodebuffer' }) as Buffer)).toEqual({
      ok: false,
      errors: [{ tag: null, message: 'File không phải tài liệu Word (DOCX).' }],
    });
  });
});

describe('placeholder checks', () => {
  it('catalogs placeholders of each kind from the builder', () => {
    const contract = placeholderCatalog('contract').map((item) => item.path);
    expect(contract).toEqual(
      expect.arrayContaining([
        'company.name',
        'partner.full_name',
        'contract.cap_amount_words',
        'pricing.tiers',
        'tech_spec.lines',
      ]),
    );
    expect(contract).not.toContain('acceptance.net');
    const acceptance = placeholderCatalog('acceptance');
    expect(acceptance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'items', type: 'loop', optional: false }),
        expect.objectContaining({ path: 'line_no', loop: 'items', example: '1' }),
        expect.objectContaining({ path: 'actual_amount_received_number', example: '65.250.000' }),
        expect.objectContaining({ path: 'pricing.is_clip', type: 'condition' }),
        expect.objectContaining({ path: 'partner.email', optional: true }),
      ]),
    );
  });

  it('refuses unknown tags and reports missing recommended ones', () => {
    const parsed = parseTemplate(
      template(
        '{partner.full_name} {partner.cccd} {#items}{line_no}{foo}{company.name}{/items}{#weird}{/weird}{#pricing.is_clip}{pricing.unit}{/pricing.is_clip}',
      ),
    );
    if (!parsed.ok) throw new Error('parse failed');
    const check = checkTemplateTags('acceptance', parsed.tags);
    expect(check.unknown).toEqual(['partner.cccd', 'items[].foo', 'weird']);
    expect(check.missingRecommended).toEqual([
      'acceptance.appendix_number',
      'contract.number',
      'acceptance.net',
      'acceptance.net_words',
    ]);
    expect(check.used).toEqual(
      expect.arrayContaining([
        'partner.full_name',
        'items',
        'items[].line_no',
        'company.name',
        'pricing.is_clip',
      ]),
    );
    expect(checkTemplateTags('contract', parsed.tags).unknown).toContain('items');
  });

  it('lists placeholders that would print empty, skipping optional ones and hidden sections', () => {
    const parsed = parseTemplate(
      template(
        '{company.name} {partner.tax_code} {partner.email}',
        '{#items}{line_no} {label}{/items}',
        '{#contract.has_cap}{contract.cap_amount_words}{/contract.has_cap}',
        '{^contract.has_cap}{company.title}{/contract.has_cap}',
      ),
    );
    if (!parsed.ok) throw new Error('parse failed');
    const data: RenderData = {
      company: { name: '', title: '' },
      partner: { tax_code: '  ', email: '' },
      items: [{ line_no: '1', label: '' }],
      contract: { has_cap: false, cap_amount_words: '' },
    };
    expect(missingValues(parsed.tags, data)).toEqual([
      'company.name',
      'partner.tax_code',
      'items[].label',
      'company.title',
    ]);
    expect(missingValues(parsed.tags, { ...data, items: [] })).toContain('items');
  });
});

describe('interim templates (Q-R9)', () => {
  it.each(DEFAULT_TEMPLATES.map((item) => [item.fileName, item] as const))(
    '%s parses, uses only known placeholders and renders every pricing model',
    (_name, item) => {
      const buffer = item.build();
      expect(buffer.equals(item.build())).toBe(true);
      const parsed = parseTemplate(buffer);
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
      const check = checkTemplateTags(item.kind, parsed.tags);
      expect(check.unknown).toEqual([]);
      expect(check.missingRecommended).toEqual([]);
      const models = item.pricingModel ? [item.pricingModel] : PRICING_MODELS;
      for (const model of models) {
        const data = buildRenderData(sampleRenderInput(item.kind, model));
        expect(missingValues(parsed.tags, data)).toEqual([]);
        const text = docxText(renderDocx(buffer, data));
        expect(text).not.toMatch(/[{}]/);
        expect(text).toContain('CÔNG TY CỔ PHẦN ANT GROUP');
        expect(text).toContain('Nguyễn Văn B');
        expect(text).toContain('Q-R9');
      }
    },
  );

  it('prints the acceptance table, totals and words (D2)', () => {
    const acceptance = DEFAULT_TEMPLATES.find((item) => item.kind === 'acceptance')!;
    const text = docxText(
      renderDocx(acceptance.build(), buildRenderData(sampleRenderInput('acceptance', 'per_topic'))),
    );
    expect(text).toContain('PHỤ LỤC HỢP ĐỒNG SỐ 2');
    expect(text).toContain('Số chủ đề');
    expect(text).toContain('VIDEO TRẢI NGHIỆM');
    expect(text).toContain('72.500.000');
    expect(text).toContain('Khấu trừ thuế TNCN (10%)');
    expect(text).toContain('65.250.000');
    expect(text).toContain('Sáu mươi lăm triệu hai trăm năm mươi nghìn đồng');
    expect(text).toContain('ngày 07 tháng 10 năm 2026');
    expect(text).not.toContain('Đối trừ tạm ứng');
    expect(text).toContain('Mỗi bối cảnh có tối thiểu 5 shot');
  });

  it('prints the rate card table of a package_tier contract', () => {
    const contract = DEFAULT_TEMPLATES.find((item) => item.pricingModel === 'package_tier')!;
    const text = docxText(
      renderDocx(contract.build(), buildRenderData(sampleRenderInput('contract', 'package_tier'))),
    );
    expect(text).toContain('Số: 070926/HĐSXND/AG-NVB');
    expect(text).toContain('CẢNH');
    expect(text).toContain('150–200 source');
    expect(text).toContain('1.300.000');
    expect(text).toContain('Lái xe: 50.000 đồng/source');
    expect(text).toContain('Tổng giá trị hợp đồng tối đa 100.000.000 đồng');
  });

  it('builds a plain document with centered headings', () => {
    const text = docxText(buildDocx('x', [center('**A**'), p('b __c__')]));
    expect(text.trim()).toBe('A\nb c');
  });
});
