// Copied from ag-farm packages/protocol (common.ts, owner-api.ts) — keep in sync
import { z } from 'zod';

export const JOB_TYPES = [
  'scan.extract',
  'scan.ai',
  'studio.tts',
  'studio.render_preview',
  'studio.render_final',
] as const;
export const JobTypeSchema = z.enum(JOB_TYPES);
export type JobType = z.infer<typeof JobTypeSchema>;

export const LANES = ['interactive', 'batch'] as const;
export const LaneSchema = z.enum(LANES);
export type Lane = z.infer<typeof LaneSchema>;

export const JOB_STATUSES = [
  'queued',
  'leased',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const;
export const JobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const OwnerIdSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9-]*$/);

function hasDotDotSegment(value: string): boolean {
  return value.split('/').some((segment) => segment === '..' || segment === '.' || segment === '');
}

export const RelativePathSchema = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9._\-/]+$/)
  .refine((value) => !hasDotDotSegment(value), {
    message: 'Path must not contain empty, . or .. segments',
  });

export const InputNameSchema = z
  .string()
  .min(1)
  .max(320)
  .regex(/^[a-z][a-z0-9_]*(:[A-Za-z0-9._\-/]+)?$/)
  .refine(
    (value) => {
      const colon = value.indexOf(':');
      return colon < 0 || !hasDotDotSegment(value.slice(colon + 1));
    },
    { message: 'Input path must not contain empty, . or .. segments' },
  );

export function splitInputName(name: string): { kind: string; path: string | null } {
  const colon = name.indexOf(':');
  return colon < 0
    ? { kind: name, path: null }
    : { kind: name.slice(0, colon), path: name.slice(colon + 1) };
}

export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

export const ResultSummarySchema = z.record(
  z.string().max(60),
  z.union([z.string().max(500), z.number(), z.boolean(), z.null()]),
);

export const JobResultSchema = z.strictObject({
  manifest: RelativePathSchema.nullable(),
  summary: ResultSummarySchema.default({}),
});
export type JobResult = z.infer<typeof JobResultSchema>;

export const JobErrorSchema = z.strictObject({
  code: z.string().min(1).max(80),
  message: z.string().max(2000),
  retryable: z.boolean(),
});
export type JobError = z.infer<typeof JobErrorSchema>;

export const JobViewSchema = z.strictObject({
  id: z.uuid(),
  owner: OwnerIdSchema,
  type: JobTypeSchema,
  lane: LaneSchema,
  status: JobStatusSchema,
  priority: z.int(),
  correlation_id: z.string(),
  affinity_key: z.string().nullable(),
  group_key: z.string().nullable(),
  attempt_count: z.int().nonnegative(),
  max_attempts: z.int().positive(),
  node_id: z.uuid().nullable(),
  progress_percent: z.number().nullable(),
  progress_stage: z.string().nullable(),
  result: JobResultSchema.nullable(),
  error: JobErrorSchema.nullable(),
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
  finished_at: IsoDateTimeSchema.nullable(),
  acked_at: IsoDateTimeSchema.nullable(),
});
export type JobView = z.infer<typeof JobViewSchema>;

export const SubmitJobRequestSchema = z.strictObject({
  type: JobTypeSchema,
  lane: LaneSchema.optional(),
  priority: z.int().min(-100).max(100).default(0),
  requirements: z.record(z.string(), z.unknown()).default({}),
  affinity_key: z.string().max(200).nullable().default(null),
  payload: z.unknown(),
  max_attempts: z.int().min(1).max(20).default(3),
  correlation_id: z.string().min(1).max(200),
  not_before: IsoDateTimeSchema.nullable().default(null),
  /** Nhóm để tạm dừng / chạy tiếp / huỷ cả loạt: `batch:<id>` của một đợt quét. */
  group_key: z.string().min(1).max(200).nullable().default(null),
});
export type SubmitJobRequest = z.input<typeof SubmitJobRequestSchema>;

export const SubmitJobResponseSchema = z.strictObject({
  job: JobViewSchema,
  created: z.boolean(),
});
export type SubmitJobResponse = z.infer<typeof SubmitJobResponseSchema>;

export const GetJobResponseSchema = z.strictObject({
  job: JobViewSchema,
});
export type GetJobResponse = z.infer<typeof GetJobResponseSchema>;

export const ListJobsResponseSchema = z.strictObject({
  jobs: z.array(JobViewSchema),
  next_cursor: z.string().nullable(),
});
export type ListJobsResponse = z.infer<typeof ListJobsResponseSchema>;

/** `POST /v1/owner/jobs/{pause|resume|cancel}`: theo danh sách id hoặc cả nhóm. */
export const JobControlResponseSchema = z.strictObject({ affected: z.int().nonnegative() });
export type JobControlResponse = z.infer<typeof JobControlResponseSchema>;
export type JobControlAction = 'pause' | 'resume' | 'cancel';

export const OWNER_API = {
  jobs: '/v1/owner/jobs',
  job: (jobId: string) => `/v1/owner/jobs/${jobId}`,
  ack: (jobId: string) => `/v1/owner/jobs/${jobId}/ack`,
  cancel: (jobId: string) => `/v1/owner/jobs/${jobId}/cancel`,
} as const;
