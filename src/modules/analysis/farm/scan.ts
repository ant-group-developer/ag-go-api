// Copied from ag-farm packages/protocol v0.1.0 — keep in sync
import { z } from 'zod';
import { InputNameSchema, RelativePathSchema } from './protocol';

export const ScanExtractParamsSchema = z.strictObject({
  window_s: z.number().positive().default(4),
  max_segment_s: z.number().positive().default(20),
  min_segment_s: z.number().nonnegative().default(1.5),
  merge_dhash_max_distance: z.int().min(0).max(64).default(10),
  scene_threshold: z.number().min(0).max(1).default(0.3),
  keyframes_per_segment: z.int().min(1).max(3).default(3),
  keyframe_px: z.int().min(160).max(1920).default(640),
  proxy: z
    .strictObject({
      enabled: z.boolean().default(true),
      height: z.int().min(240).max(1080).default(720),
      crf: z.int().min(16).max(40).default(26),
      gop_s: z.number().positive().default(1),
    })
    .default({ enabled: true, height: 720, crf: 26, gop_s: 1 }),
  contact_sheet: z
    .strictObject({
      enabled: z.boolean().default(true),
      columns: z.int().min(1).max(12).default(6),
      tile_px: z.int().min(80).max(640).default(320),
    })
    .default({ enabled: true, columns: 6, tile_px: 320 }),
  dead: z
    .strictObject({
      black_ratio_min: z.number().min(0).max(1).default(0.9),
      frozen_ratio_min: z.number().min(0).max(1).default(0.95),
      blur_min: z.number().nonnegative().default(12),
    })
    .default({ black_ratio_min: 0.9, frozen_ratio_min: 0.95, blur_min: 12 }),
});
export type ScanExtractParams = z.infer<typeof ScanExtractParamsSchema>;

export const ScanExtractPayloadSchema = z.strictObject({
  asset: z.strictObject({
    id: z.uuid(),
    kind: z.enum(['video', 'image']),
    mime_type: z.string().max(120),
    size_bytes: z.int().nonnegative().nullable(),
    checksum_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    duration_ms: z.int().nonnegative().nullable(),
    width: z.int().positive().nullable(),
    height: z.int().positive().nullable(),
  }),
  params: ScanExtractParamsSchema.default(ScanExtractParamsSchema.parse({})),
  extract_version: z.string().min(1).max(40),
});
export type ScanExtractPayload = z.infer<typeof ScanExtractPayloadSchema>;

export const OrientationSchema = z.enum(['landscape', 'portrait', 'square']);
export type Orientation = z.infer<typeof OrientationSchema>;

export const KeyframeSchema = z.strictObject({
  output: RelativePathSchema,
  t_ms: z.int().nonnegative(),
  width: z.int().positive(),
  height: z.int().positive(),
  dhash: z.string().regex(/^[0-9a-f]{16}$/),
});
export type Keyframe = z.infer<typeof KeyframeSchema>;

export const SegmentTechnicalSchema = z.strictObject({
  brightness: z.number().min(0).max(1).nullable(),
  blur: z.number().nonnegative().nullable(),
  black_ratio: z.number().min(0).max(1),
  frozen_ratio: z.number().min(0).max(1),
  silence_ratio: z.number().min(0).max(1).nullable(),
  dead: z.boolean(),
  dead_reason: z.enum(['black', 'frozen', 'blurry']).nullable(),
});
export type SegmentTechnical = z.infer<typeof SegmentTechnicalSchema>;

export const ExtractSegmentSchema = z.strictObject({
  index: z.int().nonnegative(),
  start_ms: z.int().nonnegative(),
  end_ms: z.int().nonnegative(),
  boundary_reason: z.enum(['scene_cut', 'window', 'max_length', 'end', 'still']),
  orientation: OrientationSchema,
  keyframes: z.array(KeyframeSchema).min(1).max(3),
  technical: SegmentTechnicalSchema,
});
export type ExtractSegment = z.infer<typeof ExtractSegmentSchema>;

export const EXTRACT_MANIFEST_SCHEMA = 'ag.scan.extract/v1';
export const EXTRACT_MANIFEST_PATH = 'extract.json';

export const ExtractManifestSchema = z.strictObject({
  schema: z.literal(EXTRACT_MANIFEST_SCHEMA),
  asset_id: z.uuid(),
  extract_version: z.string(),
  media: z.strictObject({
    kind: z.enum(['video', 'image']),
    duration_ms: z.int().nonnegative(),
    width: z.int().positive(),
    height: z.int().positive(),
    fps: z.number().positive().nullable(),
    has_audio: z.boolean(),
    rotation: z.int(),
  }),
  proxy: z
    .strictObject({
      output: RelativePathSchema,
      width: z.int().positive(),
      height: z.int().positive(),
      size_bytes: z.int().nonnegative(),
    })
    .nullable(),
  contact_sheet: z
    .strictObject({
      output: RelativePathSchema,
      columns: z.int().positive(),
      rows: z.int().positive(),
    })
    .nullable(),
  segments: z.array(ExtractSegmentSchema).min(1),
  tools: z.strictObject({
    ffmpeg: z.string().nullable(),
    worker_version: z.string(),
  }),
});
export type ExtractManifest = z.infer<typeof ExtractManifestSchema>;

export const SHOT_SIZES = [
  'extreme_wide',
  'wide',
  'medium',
  'close_up',
  'extreme_close_up',
  'unknown',
] as const;
export const CAMERA_MOTIONS = [
  'static',
  'pan',
  'tilt',
  'zoom',
  'dolly',
  'handheld',
  'aerial',
  'unknown',
] as const;
export const TIMES_OF_DAY = ['day', 'night', 'golden_hour', 'indoor', 'unknown'] as const;
export const SETTINGS = ['indoor', 'outdoor', 'mixed', 'unknown'] as const;
export const PEOPLE_COUNTS = ['none', 'one', 'few', 'many', 'crowd'] as const;

function wordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

const ShortListSchema = (max: number) => z.array(z.string().min(1).max(60)).max(max);

export const SegmentDescriptionSchema = z.strictObject({
  caption_vi: z
    .string()
    .min(1)
    .max(400)
    .refine((value) => wordCount(value) <= 40, { message: 'caption_vi must be at most 40 words' }),
  caption_en: z
    .string()
    .min(1)
    .max(300)
    .refine((value) => wordCount(value) <= 30, { message: 'caption_en must be at most 30 words' }),
  tags: ShortListSchema(20),
  keywords_vi: ShortListSchema(20),
  subjects: ShortListSchema(10),
  actions: ShortListSchema(10),
  shot_size: z.enum(SHOT_SIZES),
  camera_motion: z.enum(CAMERA_MOTIONS),
  time_of_day: z.enum(TIMES_OF_DAY),
  setting: z.enum(SETTINGS),
  people_count: z.enum(PEOPLE_COUNTS),
  visible_text: z.string().max(300),
  has_watermark: z.boolean(),
  usable: z.boolean(),
  usable_reason: z.string().max(200),
  quality: z.int().min(0).max(5),
});
export type SegmentDescription = z.infer<typeof SegmentDescriptionSchema>;

/** Maximum number of segments per scan.ai job. */
export const SCAN_AI_MAX_CHUNK = 30;

export const ScanAiPayloadSchema = z.strictObject({
  asset_id: z.uuid(),
  chunk: z.int().nonnegative(),
  model: z.string().min(1).max(200),
  prompt_version: z.string().min(1).max(40),
  context: z
    .strictObject({
      project_names: z.array(z.string().max(200)).max(10).default([]),
      category_names: z.array(z.string().max(200)).max(10).default([]),
      province_names: z.array(z.string().max(200)).max(10).default([]),
    })
    .default({ project_names: [], category_names: [], province_names: [] }),
  segments: z
    .array(
      z.strictObject({
        segment_id: z.uuid(),
        index: z.int().nonnegative(),
        start_ms: z.int().nonnegative(),
        end_ms: z.int().nonnegative(),
        keyframes: z.array(InputNameSchema).min(1).max(3),
      }),
    )
    .min(1)
    .max(SCAN_AI_MAX_CHUNK),
  options: z
    .strictObject({
      keep_alive: z.string().max(20).default('2m'),
      repair_attempts: z.int().min(0).max(3).default(1),
    })
    .default({ keep_alive: '2m', repair_attempts: 1 }),
});
export type ScanAiPayload = z.infer<typeof ScanAiPayloadSchema>;

export const AI_MANIFEST_SCHEMA = 'ag.scan.ai/v1';
export function aiManifestPath(chunk: number): string {
  return `ai-${String(chunk).padStart(4, '0')}.json`;
}

export const AiManifestSchema = z.strictObject({
  schema: z.literal(AI_MANIFEST_SCHEMA),
  asset_id: z.uuid(),
  chunk: z.int().nonnegative(),
  model: z.string(),
  prompt_version: z.string(),
  items: z.array(
    z.strictObject({
      segment_id: z.uuid(),
      description: SegmentDescriptionSchema.nullable(),
      error: z.string().max(2000).nullable(),
      duration_ms: z.int().nonnegative(),
    }),
  ),
});
export type AiManifest = z.infer<typeof AiManifestSchema>;
