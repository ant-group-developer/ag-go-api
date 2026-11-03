/**
 * Spec 6.8 test cases TC-1 … TC-12 and the real acceptance records D1/D2, D4 and D6
 * ("dac-ta-hop-dong-nghiem-thu"), on the pure pricing engine.
 */
import * as engine from '.';
import { advanceOffsetFor, calculateAmounts, taxFor } from './amounts';
import { D7_EXPLORATION_SURCHARGE, d7RateCard } from './d7-price-table';
import { countSources, DEFAULT_DURATION_RULE, type SourceCounts } from './durations';
import { computePackageTier, type PackageProjectFacts } from './package-tier';
import {
  computePerSource,
  computePerTopic,
  computePerUnit,
  countPerSource,
  countShots,
  type TopicProjectFacts,
} from './per-project';
import {
  levelRuleFor,
  perSourceItemFor,
  selectRateCardVersion,
  tiersFor,
  type CtvLevel,
  type RateCardContent,
} from './rate-card';

const CATEGORY = {
  camping: 'cat-camping',
  'kham-pha': 'cat-kham-pha',
  'doi-song': 'cat-doi-song',
  canh: 'cat-canh',
  flycam: 'cat-flycam',
  'lai-xe': 'cat-lai-xe',
} as const;

/** The two seeded versions (spec 7.2.1): v1 until 14/07/2026, v2 (Khám phá +200k) from 15/07. */
const VERSIONS = [
  {
    version: 1,
    status: 'published' as const,
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-07-14',
    content: d7RateCard(CATEGORY),
  },
  {
    version: 2,
    status: 'published' as const,
    effectiveFrom: '2026-07-15',
    effectiveTo: null,
    content: d7RateCard(CATEGORY, D7_EXPLORATION_SURCHARGE),
  },
];

function rateCardOn(date: string): RateCardContent {
  const version = selectRateCardVersion(VERSIONS, date);
  if (!version) throw new Error(`no version on ${date}`);
  return version.content;
}

/** A project whose approved videos have these durations (seconds). */
function project(id: string, durations: number[], evaluated = true): PackageProjectFacts {
  return { projectId: id, evaluated, ...countSources(durations, DEFAULT_DURATION_RULE) };
}

/** `count` projects of `sourcesEach` 25 s videos. */
function projects(
  count: number,
  sourcesEach: number | number[],
  prefix = 'p',
): PackageProjectFacts[] {
  return Array.from({ length: count }, (_, index) =>
    project(
      `${prefix}${index + 1}`,
      Array(Array.isArray(sourcesEach) ? sourcesEach[index] : sourcesEach).fill(25),
    ),
  );
}

function priceOf(
  categoryKey: keyof typeof CATEGORY,
  level: CtvLevel,
  facts: PackageProjectFacts[],
  periodEnd = '2026-07-01',
  mode: 'final' | 'provisional' = 'final',
) {
  const card = rateCardOn(periodEnd);
  const rule = levelRuleFor(card.levelRules, level)!;
  return computePackageTier({
    tiers: tiersFor(card.items, CATEGORY[categoryKey], level),
    extraScenePrice: rule.extraScenePrice,
    extraSceneMinSources: rule.extraSceneMinSources,
    durationRule: card.durationRule,
    projects: facts,
    mode,
  });
}

function distribute(total: number, buckets: number): number[] {
  return Array.from(
    { length: buckets },
    (_, index) => Math.floor(total / buckets) + (index < total % buckets ? 1 : 0),
  );
}

// ---------------------------------------------------------------------------

describe('TC-1 per_topic (D1 / D2: Nguyễn Hữu Hoàng, phụ lục số 2)', () => {
  it('29 topics × 2.500.000 = 72.500.000; tax 7.250.000; net 65.250.000', () => {
    const facts: TopicProjectFacts[] = Array.from({ length: 29 }, (_, index) => ({
      projectId: `topic-${index}`,
      approvedSeconds: 20 * 60 + index * 30,
      pendingMedia: 0,
      unknownDuration: 0,
    }));
    const result = computePerTopic(
      { unitPrice: 2_500_000, minTopicMinutes: 20, maxTopicMinutes: 60 },
      facts,
    );
    expect(result.quantity).toBe(29);
    expect(result.amount).toBe(72_500_000);
    const amounts = calculateAmounts({ lineAmounts: [result.amount], taxRatePercent: 10 });
    expect(amounts).toMatchObject({ gross: 72_500_000, tax: 7_250_000, net: 65_250_000 });
    expect(amounts.netWords).toBe('Sáu mươi lăm triệu hai trăm năm mươi nghìn đồng');
  });
});

describe('TC-2 per_topic short of minutes', () => {
  it('a project with 18 minutes is not counted, with the reason', () => {
    const result = computePerTopic({ unitPrice: 2_500_000, minTopicMinutes: 20 }, [
      { projectId: 'short', approvedSeconds: 18 * 60, pendingMedia: 0, unknownDuration: 0 },
      { projectId: 'ok', approvedSeconds: 25 * 60, pendingMedia: 0, unknownDuration: 0 },
    ]);
    expect(result.quantity).toBe(1);
    expect(result.projects[0]).toMatchObject({
      counted: false,
      reason: 'below_min_minutes',
      message: 'Thiếu 2 phút so với tối thiểu 20 phút',
    });
  });

  it('pending media block the topic; over max only warns', () => {
    const result = computePerTopic({ unitPrice: 100, minTopicMinutes: 20, maxTopicMinutes: 60 }, [
      { projectId: 'pending', approvedSeconds: 40 * 60, pendingMedia: 2, unknownDuration: 1 },
      { projectId: 'long', approvedSeconds: 75 * 60, pendingMedia: 0, unknownDuration: 0 },
    ]);
    expect(result.projects[0]).toMatchObject({
      counted: false,
      reason: 'pending_media',
      message: 'Còn 2 media chưa nghiệm thu',
      excluded: { unknown_duration: 1 },
    });
    expect(result.quantity).toBe(1);
    expect(result.warnings).toEqual([expect.objectContaining({ code: 'OVER_MAX_MINUTES' })]);
  });
});

describe('TC-3 per_unit shot (D4: Nguyễn Văn Cường, THIÊN NHIÊN)', () => {
  it('61 shots × 300.000 = 18.300.000; tax 1.830.000; net 16.470.000', () => {
    const media = Array.from({ length: 61 }, (_, index) => ({
      durationSeconds: 60 + index,
      specResult: 'pass' as const,
      approvedWithReason: false,
    }));
    const facts = countShots('nature', media, 60);
    const result = computePerUnit({ unit: 'shot', unitPrice: 300_000, minShotSeconds: 60 }, [
      facts,
    ]);
    expect(result).toMatchObject({ quantity: 61, amount: 18_300_000 });
    const amounts = calculateAmounts({ lineAmounts: [result.amount], taxRatePercent: 10 });
    expect(amounts).toMatchObject({ tax: 1_830_000, net: 16_470_000 });
    expect(amounts.netWords).toBe('Mười sáu triệu bốn trăm bảy mươi nghìn đồng');
  });

  it('short, unknown and unjustified technical fails are left out (BR-11)', () => {
    const facts = countShots(
      'mixed',
      [
        { durationSeconds: 59, specResult: 'pass', approvedWithReason: false },
        { durationSeconds: null, specResult: 'unknown', approvedWithReason: false },
        { durationSeconds: 90, specResult: 'fail', approvedWithReason: false },
        { durationSeconds: 90, specResult: 'fail', approvedWithReason: true },
        { durationSeconds: 61, specResult: 'warn', approvedWithReason: false },
      ],
      60,
    );
    expect(facts).toEqual({
      projectId: 'mixed',
      shots: 2,
      belowMinDuration: 1,
      unknownDuration: 1,
      specFail: 1,
    });
    const result = computePerUnit({ unit: 'shot', unitPrice: 300_000, minShotSeconds: 60 }, [
      facts,
    ]);
    expect(result.amount).toBe(600_000);
    expect(result.projects[0].message).toBe(
      'Bị loại: 1 shot dưới 60 giây, 1 shot chưa có thời lượng, 1 shot không đạt kỹ thuật, duyệt không có lý do',
    );
    // Without a minimum, durations do not matter.
    expect(
      countShots(
        'any',
        [{ durationSeconds: null, specResult: null, approvedWithReason: false }],
        null,
      ).shots,
    ).toBe(1);
  });

  it('clips: ⌈shots / max⌉ per project, 7 shots = 2 clips (Q7)', () => {
    const result = computePerUnit({ unit: 'clip', unitPrice: 1_000_000, maxShotsPerClip: 5 }, [
      { projectId: 'a', shots: 7, belowMinDuration: 0, unknownDuration: 0, specFail: 0 },
      { projectId: 'b', shots: 5, belowMinDuration: 0, unknownDuration: 0, specFail: 0 },
      { projectId: 'c', shots: 0, belowMinDuration: 2, unknownDuration: 0, specFail: 0 },
    ]);
    expect(result.projects.map((line) => line.quantity)).toEqual([2, 1, 0]);
    expect(result.projects[2]).toMatchObject({ counted: false, reason: 'no_qualifying_shot' });
    expect(result.amount).toBe(3_000_000);
    expect(() => computePerUnit({ unit: 'clip', unitPrice: 1 }, [])).toThrow('max_shots_per_clip');
    expect(() => computePerUnit({ unit: 'shot', unitPrice: -1 }, [])).toThrow();
  });
});

describe('TC-4 per_unit with an advance', () => {
  it('TC-3 on a contract with 50.000.000 advance, full_first: offset 16.470.000, pay 0, 33.530.000 left', () => {
    const shots = computePerUnit({ unit: 'shot', unitPrice: 300_000, minShotSeconds: 60 }, [
      { projectId: 'nature', shots: 61, belowMinDuration: 0, unknownDuration: 0, specFail: 0 },
    ]);
    const tax = taxFor(shots.amount, 10);
    const offset = advanceOffsetFor({
      rule: 'full_first',
      gross: shots.amount,
      tax,
      advanceRemaining: 50_000_000,
      advanceAmount: 50_000_000,
      capAmount: 100_000_000,
    });
    const amounts = calculateAmounts({
      lineAmounts: [shots.amount],
      taxRatePercent: 10,
      advanceOffset: offset,
    });
    expect(amounts).toMatchObject({ tax: 1_830_000, advanceOffset: 16_470_000, net: 0 });
    expect(50_000_000 - offset).toBe(33_530_000);
  });
});

describe('TC-5 real data D6 (Nguyễn Thị Xuân N., phụ lục số 4)', () => {
  it('LV1 CẢNH, 14 projects, 158 sources → Mức 3 = 1.300.000; tax 130.000; net 1.170.000', () => {
    const result = priceOf('canh', 'LV1', projects(14, distribute(158, 14)));
    expect(result).toMatchObject({
      scenes: 14,
      sources: 158,
      tier: 3,
      tierPrice: 1_300_000,
      extraScenes: 0,
      amount: 1_300_000,
      next: null,
      warnings: [],
    });
    const amounts = calculateAmounts({ lineAmounts: [result.amount], taxRatePercent: 10 });
    expect(amounts).toMatchObject({ tax: 130_000, net: 1_170_000 });
    expect(amounts.netWords).toBe('Một triệu một trăm bảy mươi nghìn đồng');
  });
});

describe('TC-6 missing scenes', () => {
  it('LV2 ĐỜI SỐNG, 120 sources in 6 projects → only Mức 1 = 800.000', () => {
    const result = priceOf('doi-song', 'LV2', projects(6, 20));
    expect(result).toMatchObject({
      sources: 120,
      scenes: 6,
      tier: 1,
      amount: 800_000,
      sourceTier: 2,
    });
    expect(result.next).toMatchObject({ tier: 2, missingSources: 0, missingScenes: 1 });
    expect(result.next?.message).toBe('Lên Mức 2: thiếu 1 bối cảnh');
    expect(result.warnings).toEqual([
      {
        code: 'SCENES_LIMIT_TIER',
        message: 'Đủ source cho Mức 2 nhưng thiếu 1 bối cảnh: thêm bối cảnh hoặc tách gói',
      },
    ]);
  });
});

describe('TC-7 price by effective date (Q-R1)', () => {
  it('LV1 KHÁM PHÁ, 120 sources, 8 projects, period ending 20/07 → 800.000 + 200.000', () => {
    const result = priceOf('kham-pha', 'LV1', projects(8, 15), '2026-07-20');
    expect(result).toMatchObject({ tier: 1, amount: 1_000_000 });
    // The same package in a period ending 14/07 is on version 1.
    expect(priceOf('kham-pha', 'LV1', projects(8, 15), '2026-07-14').amount).toBe(800_000);
  });
});

describe('TC-8 extra scenes LV2', () => {
  it('LV2 CAMPING, 230 sources, 16 projects ≥ 8 sources → 1.800.000 + 3 × 100.000', () => {
    const result = priceOf('camping', 'LV2', projects(16, distribute(230, 16)));
    expect(result).toMatchObject({
      tier: 3,
      tierPrice: 1_800_000,
      extraScenes: 3,
      extraScenePrice: 100_000,
      extraAmount: 300_000,
      amount: 2_100_000,
    });
  });
});

describe('TC-9 LV3 scenes short of sources', () => {
  it('3 of 16 projects with 10 sources (< 13) do not count → 13 scenes, Mức 3 = 2.000.000', () => {
    const facts = [...projects(13, 13, 'ok'), ...projects(3, 10, 'thin')];
    const result = priceOf('camping', 'LV3', facts);
    expect(result).toMatchObject({
      scenes: 13,
      excludedScenes: 3,
      sources: 169,
      tier: 3,
      extraScenes: 0,
      amount: 2_000_000,
    });
    expect(result.projects.filter((line) => !line.counted)).toEqual([
      expect.objectContaining({
        reason: 'too_few_sources',
        message: 'Chỉ có 10 source hợp lệ, cần tối thiểu 13 để tính là bối cảnh',
      }),
      expect.anything(),
      expect.anything(),
    ]);
  });
});

describe('TC-10 below Mức 1', () => {
  it('LV1 KHÁM PHÁ, 60 sources, 7 projects → "Gói chưa đạt Mức 1: thiếu 10 source"', () => {
    const result = priceOf(
      'kham-pha',
      'LV1',
      projects(7, distribute(60, 7)),
      '2026-07-01',
      'provisional',
    );
    expect(result).toMatchObject({ tier: null, amount: 0, belowTier1: true });
    expect(result.next).toMatchObject({ tier: 1, missingSources: 10, missingScenes: 0 });
    expect(result.warnings[0]).toEqual({
      code: 'BELOW_TIER_1',
      message: 'Gói chưa đạt Mức 1: thiếu 10 source',
    });
  });

  it('names missing scenes too', () => {
    const result = priceOf('kham-pha', 'LV1', projects(5, 10));
    expect(result.warnings[0].message).toBe('Gói chưa đạt Mức 1: thiếu 20 source và 2 bối cảnh');
  });
});

describe('TC-11 80/20 duration rule (Q-R3)', () => {
  it('158 files: 5 < 10s, 40 of 10–19s, 113 ≥ 20s → 153 sources, 73,9% < 80% warns', () => {
    const durations = [...Array(5).fill(8), ...Array(40).fill(15), ...Array(113).fill(30)];
    // Dealt round-robin over 14 projects, so each keeps more than 8 sources.
    const facts = Array.from({ length: 14 }, (_, index) =>
      project(
        `scene-${index}`,
        durations.filter((_, position) => position % 14 === index),
      ),
    );
    const result = priceOf('canh', 'LV1', facts);
    expect(result).toMatchObject({
      sources: 153,
      preferredSources: 113,
      shortFiles: 5,
      durationRatio: 0.7386,
      durationRuleMet: false,
      tier: 3,
      amount: 1_300_000,
    });
    expect(result.warnings).toEqual([
      {
        code: 'DURATION_RATIO',
        message: 'Không đạt 80/20: 113/153 source ≥ 20s (73,9% < 80%)',
      },
    ]);
  });

  it('exactly 80% passes; unknown durations warn', () => {
    const counts: SourceCounts = countSources(
      [...Array(8).fill(20), 15, 12, null],
      DEFAULT_DURATION_RULE,
    );
    expect(counts).toEqual({
      files: 11,
      shortFiles: 0,
      unknownDuration: 1,
      validSources: 10,
      preferredSources: 8,
    });
    const result = priceOf('canh', 'LV1', [{ projectId: 'x', evaluated: true, ...counts }]);
    expect(result.durationRuleMet).toBe(true);
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      'BELOW_TIER_1',
      'UNKNOWN_DURATION',
    ]);
  });
});

describe('TC-12 Lái xe (per_source)', () => {
  it('12 files, one of 4 minutes → 11 × 50.000 = 550.000, 1 left out "dưới 5 phút"', () => {
    const card = rateCardOn('2026-07-01');
    const item = perSourceItemFor(card.items, CATEGORY['lai-xe'])!;
    const facts = countPerSource('drive', [...Array(11).fill(310), 240], item.minSourceSeconds!);
    const result = computePerSource(
      { pricePerSource: item.price, minSourceSeconds: item.minSourceSeconds! },
      [facts, countPerSource('empty', [null], 300)],
    );
    expect(result).toMatchObject({ quantity: 11, unitPrice: 50_000, amount: 550_000 });
    expect(result.projects[0]).toMatchObject({
      counted: true,
      quantity: 11,
      excluded: { below_min_duration: 1 },
      message: 'Bị loại: 1 file dưới 5 phút',
    });
    expect(result.projects[1]).toMatchObject({
      counted: false,
      reason: 'no_qualifying_source',
      message: 'Bị loại: 1 file chưa có thời lượng',
    });
    expect(perSourceItemFor(card.items, CATEGORY.canh)).toBeNull();
    expect(
      computePerSource({ pricePerSource: 1, minSourceSeconds: 90 }, [countPerSource('x', [30], 90)])
        .projects[0].message,
    ).toBe('Bị loại: 1 file dưới 90 giây');
  });
});

describe('package tier details', () => {
  it('exports the engine from its index', () => {
    expect(engine.computePackageTier).toBe(computePackageTier);
    expect(engine.acceptanceMoneyWords(1_000)).toBe('Một nghìn đồng');
  });

  it('final mode leaves unevaluated projects out; provisional counts them', () => {
    const facts = [...projects(13, 12), project('late', Array(12).fill(25), false)];
    const final = priceOf('camping', 'LV1', facts);
    expect(final.scenes).toBe(13);
    expect(final.projects.at(-1)).toMatchObject({ reason: 'not_evaluated' });
    expect(final.warnings.map((warning) => warning.code)).toContain('NOT_EVALUATED');
    const provisional = priceOf('camping', 'LV1', facts, '2026-07-01', 'provisional');
    expect(provisional).toMatchObject({ scenes: 14, extraScenes: 1, amount: 1_680_000 });
  });

  it('more than 200 sources is still Mức 3 (source_max is display only)', () => {
    expect(priceOf('canh', 'LV1', projects(14, 30))).toMatchObject({
      sources: 420,
      tier: 3,
      amount: 1_300_000,
    });
  });

  it('needs tiers', () => {
    expect(() =>
      computePackageTier({
        tiers: [],
        extraScenePrice: 0,
        extraSceneMinSources: 8,
        durationRule: DEFAULT_DURATION_RULE,
        projects: [],
        mode: 'final',
      }),
    ).toThrow('Bảng giá không có Mức');
  });
});
