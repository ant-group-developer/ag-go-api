import { DEFAULT_DURATION_RULE } from './durations';
import type { CtvLevel, LevelRuleData, RateCardContent, RateCardItemData } from './rate-card';

/**
 * "Bảng lương CTV (chuẩn)" (D7, spec 2.1.1): the reference rate card. Used by the tests; the seed
 * migration keeps its own frozen copy.
 */

export type D7ProductKey = 'camping' | 'kham-pha' | 'doi-song' | 'canh';
export type D7PerSourceKey = 'flycam' | 'lai-xe';

export const D7_SOURCE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [70, 100],
  [100, 150],
  [150, 200],
];

export const D7_PRODUCTS: ReadonlyArray<{
  key: D7ProductKey;
  name: string;
  sceneMins: readonly [number, number, number];
  prices: Record<CtvLevel, readonly [number, number, number]>;
}> = [
  {
    key: 'camping',
    name: 'CAMPING',
    sceneMins: [7, 10, 13],
    prices: {
      LV1: [800_000, 1_200_000, 1_600_000],
      LV2: [1_000_000, 1_400_000, 1_800_000],
      LV3: [1_200_000, 1_600_000, 2_000_000],
    },
  },
  {
    key: 'kham-pha',
    name: 'KHÁM PHÁ',
    sceneMins: [7, 10, 13],
    prices: {
      LV1: [800_000, 1_200_000, 1_600_000],
      LV2: [1_000_000, 1_400_000, 1_800_000],
      LV3: [1_200_000, 1_600_000, 2_000_000],
    },
  },
  {
    key: 'doi-song',
    name: 'ĐỜI SỐNG',
    sceneMins: [5, 7, 9],
    prices: {
      LV1: [600_000, 1_000_000, 1_400_000],
      LV2: [800_000, 1_200_000, 1_600_000],
      LV3: [800_000, 1_200_000, 1_600_000],
    },
  },
  {
    key: 'canh',
    name: 'CẢNH',
    sceneMins: [6, 10, 14],
    prices: {
      LV1: [500_000, 900_000, 1_300_000],
      LV2: [700_000, 1_100_000, 1_500_000],
      LV3: [700_000, 1_100_000, 1_500_000],
    },
  },
];

export const D7_PER_SOURCE: ReadonlyArray<{
  key: D7PerSourceKey;
  name: string;
  price: number;
  minSourceSeconds: number;
}> = [
  { key: 'flycam', name: 'Flycam', price: 50_000, minSourceSeconds: 300 },
  { key: 'lai-xe', name: 'Lái xe', price: 50_000, minSourceSeconds: 300 },
];

export const D7_LEVEL_RULES: readonly LevelRuleData[] = [
  { level: 'LV1', extraScenePrice: 80_000, extraSceneMinSources: 8 },
  { level: 'LV2', extraScenePrice: 100_000, extraSceneMinSources: 8 },
  { level: 'LV3', extraScenePrice: 150_000, extraSceneMinSources: 13 },
];

/** "Khám phá" costs this much more on every tier and level from 15/07/2026 (Q-R5). */
export const D7_EXPLORATION_SURCHARGE = 200_000;

/**
 * The D7 rate card for the given category ids; `explorationSurcharge` adds to every KHÁM PHÁ cell
 * (version 2, from 15/07/2026).
 */
export function d7RateCard(
  categoryIds: Record<D7ProductKey | D7PerSourceKey, string>,
  explorationSurcharge = 0,
): RateCardContent {
  const items: RateCardItemData[] = [];
  for (const product of D7_PRODUCTS) {
    for (const level of ['LV1', 'LV2', 'LV3'] as const) {
      product.prices[level].forEach((price, index) => {
        items.push({
          categoryId: categoryIds[product.key],
          level,
          pricingType: 'tier',
          tier: index + 1,
          sourceMin: D7_SOURCE_RANGES[index][0],
          sourceMax: D7_SOURCE_RANGES[index][1],
          sceneMin: product.sceneMins[index],
          price: price + (product.key === 'kham-pha' ? explorationSurcharge : 0),
          minSourceSeconds: null,
        });
      });
    }
  }
  for (const product of D7_PER_SOURCE) {
    items.push({
      categoryId: categoryIds[product.key],
      level: 'ALL',
      pricingType: 'per_source',
      tier: null,
      sourceMin: null,
      sourceMax: null,
      sceneMin: null,
      price: product.price,
      minSourceSeconds: product.minSourceSeconds,
    });
  }
  return { durationRule: { ...DEFAULT_DURATION_RULE }, items, levelRules: [...D7_LEVEL_RULES] };
}
