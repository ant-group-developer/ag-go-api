import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { AssetPrepBatchEntity } from './asset-prep-batch.entity';
import { AssetEntity } from './asset.entity';

/**
 * `queued`: waiting to be sent (or held by a paused batch); `cutting`: scan.prep sent;
 * `transcribing`: studio.transcribe sent; `ready`: shots and sheets in, transcript done or given up.
 */
export type AssetPrepStatus =
  'queued' | 'cutting' | 'transcribing' | 'ready' | 'failed' | 'cancelled';

export const PREP_UNFINISHED_STATUSES: AssetPrepStatus[] = ['queued', 'cutting', 'transcribing'];
export const PREP_FINISHED_STATUSES: AssetPrepStatus[] = ['ready', 'failed', 'cancelled'];

/**
 * `none`: no audio; `pending`: not read yet; `skipped`: the analysis found no speech; `done`;
 * `failed`: the prep is still ready (the transcript is an extra, as it is in Studio).
 */
export type PrepTranscriptStatus = 'none' | 'pending' | 'skipped' | 'done' | 'failed';

export type PrepLane = 'interactive' | 'batch';

/** One shot as stored; paths are relative to the prep folder `<variants>/prep/<prepId>/`. */
export type PrepShot = { n: number; in: number; out: number; frame: string };
export type PrepSheet = { file: string; shots: number[] };
export type PrepScene = { threshold: number; min_shot_s: number; max_shot_s: number };

/** The raw WhisperX transcript of the asset (its TranscribeManifest source, without the id). */
export type PrepTranscript = {
  language: string | null;
  alignment: 'word' | 'segment';
  engine: string;
  segments: Array<{
    start: number;
    end: number;
    text: string;
    words: Array<{ word: string; start: number; end: number; score?: number }>;
  }>;
};

/**
 * Studio inputs of one video, prepared once on the farm and read by every Studio project: shots
 * (scene cuts by Studio's rules), one 480 px frame per shot, contact sheets and the transcript.
 */
@Entity('asset_preps')
export class AssetPrepEntity {
  /** uuidv7, set by the app. */
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'asset_id', type: 'uuid' })
  assetId!: string;

  @ManyToOne(() => AssetEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'asset_id' })
  asset?: AssetEntity;

  @Column({ type: 'varchar', length: 20, default: 'queued' })
  status!: AssetPrepStatus;

  @Column({ name: 'is_current', type: 'boolean', default: false })
  isCurrent!: boolean;

  @Column({ type: 'varchar', length: 20, default: 'batch' })
  lane!: PrepLane;

  @Column({ type: 'integer', default: 0 })
  priority!: number;

  @Column({ name: 'batch_id', type: 'uuid', nullable: true })
  batchId!: string | null;

  @ManyToOne(() => AssetPrepBatchEntity, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'batch_id' })
  batch?: AssetPrepBatchEntity;

  @Column({ name: 'requested_by', type: 'varchar', length: 128, nullable: true })
  requestedBy!: string | null;

  /** File scan.prep read: `preview` (clean rendition), `proxy` (analysis proxy) or `original`. */
  @Column({ name: 'source_kind', type: 'varchar', length: 20, nullable: true })
  sourceKind!: string | null;

  @Column({ type: 'boolean', nullable: true })
  watermarked!: boolean | null;

  @Column({ name: 'duration_s', type: 'double precision', nullable: true })
  durationS!: number | null;

  @Column({ type: 'integer', nullable: true })
  width!: number | null;

  @Column({ type: 'integer', nullable: true })
  height!: number | null;

  @Column({ type: 'double precision', nullable: true })
  fps!: number | null;

  @Column({ name: 'has_audio', type: 'boolean', nullable: true })
  hasAudio!: boolean | null;

  @Column({ type: 'jsonb', nullable: true })
  scene!: PrepScene | null;

  @Column({ type: 'jsonb', nullable: true })
  shots!: PrepShot[] | null;

  @Column({ type: 'jsonb', nullable: true })
  sheets!: PrepSheet[] | null;

  @Column({ type: 'jsonb', nullable: true })
  transcript!: PrepTranscript | null;

  /** Plain text of the transcript (for footage search later). */
  @Column({ name: 'transcript_text', type: 'text', nullable: true })
  transcriptText!: string | null;

  @Column({ name: 'transcript_status', type: 'varchar', length: 20, default: 'pending' })
  transcriptStatus!: PrepTranscriptStatus;

  @Column({ type: 'varchar', length: 20, nullable: true })
  language!: string | null;

  /** Why the prep failed, or why its transcript did. */
  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'prepared_at', type: 'timestamptz', nullable: true })
  preparedAt!: Date | null;
}
