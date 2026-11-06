import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { R2InventoryClient, type ListedObject } from './r2-inventory.client';
import {
  classifyStorageKey,
  projectIdOfKey,
  topLevelPrefix,
  variantAssetIdOfKey,
  type StorageKeyLookup,
} from './storage-audit-classifier';
import {
  STORAGE_AUDIT_CATEGORIES,
  type ByteCount,
  type StorageAuditCategory,
  type StorageAuditView,
} from './storage-monitor.types';

/** Audits run on their own once a week; an admin can ask for one in between. */
export const AUDIT_INTERVAL_DAYS = 7;
/** A running audit renews its lock while it lists; one not renewed for this long is restarted. */
const AUDIT_LOCK_MINUTES = 10;
/** Progress (and the lock) is saved every this many pages of 1000 objects. */
const PROGRESS_EVERY_PAGES = 20;
const TOP_OBJECTS = 50;
const OTHER_PREFIXES = 30;

type AuditRow = {
  id: string;
  status: StorageAuditView['status'];
  trigger: StorageAuditView['trigger'];
  requested_by: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  listed_objects: string;
  listed_bytes: string;
  multipart_uploads: number | null;
  multipart_bytes: string | null;
  categories: StorageAuditView['categories'] | null;
  other_prefixes: StorageAuditView['otherPrefixes'] | null;
  top_objects: StorageAuditView['topObjects'] | null;
  error: string | null;
};

/**
 * Full listing of the bucket, every object sorted into a category by what the database says of
 * its key (see `classifyStorageKey`). Pages are looked up as they are listed, so memory stays
 * flat however large the bucket is. Several outbox hosts may run the loop: an audit is claimed
 * with `FOR UPDATE SKIP LOCKED` and kept with `locked_until`.
 */
@Injectable()
export class StorageAuditService {
  private readonly logger = new Logger(StorageAuditService.name);
  private stopping = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly inventory: R2InventoryClient,
  ) {}

  stop(): void {
    this.stopping = true;
  }

  /** Queues the weekly audit when none was created in the last week. */
  async scheduleIfDue(): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext('storage-audit:schedule'))`);
      const recent = (await manager.query(
        `SELECT 1 FROM storage_audits WHERE created_at > now() - make_interval(days => $1) LIMIT 1`,
        [AUDIT_INTERVAL_DAYS],
      )) as unknown[];
      if (recent.length === 0) {
        await manager.query(
          `INSERT INTO storage_audits (id, status, trigger) VALUES ($1, 'queued', 'schedule')`,
          [uuidv7()],
        );
      }
    });
  }

  /** Queues an audit for an admin, or returns the one already queued or running. */
  async request(userId: string): Promise<StorageAuditView> {
    const row = await this.dataSource.transaction(async (manager) => {
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext('storage-audit:schedule'))`);
      const open = (await manager.query(
        `SELECT * FROM storage_audits WHERE status IN ('queued', 'running')
         ORDER BY created_at DESC LIMIT 1`,
      )) as AuditRow[];
      if (open[0]) {
        return open[0];
      }
      const created = (await manager.query(
        `INSERT INTO storage_audits (id, status, trigger, requested_by)
         VALUES ($1, 'queued', 'manual', $2) RETURNING *`,
        [uuidv7(), userId],
      )) as AuditRow[];
      return created[0];
    });
    return toAuditView(row);
  }

  async latest(): Promise<{ latest: StorageAuditView | null; completed: StorageAuditView | null }> {
    const [latest, completed] = (await Promise.all([
      this.dataSource.query(`SELECT * FROM storage_audits ORDER BY created_at DESC LIMIT 1`),
      this.dataSource.query(
        `SELECT * FROM storage_audits WHERE status = 'completed' ORDER BY created_at DESC LIMIT 1`,
      ),
    ])) as [AuditRow[], AuditRow[]];
    return {
      latest: latest[0] ? toAuditView(latest[0]) : null,
      completed: completed[0] ? toAuditView(completed[0]) : null,
    };
  }

  /** Claims the oldest queued audit (or one whose host stopped) and runs it to the end. */
  async runNext(): Promise<void> {
    const claimed = (await this.dataSource.query(
      `UPDATE storage_audits
       SET status = 'running', started_at = now(), finished_at = NULL, error = NULL,
           listed_objects = 0, listed_bytes = 0,
           locked_until = now() + make_interval(mins => $1)
       WHERE id = (
         SELECT id FROM storage_audits
         WHERE status = 'queued' OR (status = 'running' AND locked_until < now())
         ORDER BY created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id`,
      [AUDIT_LOCK_MINUTES],
    )) as [Array<{ id: string }>, number];
    // An UPDATE ... RETURNING comes back as [rows, affected].
    const id = claimed[0][0]?.id;
    if (!id) {
      return;
    }
    this.logger.log(`Storage audit ${id} started on bucket "${this.inventory.bucket}"`);
    try {
      const finished = await this.run(id);
      if (finished) {
        this.logger.log(`Storage audit ${id} completed`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Storage audit ${id} failed: ${message}`);
      await this.dataSource.query(
        `UPDATE storage_audits SET status = 'failed', error = $2, finished_at = now(),
           locked_until = NULL
         WHERE id = $1`,
        [id, message.slice(0, 2000)],
      );
    }
  }

  /** Returns false when the worker is stopping: the audit stays `running` and is restarted. */
  private async run(id: string): Promise<boolean> {
    const categories = new Map<StorageAuditCategory, ByteCount>();
    const otherPrefixes = new Map<string, ByteCount>();
    let top: StorageAuditView['topObjects'] = [];
    let objects = 0;
    let bytes = 0;
    let pages = 0;

    for await (const page of this.inventory.listObjectPages()) {
      if (this.stopping) {
        return false;
      }
      const lookup = await this.lookUp(page);
      for (const object of page) {
        const category = classifyStorageKey(object.key, lookup);
        addTo(categories, category, object.bytes);
        if (category === 'other') {
          addTo(otherPrefixes, topLevelPrefix(object.key), object.bytes);
        }
        if (STORAGE_AUDIT_CATEGORIES[category] !== 'counted' && object.bytes > 0) {
          top.push({ key: object.key, bytes: object.bytes, category });
        }
        objects += 1;
        bytes += object.bytes;
      }
      if (top.length > TOP_OBJECTS * 4) {
        top = largest(top, TOP_OBJECTS);
      }
      pages += 1;
      if (pages % PROGRESS_EVERY_PAGES === 0) {
        await this.dataSource.query(
          `UPDATE storage_audits SET listed_objects = $2, listed_bytes = $3,
             locked_until = now() + make_interval(mins => $4)
           WHERE id = $1`,
          [id, objects, bytes, AUDIT_LOCK_MINUTES],
        );
      }
    }

    const multipart = await this.inventory.openMultipartUploads();
    const categoryList = [...categories.entries()]
      .map(([category, count]) => ({
        category,
        group: STORAGE_AUDIT_CATEGORIES[category],
        ...count,
      }))
      .sort((a, b) => b.bytes - a.bytes);
    const prefixList = [...otherPrefixes.entries()]
      .map(([prefix, count]) => ({ prefix, ...count }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, OTHER_PREFIXES);
    await this.dataSource.query(
      `UPDATE storage_audits
       SET status = 'completed', finished_at = now(), locked_until = NULL,
           listed_objects = $2, listed_bytes = $3, multipart_uploads = $4, multipart_bytes = $5,
           categories = $6::jsonb, other_prefixes = $7::jsonb, top_objects = $8::jsonb
       WHERE id = $1`,
      [
        id,
        objects,
        bytes,
        multipart.uploads,
        multipart.bytes,
        JSON.stringify(categoryList),
        JSON.stringify(prefixList),
        JSON.stringify(largest(top, TOP_OBJECTS)),
      ],
    );
    return true;
  }

  /** What the database knows of the keys of one page, in four indexed queries. */
  private async lookUp(page: ListedObject[]): Promise<StorageKeyLookup> {
    const keys = page.map((object) => object.key);
    const projectIds = [...new Set(keys.map(projectIdOfKey).filter((id) => id !== null))];
    const assetIds = [...new Set(keys.map(variantAssetIdOfKey).filter((id) => id !== null))];
    const [originals, variants, projects, assets] = (await Promise.all([
      this.dataSource.query(
        `SELECT a.original_storage_key AS key,
                bool_or(EXISTS (SELECT 1 FROM project_media pm WHERE pm.asset_id = a.id)) AS linked
         FROM assets a
         WHERE a.original_storage_key = ANY($1::text[])
         GROUP BY a.original_storage_key`,
        [keys],
      ),
      this.dataSource.query(
        `SELECT v.storage_key AS key, v.status,
                EXISTS (SELECT 1 FROM project_media pm WHERE pm.asset_id = v.asset_id) AS linked
         FROM asset_variants v
         WHERE v.storage_key = ANY($1::text[])`,
        [keys],
      ),
      projectIds.length > 0
        ? this.dataSource.query(`SELECT id FROM projects WHERE id = ANY($1::uuid[])`, [projectIds])
        : [],
      assetIds.length > 0
        ? this.dataSource.query(
            `SELECT a.id,
                    EXISTS (SELECT 1 FROM project_media pm WHERE pm.asset_id = a.id) AS linked
             FROM assets a WHERE a.id = ANY($1::uuid[])`,
            [assetIds],
          )
        : [],
    ])) as [
      Array<{ key: string; linked: boolean }>,
      Array<{ key: string; status: string; linked: boolean }>,
      Array<{ id: string }>,
      Array<{ id: string; linked: boolean }>,
    ];
    return {
      originals: new Map(originals.map((row) => [row.key, { linked: row.linked }])),
      variants: new Map(
        variants.map((row) => [row.key, { linked: row.linked, status: row.status }]),
      ),
      projectIds: new Set(projects.map((row) => row.id)),
      assets: new Map(assets.map((row) => [row.id, { linked: row.linked }])),
    };
  }
}

function addTo<K>(map: Map<K, ByteCount>, key: K, bytes: number): void {
  const entry = map.get(key) ?? { objects: 0, bytes: 0 };
  entry.objects += 1;
  entry.bytes += bytes;
  map.set(key, entry);
}

function largest<T extends { bytes: number }>(items: T[], count: number): T[] {
  return [...items].sort((a, b) => b.bytes - a.bytes).slice(0, count);
}

export function toAuditView(row: AuditRow): StorageAuditView {
  return {
    id: row.id,
    status: row.status,
    trigger: row.trigger,
    requestedBy: row.requested_by,
    createdAt: new Date(row.created_at).toISOString(),
    startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
    listedObjects: Number(row.listed_objects ?? 0),
    listedBytes: Number(row.listed_bytes ?? 0),
    multipartUploads: row.multipart_uploads,
    multipartBytes: row.multipart_bytes == null ? null : Number(row.multipart_bytes),
    categories: row.categories ?? [],
    otherPrefixes: row.other_prefixes ?? [],
    topObjects: row.top_objects ?? [],
    error: row.error,
  };
}
