import {
  buildRenderData,
  deliveryRuleText,
  partnerData,
  pricingData,
  quantityHeader,
  techSpecData,
  type RenderData,
} from './render-data';
import { sampleRenderInput } from './render-samples';

function at(data: RenderData, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => (value as RenderData)?.[key], data);
}

describe('render data builder (spec 13, Phụ lục A)', () => {
  it('fills an acceptance record like D2 with AG Music names for the totals', () => {
    const data = buildRenderData(sampleRenderInput('acceptance', 'per_topic'));
    expect(at(data, 'acceptance.gross')).toBe('72.500.000');
    expect(at(data, 'acceptance.tax')).toBe('7.250.000');
    expect(at(data, 'acceptance.net')).toBe('65.250.000');
    expect(at(data, 'acceptance.net_words')).toBe(
      'Sáu mươi lăm triệu hai trăm năm mươi nghìn đồng',
    );
    expect(at(data, 'acceptance.record_date_text')).toBe('ngày 07 tháng 10 năm 2026');
    expect(at(data, 'acceptance.period_text')).toBe('từ 01/09/2026 đến 30/09/2026');
    expect(at(data, 'acceptance.appendix_number')).toBe('2');
    expect(at(data, 'acceptance.quantity_header')).toBe('Số chủ đề');
    expect(data.total_acceptance_value).toBe('72.500.000');
    expect(data.personal_income_tax).toBe('7.250.000');
    expect(data.actual_amount_received_number).toBe('65.250.000');
    expect(data.actual_amount_received_string).toBe(at(data, 'acceptance.net_words'));
  });

  it('prints package lines with sources, scenes, tier and resolution (D6)', () => {
    const data = buildRenderData(sampleRenderInput('acceptance', 'package_tier'));
    const [item] = data.items as RenderData[];
    expect(item).toMatchObject({
      line_no: '1',
      label: 'VIDEO TRẢI NGHIỆM',
      quantity_text: '158 source – 14 bối cảnh',
      sources: '158',
      scenes: '14',
      tier_text: 'Mức 3',
      resolution: '4K',
      unit_price: '72.500.000',
      amount: '72.500.000',
    });
    expect(at(data, 'acceptance.quantity_header')).toBe('Số source – Số bối cảnh');
  });

  it('keeps stored words, else reads the net amount', () => {
    const input = sampleRenderInput('acceptance', 'per_unit');
    input.acceptance!.netPayableWords = 'Chữ đã lưu';
    expect(at(buildRenderData(input), 'acceptance.net_words')).toBe('Chữ đã lưu');
  });

  it('prints topic, shot and extra-scene quantities by unit', () => {
    const input = sampleRenderInput('acceptance', 'per_unit');
    input.acceptance!.items = [
      {
        lineNo: 2,
        productLabel: 'THIÊN NHIÊN',
        unit: 'shot',
        quantity: 61,
        unitPrice: 300_000,
        amount: 18_300_000,
        metrics: {},
      },
      {
        lineNo: 1,
        productLabel: 'Phát sinh',
        unit: 'extra_scene',
        quantity: 2,
        unitPrice: 80_000,
        amount: 160_000,
        metrics: { scenes: 16 },
      },
    ];
    const items = buildRenderData(input).items as RenderData[];
    expect(items.map((item) => item.line_no)).toEqual(['1', '2']);
    expect(items[0]).toMatchObject({ quantity_text: '2 bối cảnh', scenes: '16', sources: '—' });
    expect(items[1]).toMatchObject({ quantity_text: '61 shot', scenes: '—', tier_text: '—' });
  });

  it('maps the partner snapshot, with the permanent address when there is no contact address', () => {
    const data = partnerData({
      name: 'Nguyễn Hữu Hoàng',
      fields: {
        birthday: '1986-03-04',
        citizenIdNumber: '035086000030',
        idIssuedDate: '2021-08-10',
        permanentAddress: 'Hà Nam',
        bankCode: 'VCB',
        taxMode: 'WITHHOLD_10',
      },
    });
    expect(data).toMatchObject({
      full_name: 'Nguyễn Hữu Hoàng',
      dob: '04/03/1986',
      id_number: '035086000030',
      id_issued_date: '10/08/2021',
      address: 'Hà Nam',
      bank_name: 'VCB',
      tax_code: '',
      email: '',
    });
    expect(String(data.tax_mode_text)).toContain('khấu trừ 10%');
    expect(partnerData(null).full_name).toBe('');
  });

  it('prints contract terms: ceiling and advance in words, open end date, payment term', () => {
    const input = sampleRenderInput('contract', 'per_topic');
    input.contract.endDate = null;
    input.contract.signedDate = null;
    const contract = buildRenderData(input).contract as RenderData;
    expect(contract).toMatchObject({
      number: '070926/HĐSXND/AG-NVB',
      signed_date: '',
      document_date_text: 'ngày 07 tháng 10 năm 2026',
      end_date: '—',
      end_date_text: 'đến khi hai bên hoàn thành nghĩa vụ',
      cap_amount: '100.000.000',
      cap_amount_words: 'Một trăm triệu đồng',
      has_advance: true,
      advance_amount: '50.000.000',
      payment_term: '30 ngày làm việc',
      delivery_rule_text: 'Bên B bàn giao sản phẩm trước ngày 15 hằng tháng',
      penalty_percent: '8',
    });
    input.contract.capAmount = null;
    input.contract.advanceAmount = 0;
    expect(buildRenderData(input).contract).toMatchObject({
      has_cap: false,
      cap_amount: 'Không giới hạn',
      has_advance: false,
      advance_amount_words: '—',
    });
  });

  it('describes the delivery rule', () => {
    expect(deliveryRuleText({ type: 'flexible' }, 'weekly')).toContain('linh hoạt');
    expect(deliveryRuleText(null, 'weekly')).toBe('Bên B bàn giao sản phẩm hằng tuần');
  });

  it('prints the price of each pricing model', () => {
    expect(
      pricingData('per_topic', { unit_price: 2_500_000, min_topic_minutes: 20 }, null, []),
    ).toMatchObject({
      unit_price: '2.500.000',
      unit_price_words: 'Hai triệu năm trăm nghìn đồng',
      unit_label: 'chủ đề',
      max_topic_minutes: '—',
      topics_text: 'Theo thoả thuận của hai bên',
      is_per_topic: true,
    });
    expect(pricingData('per_unit', { unit: 'shot', unit_price: 300_000 }, null, [])).toMatchObject({
      unit_label: 'shot',
      is_clip: false,
      max_shots_per_clip: '—',
    });
    const tier = pricingData(
      'package_tier',
      { level: 'LV1', employment_stage: 'official' },
      sampleRenderInput('contract', 'package_tier').rateCard,
      ['CẢNH', 'KHÁM PHÁ'],
    );
    expect(tier).toMatchObject({
      level: 'LV1',
      employment_stage_text: 'Chính thức',
      products_text: 'CẢNH, KHÁM PHÁ',
      rate_card_effective_from: '15/07/2026',
      extra_scene_price: '80.000',
      unit_price: '—',
      has_per_source: true,
    });
    expect(tier.tiers).toEqual([
      {
        no: 1,
        product: 'CẢNH',
        tier: 3,
        tier_text: 'Mức 3',
        sources_text: '150–200 source',
        scenes: '14',
        price: '1.300.000',
      },
    ]);
    expect(tier.per_source).toEqual([
      { no: 1, product: 'Lái xe', price: '50.000', min_seconds: '300' },
    ]);
    expect(pricingData('package_tier', {}, null, [])).toMatchObject({
      has_rate_card: false,
      rate_card_code: '—',
      extra_scene_price: '—',
      tiers: [],
    });
  });

  it('writes the tech spec as sentences (Phụ lục B.3)', () => {
    const spec = techSpecData({
      min_width: 3840,
      min_height: 2160,
      fps: { target: 60, tolerance: 0.1 },
      source_duration_rule: { min_seconds: 10, preferred_seconds: 20, preferred_ratio: 0.8 },
      min_shots_per_scene: 5,
      reject_dead: true,
    });
    expect(spec).toMatchObject({
      resolution: '4K',
      resolution_text: '4K (3840×2160)',
      fps_text: '60 fps (sai lệch ±0,1)',
      min_shots_per_scene: '5',
      min_shot_seconds: '—',
      audio_text: 'Không bắt buộc âm thanh',
    });
    expect((spec.lines as RenderData[]).map((line) => line.text)).toEqual([
      'Độ phân giải tối thiểu 4K (3840×2160)',
      'Tốc độ khung hình 60 fps (sai lệch ±0,1)',
      '80% số source dài từ 20 giây, 20% còn lại dài từ 10 giây; source dưới 10 giây không được tính',
      'Mỗi bối cảnh có tối thiểu 5 shot',
      'Không nhận file lỗi, hỏng hoặc không phát được',
    ]);
    expect(techSpecData({ min_width: 1920, min_height: 1080 }).resolution).toBe('Full HD');
    expect(techSpecData({ min_width: 1280, min_height: 720 }).resolution_text).toBe('(1280×720)');
    expect((techSpecData({}).lines as RenderData[])[0].text).toBe('Theo thoả thuận của hai bên');
  });

  it('heads the quantity column by model (Phụ lục B.2)', () => {
    expect(quantityHeader('per_unit', { unit: 'clip' })).toBe('Số clip');
    expect(quantityHeader('per_unit', { unit: 'shot' })).toBe('Số shot');
  });

  it('lists the changes of an amendment', () => {
    const input = sampleRenderInput('amendment', 'per_topic');
    input.amendment!.changes = {
      pricing_config: { unit_price: 3_000_000, min_topic_minutes: 30 },
      cap_amount: null,
      end_date: '2027-12-31',
      payment_term_business_days: 10,
      penalty_percent: 5,
      tech_spec: { min_shot_seconds: 30 },
    };
    const amendment = buildRenderData(input).amendment as RenderData;
    expect(amendment.number).toBe('1');
    expect(amendment.effective_date_text).toBe('ngày 01 tháng 11 năm 2026');
    expect(
      (amendment.changes as RenderData[]).map((change) => [change.label, change.value]),
    ).toEqual([
      ['Giá và cấu hình giá', 'Đơn giá 3.000.000 đồng/chủ đề, mỗi chủ đề tối thiểu 30 phút'],
      ['Giá trị tối đa của hợp đồng', 'Không giới hạn'],
      ['Ngày kết thúc hợp đồng', '31/12/2027'],
      ['Thời hạn thanh toán', '10 ngày làm việc'],
      ['Mức phạt vi phạm', '5% giá trị hợp đồng'],
      ['Yêu cầu kỹ thuật', 'Mỗi shot dài tối thiểu 30 giây'],
    ]);
    const tier = sampleRenderInput('amendment', 'package_tier');
    tier.amendment!.changes = {
      pricing_config: { level: 'LV2', employment_stage: 'official' },
      cap_amount: 1_000_000,
    };
    const changes = (buildRenderData(tier).amendment as RenderData).changes as RenderData[];
    expect(changes[0].value).toContain('Cấp LV2');
    expect(changes[1].value).toBe('1.000.000 đồng (Một triệu đồng)');
  });

  it('leaves missing company data empty so issue can refuse it', () => {
    const input = sampleRenderInput('contract', 'per_unit');
    input.company = null;
    expect(buildRenderData(input).company).toMatchObject({ name: '', tax_code: '' });
  });
});
