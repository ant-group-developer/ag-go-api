import type { PricingModel } from '../../database/entities/contract.entity';
import { buildDocx, cell, center, p, type Block, type Cell, type Paragraph } from './docx-builder';
import type { DocumentKind } from './render-data';

/**
 * Interim templates bundled with AG Go (Q-R9): the contract per pricing model (`package_tier`,
 * `per_topic`, `per_unit`), the amendment and the acceptance record (BBNT), laid out like the
 * sample documents (spec 2.1, Phụ lục A) with the placeholders of spec 13 and the fixes of Phụ lục B
 * (quantity column by model, Điều 3 from the tech spec, no music wording, no ID card images).
 *
 * TEMPORARY: business still has to standardise the wording (Q-R9). They replace these by uploading
 * their own DOCX at /system/contract-templates; `yarn documents:templates` writes these files to
 * `templates/documents/` to start from.
 */

export const INTERIM_TEMPLATE_NOTE =
  'Mẫu tạm của hệ thống AG Go, chờ nghiệp vụ chuẩn hoá nội dung (Q-R9).';

const PAGE_WIDTH = 9071;

function heading(line: string): Paragraph {
  return p(`**${line}**`, { align: 'left', spacingAfter: 60 });
}

function clause(line: string): Paragraph {
  return p(line, { indent: true });
}

function nationalHeader(): Block[] {
  return [
    center('**CỘNG HOÀ XÃ HỘI CHỦ NGHĨA VIỆT NAM**', { spacingAfter: 0 }),
    center('**Độc lập – Tự do – Hạnh phúc**', { spacingAfter: 0 }),
    center('———————', { spacingAfter: 120 }),
    {
      kind: 'paragraph',
      runs: [{ text: INTERIM_TEMPLATE_NOTE, italic: true, color: '7F7F7F' }],
      align: 'center',
      size: 10,
      spacingAfter: 160,
    },
  ];
}

function partyA(): Block[] {
  return [
    heading('BÊN A (BÊN THUÊ): {company.name}'),
    p('Địa chỉ: {company.address}'),
    p('Mã số thuế: {company.tax_code}'),
    p('Người đại diện: {company.representative}        Chức vụ: {company.title}'),
  ];
}

function partyB(): Block[] {
  return [
    heading('BÊN B (BÊN NHẬN THỰC HIỆN): {partner.full_name}'),
    p('Ngày sinh: {partner.dob}'),
    p(
      'Số CCCD: {partner.id_number}, cấp ngày {partner.id_issued_date} tại {partner.id_issued_place}',
    ),
    p('Hộ khẩu thường trú: {partner.permanent_address}'),
    p('Địa chỉ liên hệ: {partner.address}'),
    p('Điện thoại: {partner.phone}'),
    p('Mã số thuế cá nhân: {partner.tax_code}'),
    p(
      'Tài khoản số: {partner.bank_account_number}, chủ tài khoản: {partner.bank_account_name}, tại: {partner.bank_name}',
    ),
  ];
}

function signatures(left: string, right: string): Block[] {
  const column = (title: string, note: string, name: string): Cell => ({
    paragraphs: [
      center(`**${title}**`, { spacingAfter: 0 }),
      center(`__${note}__`, { spacingAfter: 1400 }),
      center(`**${name}**`, { spacingAfter: 0 }),
    ],
  });
  return [
    {
      kind: 'table',
      borders: false,
      widths: [PAGE_WIDTH / 2, PAGE_WIDTH / 2],
      rows: [
        [
          column(left, '(Ký, ghi rõ họ tên, đóng dấu)', '{company.representative}'),
          column(right, '(Ký, ghi rõ họ tên)', '{partner.full_name}'),
        ],
      ],
    },
  ];
}

function techSpecLines(): Block[] {
  return [p('{#tech_spec.lines}'), clause('{no}. {text}.'), p('{/tech_spec.lines}')];
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

function scopeByModel(model: PricingModel): Block[] {
  switch (model) {
    case 'per_topic':
      return [
        clause(
          '1.3. Sản phẩm là các chủ đề video; mỗi chủ đề có thời lượng footage đạt yêu cầu từ {pricing.min_topic_minutes} phút (khuyến nghị không quá {pricing.max_topic_minutes} phút). Chủ đề thực hiện: {pricing.topics_text}.',
        ),
      ];
    case 'per_unit':
      return [
        clause(
          '1.3. Sản phẩm được tính theo {pricing.unit_label}{#pricing.is_clip}; mỗi clip gồm tối đa {pricing.max_shots_per_clip} shot trong cùng một bối cảnh{/pricing.is_clip}; mỗi shot dài tối thiểu {pricing.min_shot_seconds} giây.',
        ),
      ];
    case 'package_tier':
      return [
        clause(
          '1.3. Sản phẩm là các gói sản phẩm thuộc danh mục: {pricing.products_text}. Mỗi gói gồm nhiều bối cảnh (dự án) cùng danh mục do Bên B gom lại và gửi nghiệm thu. Cấp cộng tác viên: {pricing.level}, giai đoạn: {pricing.employment_stage_text}.',
        ),
      ];
  }
}

function priceByModel(model: PricingModel): Block[] {
  switch (model) {
    case 'per_topic':
      return [
        clause(
          '2.1. Đơn giá: {pricing.unit_price} đồng/chủ đề (Bằng chữ: {pricing.unit_price_words}).',
        ),
      ];
    case 'per_unit':
      return [
        clause(
          '2.1. Đơn giá: {pricing.unit_price} đồng/{pricing.unit_label} (Bằng chữ: {pricing.unit_price_words}).',
        ),
      ];
    case 'package_tier':
      return [
        clause(
          '2.1. Đơn giá theo Bảng giá CTV mã {pricing.rate_card_code}, phiên bản {pricing.rate_card_version} hiệu lực từ {pricing.rate_card_effective_from}, cấp {pricing.level}:',
        ),
        {
          kind: 'table',
          widths: [2400, 1300, 2000, 1500, 1871],
          rows: [
            [
              cell('**Sản phẩm**', { align: 'center', shade: true }),
              cell('**Mức**', { align: 'center', shade: true }),
              cell('**Số source**', { align: 'center', shade: true }),
              cell('**Số bối cảnh tối thiểu**', { align: 'center', shade: true }),
              cell('**Đơn giá (đồng/gói)**', { align: 'center', shade: true }),
            ],
            [
              cell('{#pricing.tiers}{product}'),
              cell('{tier_text}', { align: 'center' }),
              cell('{sources_text}', { align: 'center' }),
              cell('{scenes}', { align: 'center' }),
              cell('{price}{/pricing.tiers}', { align: 'right' }),
            ],
          ],
        },
        clause(
          'Mỗi bối cảnh phát sinh vượt Mức cao nhất được trả thêm {pricing.extra_scene_price} đồng (bối cảnh có tối thiểu {pricing.extra_scene_min_sources} source).',
        ),
        p('{#pricing.has_per_source}'),
        clause('Sản phẩm tính theo từng source:'),
        p('{#pricing.per_source}'),
        clause('- {product}: {price} đồng/source, mỗi source dài tối thiểu {min_seconds} giây.'),
        p('{/pricing.per_source}'),
        p('{/pricing.has_per_source}'),
        clause(
          'Khi bảng giá CTV có phiên bản mới, mỗi Biên bản nghiệm thu áp dụng phiên bản hiệu lực tại ngày cuối kỳ nghiệm thu.',
        ),
      ];
  }
}

function contractBlocks(model: PricingModel): Block[] {
  return [
    ...nationalHeader(),
    center('**HỢP ĐỒNG SẢN XUẤT NỘI DUNG**', { size: 16, spacingAfter: 40 }),
    center('Số: {contract.number}', { spacingAfter: 160 }),
    p('__Căn cứ Bộ luật Dân sự số 91/2015/QH13;__'),
    p('__Căn cứ Luật Sở hữu trí tuệ số 50/2005/QH11 và các văn bản sửa đổi, bổ sung;__'),
    p('__Căn cứ Nghị định 13/2023/NĐ-CP về bảo vệ dữ liệu cá nhân;__'),
    p('__Căn cứ nhu cầu và khả năng của hai bên.__'),
    p(
      'Hôm nay, {contract.document_date_text}, tại trụ sở {company.name}, địa chỉ {company.address}, chúng tôi gồm:',
    ),
    ...partyA(),
    ...partyB(),
    p('Hai bên thống nhất ký hợp đồng với các điều khoản sau:'),

    heading('ĐIỀU 1. PHẠM VI CÔNG VIỆC'),
    clause(
      '1.1. Bên A thuê Bên B sản xuất nội dung video (footage) theo yêu cầu của Bên A. Bên B tự chuẩn bị thiết bị, nhân lực và chi phí để thực hiện.',
    ),
    clause(
      '1.2. Ngày bắt đầu thực hiện: {contract.start_date_text}. Thời hạn hợp đồng: {contract.end_date_text}.',
    ),
    ...scopeByModel(model),
    clause('1.4. Yêu cầu chất lượng: sản phẩm phải đáp ứng các yêu cầu sau:'),
    ...techSpecLines(),
    p('{#contract.has_originality}'),
    clause(
      '1.5. Sản phẩm có tối thiểu {contract.originality_min_percent}% yếu tố sáng tạo nguyên gốc của Bên B.',
    ),
    p('{/contract.has_originality}'),

    heading('ĐIỀU 2. GIÁ TRỊ HỢP ĐỒNG VÀ THANH TOÁN'),
    ...priceByModel(model),
    clause(
      '2.2. {#contract.has_cap}Tổng giá trị hợp đồng tối đa {contract.cap_amount} đồng (Bằng chữ: {contract.cap_amount_words}).{/contract.has_cap}{^contract.has_cap}Giá trị hợp đồng là tổng giá trị các Biên bản nghiệm thu.{/contract.has_cap} Giá trị thực tế được xác định theo khối lượng nghiệm thu từng kỳ.',
    ),
    clause(
      '2.3. {#contract.has_advance}Bên A tạm ứng cho Bên B {contract.advance_amount} đồng (Bằng chữ: {contract.advance_amount_words}) trong vòng {contract.advance_due_business_days} ngày làm việc kể từ ngày ký hợp đồng. Khoản tạm ứng được đối trừ vào các lần thanh toán; nếu Bên B không bàn giao đủ sản phẩm tương ứng, Bên B hoàn trả phần tạm ứng chưa được đối trừ.{/contract.has_advance}{^contract.has_advance}Hợp đồng không có tạm ứng.{/contract.has_advance}',
    ),
    clause(
      '2.4. Bên A thanh toán trong vòng {contract.payment_term} kể từ ngày hai bên ký Biên bản nghiệm thu, bằng chuyển khoản vào tài khoản của Bên B nêu trên.',
    ),
    clause('2.5. Thuế thu nhập cá nhân: {partner.tax_mode_text}.'),

    heading('ĐIỀU 3. BÀN GIAO VÀ NGHIỆM THU'),
    clause(
      '3.1. {contract.delivery_rule_text}; hai bên nghiệm thu {contract.acceptance_cycle_text}.',
    ),
    clause(
      '3.2. Mỗi kỳ nghiệm thu, hai bên lập Biên bản nghiệm thu (là phụ lục của hợp đồng) ghi khối lượng, giá trị và số tiền thanh toán.',
    ),
    clause('3.3. Sản phẩm không đạt yêu cầu tại khoản 1.4 không được nghiệm thu.'),

    heading('ĐIỀU 4. QUYỀN SỞ HỮU TRÍ TUỆ'),
    clause(
      '4.1. Bên B chuyển giao cho Bên A độc quyền, vô thời hạn, trên phạm vi toàn thế giới toàn bộ quyền tác giả và quyền liên quan đối với sản phẩm đã nghiệm thu, gồm quyền sử dụng, sao chép, chỉnh sửa, phân phối, cấp phép lại và sử dụng để huấn luyện trí tuệ nhân tạo.',
    ),
    clause('4.2. Giá trị chuyển giao quyền đã bao gồm trong giá trị hợp đồng.'),

    heading('ĐIỀU 5. CAM KẾT CỦA BÊN B'),
    clause('5.1. Sản phẩm do Bên B tự sản xuất, không vi phạm quyền của bên thứ ba.'),
    clause(
      '5.2. Trong {contract.non_compete_months} tháng kể từ ngày nghiệm thu, Bên B không sử dụng, bán hoặc cung cấp cho bên khác sản phẩm đã bàn giao hoặc sản phẩm tương đồng trên {contract.similarity_max_percent}%.',
    ),
    clause('5.3. Bên B bảo mật thông tin của Bên A và nội dung hợp đồng.'),

    heading('ĐIỀU 6. BẢO VỆ DỮ LIỆU CÁ NHÂN'),
    clause(
      'Bên A xử lý dữ liệu cá nhân của Bên B để thực hiện hợp đồng, thanh toán và nghĩa vụ thuế theo Nghị định 13/2023/NĐ-CP; Bên B đồng ý với việc xử lý này.',
    ),

    heading('ĐIỀU 7. VI PHẠM HỢP ĐỒNG'),
    clause(
      'Bên vi phạm nghĩa vụ chịu phạt {contract.penalty_percent}% giá trị phần nghĩa vụ bị vi phạm và bồi thường thiệt hại thực tế phát sinh.',
    ),

    heading('ĐIỀU 8. CHẤM DỨT HỢP ĐỒNG'),
    clause(
      'Hợp đồng chấm dứt khi hết thời hạn, khi hai bên hoàn thành nghĩa vụ, khi hai bên thoả thuận chấm dứt, hoặc khi một bên vi phạm nghiêm trọng và bên kia đơn phương chấm dứt sau khi thông báo bằng văn bản.',
    ),

    heading('ĐIỀU 9. ĐIỀU KHOẢN CHUNG'),
    clause(
      'Tranh chấp được giải quyết bằng thương lượng; không thương lượng được thì đưa ra Toà án có thẩm quyền. Hợp đồng lập thành 02 bản có giá trị như nhau, mỗi bên giữ 01 bản, có hiệu lực từ ngày ký.',
    ),
    ...signatures('ĐẠI DIỆN BÊN A', 'BÊN B'),
  ];
}

// ---------------------------------------------------------------------------
// Amendment
// ---------------------------------------------------------------------------

function amendmentBlocks(): Block[] {
  return [
    ...nationalHeader(),
    center('**PHỤ LỤC SỬA ĐỔI HỢP ĐỒNG SỐ {amendment.number}**', { size: 15, spacingAfter: 40 }),
    center('__(Kèm theo Hợp đồng số {contract.number} ký {contract.signed_date_text})__', {
      spacingAfter: 160,
    }),
    p('Hôm nay, {document.date_text}, tại {company.address}, chúng tôi gồm:'),
    heading('BÊN A: {company.name}'),
    p('Người đại diện: {company.representative}        Chức vụ: {company.title}'),
    heading('BÊN B: {partner.full_name}'),
    p(
      'Số CCCD: {partner.id_number}, cấp ngày {partner.id_issued_date} tại {partner.id_issued_place}',
    ),
    p('Hai bên thống nhất sửa đổi hợp đồng như sau:'),
    heading('ĐIỀU 1. NỘI DUNG SỬA ĐỔI'),
    {
      kind: 'table',
      widths: [700, 2900, 5471],
      rows: [
        [
          cell('**STT**', { align: 'center', shade: true }),
          cell('**Nội dung**', { align: 'center', shade: true }),
          cell('**Giá trị mới**', { align: 'center', shade: true }),
        ],
        [
          cell('{#amendment.changes}{no}', { align: 'center' }),
          cell('{label}'),
          cell('{value}{/amendment.changes}'),
        ],
      ],
    },
    heading('ĐIỀU 2. LÝ DO SỬA ĐỔI'),
    clause('{amendment.reason}.'),
    heading('ĐIỀU 3. HIỆU LỰC'),
    clause(
      'Phụ lục có hiệu lực từ {amendment.effective_date_text}. Các điều khoản khác của hợp đồng giữ nguyên. Phụ lục là bộ phận không tách rời của hợp đồng, lập thành 02 bản có giá trị như nhau, mỗi bên giữ 01 bản.',
    ),
    ...signatures('ĐẠI DIỆN BÊN A', 'BÊN B'),
  ];
}

// ---------------------------------------------------------------------------
// Acceptance record
// ---------------------------------------------------------------------------

function acceptanceBlocks(): Block[] {
  const widths = [700, 2371, 1100, 1700, 1500, 1700];
  const total = (label: string, value: string, bold = false): Cell[] => [
    cell(bold ? `**${label}**` : label, { span: 5, align: 'right' }),
    cell(bold ? `**${value}**` : value, { align: 'right' }),
  ];
  return [
    ...nationalHeader(),
    center('**PHỤ LỤC HỢP ĐỒNG SỐ {acceptance.appendix_number}**', { size: 15, spacingAfter: 0 }),
    center('**BIÊN BẢN NGHIỆM THU**', { size: 15, spacingAfter: 40 }),
    center('__(Kèm theo Hợp đồng số {contract.number} ký {contract.signed_date_text})__', {
      spacingAfter: 160,
    }),
    p(
      '__Căn cứ Hợp đồng sản xuất nội dung số {contract.number}; căn cứ khối lượng sản phẩm Bên B bàn giao trong kỳ {acceptance.period_text}.__',
    ),
    p('Hôm nay, {acceptance.record_date_text}, tại {company.address}, chúng tôi gồm:'),
    ...partyA(),
    ...partyB(),
    p('Hai bên thống nhất nghiệm thu sản phẩm như sau:'),

    heading('ĐIỀU 1. KHỐI LƯỢNG VÀ GIÁ TRỊ NGHIỆM THU'),
    {
      kind: 'table',
      widths,
      rows: [
        [
          cell('**STT**', { align: 'center', shade: true }),
          cell('**Tên sản phẩm**', { align: 'center', shade: true }),
          cell('**Độ phân giải**', { align: 'center', shade: true }),
          cell('**{acceptance.quantity_header}**', { align: 'center', shade: true }),
          cell('**Đơn giá (đồng)**', { align: 'center', shade: true }),
          cell('**Thành tiền (đồng)**', { align: 'center', shade: true }),
        ],
        [
          cell('{#items}{line_no}', { align: 'center' }),
          cell('{label}'),
          cell('{resolution}', { align: 'center' }),
          cell('{quantity_text}', { align: 'center' }),
          cell('{unit_price}', { align: 'right' }),
          cell('{amount}{/items}', { align: 'right' }),
        ],
        total('Tổng giá trị nghiệm thu', '{acceptance.gross}', true),
        total('Khấu trừ thuế TNCN ({acceptance.tax_rate}%)', '{acceptance.tax}'),
        [
          cell('{#acceptance.has_advance_offset}Đối trừ tạm ứng', { span: 5, align: 'right' }),
          cell('{acceptance.advance_offset}{/acceptance.has_advance_offset}', { align: 'right' }),
        ],
        total('Thực lĩnh', '{acceptance.net}', true),
      ],
    },
    p('Bằng chữ: **{acceptance.net_words}**.'),

    heading('ĐIỀU 2. HÌNH THỨC BÀN GIAO'),
    clause(
      '{acceptance.delivery_method_text}{#acceptance.delivery_note}. Ghi chú: {acceptance.delivery_note}{/acceptance.delivery_note}.',
    ),

    heading('ĐIỀU 3. TIÊU CHÍ NGHIỆM THU'),
    clause('Sản phẩm được nghiệm thu đáp ứng yêu cầu kỹ thuật của hợp đồng:'),
    ...techSpecLines(),

    heading('ĐIỀU 4. THANH TOÁN'),
    clause(
      'Bên A thanh toán cho Bên B số tiền {acceptance.net} đồng trong vòng {contract.payment_term} kể từ ngày ký biên bản này, vào tài khoản số {partner.bank_account_number} tại {partner.bank_name}, chủ tài khoản {partner.bank_account_name}.',
    ),

    heading('ĐIỀU 5. ĐIỀU KHOẢN CHUNG'),
    clause(
      'Biên bản này là phụ lục không tách rời của Hợp đồng số {contract.number}, lập thành 02 bản có giá trị như nhau, mỗi bên giữ 01 bản.',
    ),
    ...signatures('ĐẠI DIỆN BÊN A', 'BÊN B'),
  ];
}

// ---------------------------------------------------------------------------

export type DefaultTemplate = {
  kind: DocumentKind;
  /** Null: every pricing model. */
  pricingModel: PricingModel | null;
  name: string;
  fileName: string;
  build: () => Buffer;
};

export const DEFAULT_TEMPLATES: readonly DefaultTemplate[] = [
  ...(['package_tier', 'per_topic', 'per_unit'] as const).map((model): DefaultTemplate => ({
    kind: 'contract',
    pricingModel: model,
    name: `HĐ sản xuất nội dung – ${model} (mẫu tạm)`,
    fileName: `hop-dong-${model.replace('_', '-')}.docx`,
    build: () => buildDocx(`Hợp đồng sản xuất nội dung (${model})`, contractBlocks(model)),
  })),
  {
    kind: 'amendment',
    pricingModel: null,
    name: 'Phụ lục sửa đổi hợp đồng (mẫu tạm)',
    fileName: 'phu-luc-sua-doi.docx',
    build: () => buildDocx('Phụ lục sửa đổi hợp đồng', amendmentBlocks()),
  },
  {
    kind: 'acceptance',
    pricingModel: null,
    name: 'Biên bản nghiệm thu (mẫu tạm)',
    fileName: 'bien-ban-nghiem-thu.docx',
    build: () => buildDocx('Biên bản nghiệm thu', acceptanceBlocks()),
  },
];
