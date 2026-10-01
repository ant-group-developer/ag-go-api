/**
 * Export scan dataset for LLM training.
 *
 * Reads completed asset_analyses (those with a description) and writes one
 * JSONL line per analysis with the description, per-group notes, keyframe
 * references (optionally pre-signed) and the full Ollama call trace when
 * available in R2.
 *
 * Usage (compiled):
 *   node dist/scripts/export-scan-dataset.js [options]
 *
 * Options:
 *   --since <iso>          Only analyses completed at or after this timestamp.
 *   --current-only <bool>  Default true. When true, only is_current analyses.
 *   --limit <n>            Max number of analyses to export.
 *   --out <file.jsonl>     Output file. Default: stdout.
 *   --presign-hours <n>    Add presigned GET URLs for keyframes valid for n hours.
 *                          Default 0 (no URLs, only storage keys).
 *
 * Runs inside the production Docker image:
 *   node dist/scripts/export-scan-dataset.js --since 2026-01-01 --out /data/scan.jsonl
 */
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getRepositoryToken } from '@nestjs/typeorm';
import { createWriteStream, WriteStream } from 'node:fs';
import 'reflect-metadata';
import type { Repository } from 'typeorm';
import { AppModule } from '../app.module';
import { AssetAnalysisEntity } from '../database/entities/asset-analysis.entity';
import { AssetEntity } from '../database/entities/asset.entity';
import { AI_MANIFEST_PATH, AI_TRACE_PATH } from '../modules/analysis/farm/scan';
import { STORAGE_ADAPTER, type StorageAdapter } from '../modules/assets/storage/storage-adapter';
import { assetVariantsPrefix } from '../modules/projects/project-asset-cleanup';

// ---- CLI arg parsing ----

interface CliOptions {
  since: Date | null;
  currentOnly: boolean;
  limit: number | null;
  out: string | null;
  presignHours: number;
}

function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2);
  const opts: CliOptions = {
    since: null,
    currentOnly: true,
    limit: null,
    out: null,
    presignHours: 0,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--since':
        opts.since = new Date(args[++i]!);
        break;
      case '--current-only':
        opts.currentOnly = args[++i] !== 'false';
        break;
      case '--limit':
        opts.limit = parseInt(args[++i]!, 10);
        break;
      case '--out':
        opts.out = args[++i]!;
        break;
      case '--presign-hours':
        opts.presignHours = parseFloat(args[++i]!);
        break;
    }
  }
  return opts;
}

// ---- Types for JSONL output ----

interface KeyframeEntry {
  key: string;
  t_ms: number;
  url?: string;
}

interface DatasetRow {
  id: string;
  source: 'qwen';
  asset_id: string;
  analysis_id: string;
  asset_name: string;
  model: string | null;
  prompt_version: string;
  extract_version: string;
  created_at: string;
  keyframes: KeyframeEntry[];
  description: Record<string, unknown> | null;
  notes: string[] | null;
  calls: unknown[] | null;
}

// ---- Main ----

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);

  let out: WriteStream | null = null;
  if (opts.out) {
    out = createWriteStream(opts.out, { encoding: 'utf8' });
  }

  function writeLine(row: DatasetRow): void {
    const line = JSON.stringify(row) + '\n';
    if (out) {
      out.write(line);
    } else {
      process.stdout.write(line);
    }
  }

  let app: INestApplicationContext | null = null;
  try {
    app = await NestFactory.createApplicationContext(AppModule, { logger: false });

    const analysisRepo = app.get<Repository<AssetAnalysisEntity>>(
      getRepositoryToken(AssetAnalysisEntity),
    );
    const assetRepo = app.get<Repository<AssetEntity>>(getRepositoryToken(AssetEntity));
    const storage = app.get<StorageAdapter>(STORAGE_ADAPTER);

    const qb = analysisRepo
      .createQueryBuilder('a')
      .where('a.description IS NOT NULL')
      .orderBy('a.completed_at', 'DESC');

    if (opts.currentOnly) {
      qb.andWhere('a.is_current = true');
    }
    if (opts.since) {
      qb.andWhere('a.completed_at >= :since', { since: opts.since.toISOString() });
    }
    if (opts.limit) {
      qb.limit(opts.limit);
    }

    const analyses = await qb.getMany();
    const presignTtlSeconds = Math.round(opts.presignHours * 3600);

    let exported = 0;
    for (const analysis of analyses) {
      const asset = await assetRepo.findOne({ where: { id: analysis.assetId } });
      if (!asset) continue;

      const prefix = `${assetVariantsPrefix(asset.originalStorageKey, asset.id)}analysis/${analysis.id}/`;

      // Keyframes from DB (relative path stored as { output, t_ms })
      type StoredKf = { output: string; t_ms: number };
      const storedKfs = (analysis.keyframes ?? []) as unknown as StoredKf[];
      const keyframes: KeyframeEntry[] = await Promise.all(
        storedKfs.map(async (kf) => {
          const key = `${prefix}${kf.output}`;
          const entry: KeyframeEntry = { key, t_ms: kf.t_ms };
          if (presignTtlSeconds > 0) {
            try {
              entry.url = await storage.getPresignedGetUrl(key, 'image/jpeg', presignTtlSeconds);
            } catch {
              // No URL if presign fails; key is always present
            }
          }
          return entry;
        }),
      );

      // Read ai.json from R2 for notes
      let notes: string[] | null = null;
      try {
        const manifestText = await storage.getObjectText(`${prefix}${AI_MANIFEST_PATH}`);
        const manifest = JSON.parse(manifestText) as { notes?: string[] };
        if (Array.isArray(manifest.notes)) {
          notes = manifest.notes;
        }
      } catch {
        // ai.json absent or parse error: notes stays null
      }

      // Read ai-trace.json from R2 for calls (best-effort)
      let calls: unknown[] | null = null;
      try {
        const traceText = await storage.getObjectText(`${prefix}${AI_TRACE_PATH}`);
        const trace = JSON.parse(traceText) as { calls?: unknown[] };
        if (Array.isArray(trace.calls)) {
          calls = trace.calls;
        }
      } catch {
        // ai-trace.json absent: calls stays null
      }

      const models = analysis.models as { ai?: string } | null;
      const row: DatasetRow = {
        id: analysis.id,
        source: 'qwen',
        asset_id: analysis.assetId,
        analysis_id: analysis.id,
        asset_name: asset.originalFilename,
        model: models?.ai ?? null,
        prompt_version: analysis.promptVersion,
        extract_version: analysis.extractVersion,
        created_at: analysis.createdAt.toISOString(),
        keyframes,
        description: analysis.description as Record<string, unknown> | null,
        notes,
        calls,
      };

      writeLine(row);
      exported++;
    }

    if (out) {
      await new Promise<void>((resolve, reject) => {
        out!.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
      });
    }

    process.stderr.write(`Da xuat ${exported} dong\n`);
  } finally {
    await app?.close();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`Loi xuat dataset: ${String(err)}\n`);
  process.exit(1);
});
