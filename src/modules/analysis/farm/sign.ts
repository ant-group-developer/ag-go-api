// Copied from ag-farm packages/protocol v0.1.0 — keep in sync
import { z } from 'zod';
import { InputNameSchema, IsoDateTimeSchema, RelativePathSchema } from './protocol';

const ContentTypeSchema = z.string().min(3).max(120);
const UploadIdSchema = z.string().min(1).max(1024);

export const SignOpSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('get'), input: InputNameSchema }),
  z.strictObject({
    op: z.literal('put'),
    output: RelativePathSchema,
    content_type: ContentTypeSchema,
  }),
  z.strictObject({
    op: z.literal('mp_create'),
    output: RelativePathSchema,
    content_type: ContentTypeSchema,
  }),
  z.strictObject({
    op: z.literal('mp_part_urls'),
    output: RelativePathSchema,
    upload_id: UploadIdSchema,
    parts: z.array(z.int().min(1).max(10000)).min(1).max(100),
  }),
  z.strictObject({
    op: z.literal('mp_complete'),
    output: RelativePathSchema,
    upload_id: UploadIdSchema,
    parts: z
      .array(
        z.strictObject({
          part_number: z.int().min(1).max(10000),
          etag: z.string().min(1).max(200),
        }),
      )
      .min(1)
      .max(10000),
  }),
  z.strictObject({
    op: z.literal('mp_abort'),
    output: RelativePathSchema,
    upload_id: UploadIdSchema,
  }),
]);
export type SignOp = z.infer<typeof SignOpSchema>;

export const SignRequestSchema = z.strictObject({
  ops: z.array(SignOpSchema).min(1).max(100),
});
export type SignRequest = z.infer<typeof SignRequestSchema>;

export const SourceMetaSchema = z.strictObject({
  source_kind: z.enum(['original', 'proxy', 'preview']),
  watermarked: z.boolean(),
  start_ms: z.int().nonnegative().nullable(),
  end_ms: z.int().nonnegative().nullable(),
});
export type SourceMeta = z.infer<typeof SourceMetaSchema>;

export const SignResultSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('get'),
    input: InputNameSchema,
    url: z.url(),
    expires_at: IsoDateTimeSchema,
    size_bytes: z.int().nonnegative().nullable(),
    content_type: z.string().nullable(),
    cache_key: z.string().max(200).nullable(),
    source: SourceMetaSchema.nullable(),
  }),
  z.strictObject({
    op: z.literal('put'),
    output: RelativePathSchema,
    url: z.url(),
    expires_at: IsoDateTimeSchema,
    headers: z.record(z.string(), z.string()),
  }),
  z.strictObject({
    op: z.literal('mp_create'),
    output: RelativePathSchema,
    upload_id: UploadIdSchema,
  }),
  z.strictObject({
    op: z.literal('mp_part_urls'),
    output: RelativePathSchema,
    upload_id: UploadIdSchema,
    expires_at: IsoDateTimeSchema,
    urls: z.array(z.strictObject({ part_number: z.int().min(1).max(10000), url: z.url() })),
  }),
  z.strictObject({ op: z.literal('mp_complete'), output: RelativePathSchema }),
  z.strictObject({ op: z.literal('mp_abort'), output: RelativePathSchema }),
]);
export type SignResult = z.infer<typeof SignResultSchema>;

export const SignResponseSchema = z.strictObject({
  results: z.array(SignResultSchema),
});
export type SignResponse = z.infer<typeof SignResponseSchema>;
