import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SystemLogEntity } from '../../database/entities/system-log.entity';
import { SystemLogService } from '../logs/system-log.service';

/** The `system_logs` category the analysis pipeline writes its processing log under. */
export const ANALYSIS_LOG_CATEGORY = 'analysis';

export type AnalysisLogLevel = 'info' | 'warn' | 'error';

export type AnalysisLogEntry = {
  id: string;
  level: AnalysisLogLevel;
  action: string;
  message: string;
  userId: string | null;
  createdAt: Date;
  metadata: Record<string, unknown>;
};

export type AnalysisLogPage = {
  items: AnalysisLogEntry[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

/**
 * The processing log of the analysis pipeline (backfill → farm submit → extract → AI → done),
 * kept in `system_logs` so it can be read from the web instead of the worker's stdout.
 */
@Injectable()
export class AnalysisLogService {
  private readonly logger = new Logger(AnalysisLogService.name);

  constructor(
    private readonly systemLog: SystemLogService,
    @InjectRepository(SystemLogEntity)
    private readonly repository: Repository<SystemLogEntity>,
  ) {}

  /** Never throws: a log line that cannot be written must not stop or repeat a pipeline step. */
  async write(input: {
    level: AnalysisLogLevel;
    action: string;
    message: string;
    userId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.systemLog.write({ ...input, category: ANALYSIS_LOG_CATEGORY });
    } catch (error) {
      this.logger.warn(
        `Could not write analysis log "${input.action}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Newest first; `search` matches the message (file names) or metadata (ids), ignoring case. */
  async list(query: {
    level?: AnalysisLogLevel;
    search?: string;
    page: number;
    pageSize: number;
  }): Promise<AnalysisLogPage> {
    const builder = this.repository
      .createQueryBuilder('log')
      .where('log.category = :category', { category: ANALYSIS_LOG_CATEGORY });
    if (query.level) {
      builder.andWhere('log.level = :level', { level: query.level });
    }
    const search = query.search?.trim();
    if (search) {
      builder.andWhere(
        `(log.message ILIKE :search ESCAPE '\\' OR log.metadata::text ILIKE :search ESCAPE '\\')`,
        {
          search: `%${search.replace(/[\\%_]/g, '\\$&')}%`,
        },
      );
    }
    const [rows, total] = await builder
      .orderBy('log.createdAt', 'DESC')
      .addOrderBy('log.id', 'DESC')
      .skip((query.page - 1) * query.pageSize)
      .take(query.pageSize)
      .getManyAndCount();
    return {
      items: rows.map((row) => ({
        id: row.id,
        level: row.level,
        action: row.action,
        message: row.message,
        userId: row.userId,
        createdAt: row.createdAt,
        metadata: row.metadata,
      })),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }
}
