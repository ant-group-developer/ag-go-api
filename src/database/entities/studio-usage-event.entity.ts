import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export const STUDIO_USAGE_KINDS = [
  'source_added',
  'source_removed',
  'final_render',
  'premiere_export',
] as const;
export type StudioUsageKind = (typeof STUDIO_USAGE_KINDS)[number];

/** One use of footage AG Studio reported (see `POST /usage/studio-events`). */
@Entity('studio_usage_events')
export class StudioUsageEventEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id!: string;

  /** Studio's key of the event; a resent event is ignored. */
  @Column({ name: 'event_key', type: 'varchar', length: 200, unique: true })
  eventKey!: string;

  @Column({ type: 'varchar', length: 30 })
  kind!: StudioUsageKind;

  @Column({ name: 'asset_id', type: 'uuid', nullable: true })
  assetId!: string | null;

  @Column({ name: 'ag_go_project_id', type: 'uuid', nullable: true })
  agGoProjectId!: string | null;

  /** The Studio job of a final render / Premiere export, read from `job:<jobId>:<assetId>` keys. */
  @Column({ name: 'studio_job_id', type: 'varchar', length: 100, nullable: true })
  studioJobId!: string | null;

  @Column({ name: 'studio_project_id', type: 'varchar', length: 100 })
  studioProjectId!: string;

  @Column({ name: 'studio_project_name', type: 'varchar', length: 500 })
  studioProjectName!: string;

  @Column({ name: 'studio_video_id', type: 'varchar', length: 100, nullable: true })
  studioVideoId!: string | null;

  @Column({ name: 'studio_video_title', type: 'varchar', length: 500, nullable: true })
  studioVideoTitle!: string | null;

  /** Auth0 subject without `auth0|`, like every user id in ag-go. */
  @Column({ name: 'studio_user_id', type: 'varchar', length: 128, nullable: true })
  studioUserId!: string | null;

  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date;

  @Column({ name: 'received_at', type: 'timestamptz', default: () => 'now()' })
  receivedAt!: Date;
}
