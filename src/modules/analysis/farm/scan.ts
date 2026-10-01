// Copied from ag-farm packages/protocol src/jobs/scan.ts (v2, whole-video scan) — keep in sync
import { z } from 'zod';
import { InputNameSchema, RelativePathSchema } from './protocol';

// ---------------------------------------------------------------------------------------------
// Quét hiểu nội dung CẢ video (v2). Không còn chia đoạn làm footage: cảnh chỉ dùng để chọn khung hình
// đại diện; mô tả, chỉ số kỹ thuật và "dùng được" đều tính cho cả file.
//
// scan.extract: tải file gốc → proxy 720p → dò cảnh → keyframe đại diện (≤ max_keyframes, bỏ trùng theo
// dHash) → chỉ số kỹ thuật cả video → contact sheet. Input: `source`. Manifest: `extract.json`.
// scan.ai: Qwen-VL (Ollama) xem keyframe theo nhóm rồi viết một mô tả cho cả video. Manifest: `ai.json`.
// ---------------------------------------------------------------------------------------------

export const ScanExtractParamsSchema = z.strictObject({
  /** Ngưỡng `scene` của ffmpeg (0–1). */
  scene_threshold: z.number().min(0).max(1).default(0.3),
  /** Cảnh ngắn hơn (giây) gộp vào cảnh trước. */
  min_scene_s: z.number().nonnegative().default(1),
  /** Số keyframe tối đa cho cả video; cảnh nhiều hơn thì rải đều theo thời gian. */
  max_keyframes: z.int().min(1).max(48).default(24),
  /** Hai keyframe có khoảng cách Hamming dHash ≤ ngưỡng này coi là trùng, bỏ khung sau (0–64). */
  keyframe_dedup_distance: z.int().min(0).max(64).default(8),
  /** Cạnh dài của keyframe (px). */
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
      /** Cạnh dài của một ô (px); ô giữ tỉ lệ khung, không cắt. */
      tile_px: z.int().min(80).max(640).default(320),
    })
    .default({ enabled: true, columns: 6, tile_px: 320 }),
  /** Ngưỡng coi cả video là "chết" về kỹ thuật (đen, đứng hình, mờ gần hết). */
  dead: z
    .strictObject({
      black_ratio_min: z.number().min(0).max(1).default(0.9),
      frozen_ratio_min: z.number().min(0).max(1).default(0.95),
      /** Điểm mờ (blurdetect, càng cao càng mờ) từ ngưỡng này trở lên coi là mờ hẳn. */
      blur_min: z.number().nonnegative().default(12),
    })
    .default({ black_ratio_min: 0.9, frozen_ratio_min: 0.95, blur_min: 12 }),
  /** Video có tiếng với tỉ lệ im lặng dưới ngưỡng này được đánh dấu "có thể có lời nói". */
  speech_silence_ratio_max: z.number().min(0).max(1).default(0.6),
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
  /** dHash 64 bit dạng 16 ký tự hex. */
  dhash: z.string().regex(/^[0-9a-f]{16}$/),
  /** Cảnh chứa khung này (chỉ số trong `scenes`). */
  scene_index: z.int().nonnegative(),
});
export type Keyframe = z.infer<typeof KeyframeSchema>;

export const SceneSchema = z.strictObject({
  index: z.int().nonnegative(),
  /** Mốc theo timeline file gốc (ms). Ảnh tĩnh: một cảnh 0–0. */
  start_ms: z.int().nonnegative(),
  end_ms: z.int().nonnegative(),
});
export type Scene = z.infer<typeof SceneSchema>;

export const AssetTechnicalSchema = z.strictObject({
  /** Độ sáng trung bình 0–1 (signalstats YAVG / 255). */
  brightness: z.number().min(0).max(1).nullable(),
  /** Điểm mờ trung bình của blurdetect; càng cao càng mờ. */
  blur: z.number().nonnegative().nullable(),
  black_ratio: z.number().min(0).max(1),
  frozen_ratio: z.number().min(0).max(1),
  /** Tỉ lệ im lặng; `null` khi không có audio. */
  silence_ratio: z.number().min(0).max(1).nullable(),
  /** Có tiếng và ít im lặng: có thể có lời nói (chưa nghe thật, chỉ là gợi ý). `null` khi không có audio. */
  has_speech_hint: z.boolean().nullable(),
  dead: z.boolean(),
  dead_reason: z.enum(['black', 'frozen', 'blurry']).nullable(),
});
export type AssetTechnical = z.infer<typeof AssetTechnicalSchema>;

export const EXTRACT_MANIFEST_SCHEMA = 'ag.scan.extract/v2';
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
    /** Góc xoay trong metadata (0/90/180/270); width/height ở trên đã tính xoay. */
    rotation: z.int(),
  }),
  orientation: OrientationSchema,
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
  scenes: z.array(SceneSchema).min(1),
  keyframes: z.array(KeyframeSchema).min(1).max(48),
  technical: AssetTechnicalSchema,
  tools: z.strictObject({
    ffmpeg: z.string().nullable(),
    worker_version: z.string(),
  }),
});
export type ExtractManifest = z.infer<typeof ExtractManifestSchema>;

// ---------------------------------------------------------------------------------------------
// scan.ai
// ---------------------------------------------------------------------------------------------

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
export const TIMES_OF_DAY = ['day', 'night', 'golden_hour', 'indoor', 'mixed', 'unknown'] as const;
export const SETTINGS = ['indoor', 'outdoor', 'mixed', 'unknown'] as const;
export const PEOPLE_COUNTS = ['none', 'one', 'few', 'many', 'crowd'] as const;

function wordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

const ShortListSchema = (max: number) => z.array(z.string().min(1).max(60)).max(max);

/** Mô tả cả một video: đơn vị mà Studio chọn và ghép. */
export const AssetDescriptionSchema = z.strictObject({
  /** Tiêu đề ngắn gọi tên nội dung video. */
  title_vi: z.string().min(1).max(120),
  summary_vi: z
    .string()
    .min(1)
    .max(1200)
    .refine((value) => wordCount(value) <= 120, {
      message: 'summary_vi must be at most 120 words',
    }),
  summary_en: z
    .string()
    .min(1)
    .max(900)
    .refine((value) => wordCount(value) <= 90, { message: 'summary_en must be at most 90 words' }),
  /** Thể loại, ví dụ `ẩm thực đường phố`, `phong cảnh`, `phỏng vấn`. */
  genre: z.string().min(1).max(60),
  topics: ShortListSchema(10),
  subjects: ShortListSchema(15),
  places: ShortListSchema(10),
  actions: ShortListSchema(15),
  keywords_vi: ShortListSchema(20),
  tags: ShortListSchema(20),
  /** Không khí / cảm xúc chung, ví dụ `nhộn nhịp`, `yên bình`. */
  mood: z.string().max(60),
  setting: z.enum(SETTINGS),
  time_of_day: z.enum(TIMES_OF_DAY),
  people_count: z.enum(PEOPLE_COUNTS),
  /** Các cỡ cảnh xuất hiện trong video. */
  shot_variety: z.array(z.enum(SHOT_SIZES)).max(6),
  camera_motions: z.array(z.enum(CAMERA_MOTIONS)).max(8),
  visible_text: z.string().max(500),
  has_watermark: z.boolean(),
  usable: z.boolean(),
  usable_reason: z.string().max(200),
  quality: z.int().min(0).max(5),
});
export type AssetDescription = z.infer<typeof AssetDescriptionSchema>;

/** Số keyframe tối đa gửi cho scan.ai (bằng trần `max_keyframes`). */
export const SCAN_AI_MAX_KEYFRAMES = 48;

export const ScanAiPayloadSchema = z.strictObject({
  asset_id: z.uuid(),
  model: z.string().min(1).max(200),
  prompt_version: z.string().min(1).max(40),
  /** Ngữ cảnh gợi ý, có thể sai; prompt phải ghi rõ điều đó. */
  context: z
    .strictObject({
      /** Tên file gốc: thường mô tả nội dung. */
      asset_name: z.string().max(300).nullable().default(null),
      project_names: z.array(z.string().max(200)).max(10).default([]),
      category_names: z.array(z.string().max(200)).max(10).default([]),
      province_names: z.array(z.string().max(200)).max(10).default([]),
    })
    .default({ asset_name: null, project_names: [], category_names: [], province_names: [] }),
  /** Thông tin kỹ thuật từ extract, giúp mô tả (thời lượng, có tiếng / lời nói). */
  media: z.strictObject({
    duration_ms: z.int().nonnegative(),
    has_audio: z.boolean(),
    has_speech_hint: z.boolean().nullable(),
  }),
  keyframes: z
    .array(
      z.strictObject({
        /** Tên input, ví dụ `artifact:keyframes/0003.jpg`. */
        input: InputNameSchema,
        t_ms: z.int().nonnegative(),
      }),
    )
    .min(1)
    .max(SCAN_AI_MAX_KEYFRAMES),
  options: z
    .strictObject({
      keep_alive: z.string().max(20).default('2m'),
      repair_attempts: z.int().min(0).max(3).default(1),
      /** Số khung trong một lần gọi model ở bước ghi chú (VRAM nhỏ thì giảm). */
      frames_per_note: z.int().min(1).max(8).default(4),
    })
    .default({ keep_alive: '2m', repair_attempts: 1, frames_per_note: 4 }),
});
export type ScanAiPayload = z.infer<typeof ScanAiPayloadSchema>;

export const AI_MANIFEST_SCHEMA = 'ag.scan.ai/v2';
export const AI_MANIFEST_PATH = 'ai.json';
export const AI_TRACE_PATH = 'ai-trace.json';

export const AiManifestSchema = z.strictObject({
  schema: z.literal(AI_MANIFEST_SCHEMA),
  asset_id: z.uuid(),
  model: z.string(),
  prompt_version: z.string(),
  /** `null` khi model không cho được mô tả hợp lệ sau mọi lần sửa (xem `error`). */
  description: AssetDescriptionSchema.nullable(),
  /** Ghi chú từng nhóm khung (bước 1), giữ lại để xem vì sao mô tả như vậy. */
  notes: z.array(z.string().max(2000)).max(SCAN_AI_MAX_KEYFRAMES),
  error: z.string().max(2000).nullable(),
  duration_ms: z.int().nonnegative(),
});
export type AiManifest = z.infer<typeof AiManifestSchema>;
