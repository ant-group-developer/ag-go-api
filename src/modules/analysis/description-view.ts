/** Whole-video description as the API returns it (camelCase of the worker's `AssetDescription`). */
export type DescriptionView = {
  titleVi: string;
  summaryVi: string;
  summaryEn: string;
  genre: string;
  topics: string[];
  subjects: string[];
  places: string[];
  actions: string[];
  keywordsVi: string[];
  tags: string[];
  mood: string;
  setting: string;
  timeOfDay: string;
  peopleCount: string;
  shotVariety: string[];
  cameraMotions: string[];
  visibleText: string;
  hasWatermark: boolean;
  usable: boolean;
  usableReason: string;
  quality: number;
};

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function list(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** Maps the stored description (snake_case jsonb) to the API shape; missing fields get empty values. */
export function descriptionView(stored: Record<string, unknown>): DescriptionView {
  return {
    titleVi: text(stored['title_vi']),
    summaryVi: text(stored['summary_vi']),
    summaryEn: text(stored['summary_en']),
    genre: text(stored['genre']),
    topics: list(stored['topics']),
    subjects: list(stored['subjects']),
    places: list(stored['places']),
    actions: list(stored['actions']),
    keywordsVi: list(stored['keywords_vi']),
    tags: list(stored['tags']),
    mood: text(stored['mood']),
    setting: text(stored['setting']) || 'unknown',
    timeOfDay: text(stored['time_of_day']) || 'unknown',
    peopleCount: text(stored['people_count']) || 'none',
    shotVariety: list(stored['shot_variety']),
    cameraMotions: list(stored['camera_motions']),
    visibleText: text(stored['visible_text']),
    hasWatermark: stored['has_watermark'] === true,
    usable: stored['usable'] === true,
    usableReason: text(stored['usable_reason']),
    quality: typeof stored['quality'] === 'number' ? stored['quality'] : 0,
  };
}
