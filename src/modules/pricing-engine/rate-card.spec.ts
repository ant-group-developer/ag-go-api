import { addBusinessDays, previousDay } from './business-days';
import { d7RateCard } from './d7-price-table';
import { addSourceCounts, durationRatio, formatPercent } from './durations';
import { missingMessage } from './package-tier';
import {
  levelRuleFor,
  selectRateCardVersion,
  tiersFor,
  validateRateCard,
  type RateCardItemData,
} from './rate-card';

const IDS = {
  camping: 'c1',
  'kham-pha': 'c2',
  'doi-song': 'c3',
  canh: 'c4',
  flycam: 'c5',
  'lai-xe': 'c6',
};

describe('selectRateCardVersion (Q-R1)', () => {
  const versions = [
    {
      id: 'v1',
      version: 1,
      status: 'published' as const,
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-07-14',
    },
    {
      id: 'v2',
      version: 2,
      status: 'published' as const,
      effectiveFrom: '2026-07-15',
      effectiveTo: null,
    },
    {
      id: 'v3',
      version: 3,
      status: 'draft' as const,
      effectiveFrom: '2026-08-01',
      effectiveTo: null,
    },
    {
      id: 'v0',
      version: 0,
      status: 'archived' as const,
      effectiveFrom: '2025-01-01',
      effectiveTo: null,
    },
  ];

  it.each([
    ['2026-07-14', 'v1'],
    ['2026-07-15', 'v2'],
    ['2026-09-01', 'v2'],
    ['2025-06-01', null],
  ])('on %s picks %s', (date, id) => {
    expect(selectRateCardVersion(versions, date)?.id ?? null).toBe(id);
  });

  it('takes the highest version when two overlap', () => {
    const overlapping = [
      { version: 1, status: 'published' as const, effectiveFrom: '2026-01-01', effectiveTo: null },
      { version: 2, status: 'published' as const, effectiveFrom: '2026-01-01', effectiveTo: null },
    ];
    expect(selectRateCardVersion(overlapping, '2026-02-01')?.version).toBe(2);
  });
});

describe('validateRateCard', () => {
  it('accepts the D7 card', () => {
    const card = d7RateCard(IDS);
    expect(validateRateCard(card)).toEqual([]);
    expect(tiersFor(card.items, 'c4', 'LV1').map((tier) => tier.price)).toEqual([
      500_000, 900_000, 1_300_000,
    ]);
    expect(levelRuleFor(card.levelRules, 'LV3')?.extraSceneMinSources).toBe(13);
    expect(levelRuleFor([], 'LV1')).toBeNull();
    expect(
      tiersFor(
        [
          {
            id: 'item-1',
            categoryId: 'x',
            level: 'LV1',
            pricingType: 'tier',
            tier: 1,
            sourceMin: null,
            sourceMax: null,
            sceneMin: null,
            price: 5,
            minSourceSeconds: null,
          },
        ],
        'x',
        'LV1',
      ),
    ).toEqual([
      { tier: 1, sourceMin: 0, sourceMax: null, sceneMin: 0, price: 5, itemId: 'item-1' },
    ]);
  });

  it('reports every problem', () => {
    const tier = (overrides: Partial<RateCardItemData>): RateCardItemData => ({
      categoryId: 'c1',
      level: 'LV1',
      pricingType: 'tier',
      tier: 1,
      sourceMin: 70,
      sourceMax: 100,
      sceneMin: 7,
      price: 1,
      minSourceSeconds: null,
      ...overrides,
    });
    const errors = validateRateCard({
      durationRule: { minSeconds: 30, preferredSeconds: 20, preferredRatio: 2 },
      items: [
        tier({}),
        tier({}),
        tier({ tier: 3, sourceMin: 10, sceneMin: 1 }),
        tier({ level: 'ALL' }),
        tier({ tier: 0 }),
        tier({ level: 'LV2', tier: 1, sourceMin: null }),
        tier({ price: -1, tier: 2, sourceMin: 100, sceneMin: 10 }),
        {
          categoryId: 'c1',
          level: 'LV1',
          pricingType: 'per_source',
          tier: 2,
          sourceMin: null,
          sourceMax: null,
          sceneMin: null,
          price: 1,
          minSourceSeconds: -1,
        },
        {
          categoryId: 'c1',
          level: 'ALL',
          pricingType: 'per_source',
          tier: null,
          sourceMin: null,
          sourceMax: null,
          sceneMin: null,
          price: 1,
          minSourceSeconds: 300,
        },
      ],
      levelRules: [
        { level: 'LV1', extraScenePrice: 1, extraSceneMinSources: 8 },
        { level: 'LV1', extraScenePrice: -1, extraSceneMinSources: 8 },
      ],
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('durationRule'),
        expect.stringContaining('trùng ô giá LV1 Mức 1'),
        expect.stringContaining('level: giá theo Mức cần cấp'),
        expect.stringContaining('tier: Mức phải là số nguyên'),
        expect.stringContaining('cần sourceMin, sceneMin'),
        expect.stringContaining('price: phải là số nguyên không âm'),
        expect.stringContaining('giá theo source dùng level ALL'),
        expect.stringContaining('minSourceSeconds: không được âm'),
        expect.stringContaining('trùng giá theo source'),
        expect.stringContaining('vừa tính theo Mức vừa theo source'),
        expect.stringContaining('các Mức phải liên tiếp từ 1'),
        expect.stringContaining('không được thấp hơn'),
        expect.stringContaining('trùng cấp LV1'),
        expect.stringContaining('phụ trội và số source tối thiểu'),
        expect.stringContaining('thiếu quy tắc của cấp LV2'),
      ]),
    );
  });
});

describe('helpers', () => {
  it('adds business days skipping weekends and holidays (BR-34)', () => {
    // Friday 2026-07-24 + 1 → Monday 27.
    expect(addBusinessDays('2026-07-24', 1)).toBe('2026-07-27');
    expect(addBusinessDays('2026-07-24', 0)).toBe('2026-07-24');
    expect(addBusinessDays('2026-07-24', 10)).toBe('2026-08-07');
    expect(addBusinessDays('2026-08-28', 2, new Set(['2026-09-01', '2026-09-02']))).toBe(
      '2026-09-03',
    );
    expect(() => addBusinessDays('2026-7-1', 1)).toThrow();
    expect(() => addBusinessDays('2026-07-01', -1)).toThrow();
    expect(previousDay('2026-07-15')).toBe('2026-07-14');
    expect(previousDay('2026-03-01')).toBe('2026-02-28');
  });

  it('formats, adds and checks duration ratios', () => {
    expect(formatPercent(0.7386)).toBe('73,9%');
    expect(formatPercent(0.8)).toBe('80%');
    expect(
      durationRatio(0, 0, { minSeconds: 10, preferredSeconds: 20, preferredRatio: 0.8 }),
    ).toEqual({
      ratio: null,
      met: true,
    });
    expect(
      addSourceCounts(
        { files: 1, shortFiles: 1, unknownDuration: 0, validSources: 0, preferredSources: 0 },
        { files: 2, shortFiles: 0, unknownDuration: 1, validSources: 1, preferredSources: 1 },
      ),
    ).toEqual({
      files: 3,
      shortFiles: 1,
      unknownDuration: 1,
      validSources: 1,
      preferredSources: 1,
    });
    expect(missingMessage(0, 0)).toBe('đã đủ');
  });
});
