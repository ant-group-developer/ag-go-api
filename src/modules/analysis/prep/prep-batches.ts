/** Farm `group_key` of a prep backfill: pausing / resuming / cancelling the group acts on all its jobs. */
export function prepBatchGroupKey(batchId: string): string {
  return `prep-batch:${batchId}`;
}

/** Storage folder of one prep, under the asset's variants folder. */
export function prepPrefix(variantsPrefix: string, prepId: string): string {
  return `${variantsPrefix}prep/${prepId}/`;
}

/**
 * `<prepId>:prep` (scan.prep) or `<prepId>:transcribe` (studio.transcribe) — the correlation ids
 * the prep pipeline submits.
 */
export const PREP_CORRELATION_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(prep|transcribe)$/;

export const PREP_JOB_TYPES = { prep: 'scan.prep', transcribe: 'studio.transcribe' } as const;

/** Priority and lane of a prep AG Studio waits for. */
export const INTERACTIVE_PREP_PRIORITY = 50;
/** Priority of new footage and backfills: below every Studio request. */
export const BATCH_PREP_PRIORITY = -10;

/** Whisper model the transcript is read with (the one AG Studio used). */
export const PREP_TRANSCRIBE_MODEL = 'large-v3';

/** Outbox event that sends a queued prep to the farm (scan.prep). */
export const ASSET_PREP_REQUESTED_EVENT = 'asset.prep.requested';
