// Copied from ag-farm packages/protocol src/jobs/studio.ts (studio.transcribe only) — keep in sync
import { z } from 'zod';
import { InputNameSchema } from './protocol';

// ---------------------------------------------------------------------------------------------
// studio.transcribe: nhận dạng lời nói (WhisperX) trên máy render có GPU. ag-go gửi cho bước prep:
// một nguồn là `artifact:audio.wav` do scan.prep tách sẵn. Output `transcribe.json`.
// ---------------------------------------------------------------------------------------------

export const StudioTranscribePayloadSchema = z
  .strictObject({
    production_id: z.string().min(1).max(100),
    /** Tên mô hình faster-whisper. */
    model: z
      .string()
      .min(1)
      .max(60)
      .regex(/^[A-Za-z0-9._-]+$/)
      .default('large-v3'),
    sources: z
      .array(
        z.strictObject({
          /** Id nguồn, trả lại nguyên trong manifest. */
          source_id: z
            .string()
            .min(1)
            .max(100)
            .regex(/^[A-Za-z0-9_-]+$/),
          /** WAV 16 kHz mono. */
          audio: InputNameSchema,
          /** Mã ngôn ngữ (`vi`, `en`); `null` = để mô hình tự nhận. */
          language: z.string().min(2).max(10).nullable().default(null),
        }),
      )
      .min(1)
      .max(200),
    /** Căn mốc từng từ bằng mô hình căn chỉnh của WhisperX; tắt thì chỉ có mốc theo câu. */
    align_words: z.boolean().default(true),
  })
  .refine((p) => new Set(p.sources.map((s) => s.source_id)).size === p.sources.length, {
    message: 'source_id must be unique',
    path: ['sources'],
  });
export type StudioTranscribePayload = z.infer<typeof StudioTranscribePayloadSchema>;

export const TRANSCRIBE_MANIFEST_SCHEMA = 'ag.studio.transcribe/v1';
export const TRANSCRIBE_MANIFEST_PATH = 'transcribe.json';

const TranscribeWordSchema = z.strictObject({
  word: z.string().min(1),
  start: z.number().min(0),
  end: z.number().min(0),
  score: z.number().min(0).max(1).optional(),
});

export const TranscribeManifestSchema = z.strictObject({
  schema: z.literal(TRANSCRIBE_MANIFEST_SCHEMA),
  production_id: z.string(),
  engine: z.strictObject({ name: z.string(), version: z.string().nullable() }),
  sources: z.array(
    z.strictObject({
      source_id: z.string(),
      /** Ngôn ngữ nhận ra (hoặc đã cho); `null` khi nguồn không có lời. */
      language: z.string().nullable(),
      /** `word` khi căn được từng từ, `segment` khi chỉ có mốc theo câu. */
      alignment: z.enum(['word', 'segment']),
      segments: z.array(
        z.strictObject({
          start: z.number().min(0),
          end: z.number().min(0),
          text: z.string(),
          words: z.array(TranscribeWordSchema).default([]),
        }),
      ),
    }),
  ),
});
export type TranscribeManifest = z.infer<typeof TranscribeManifestSchema>;
