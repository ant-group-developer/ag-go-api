import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SystemLogEntity } from '../../database/entities/system-log.entity';

@Injectable()
export class SystemLogService {
  constructor(
    @InjectRepository(SystemLogEntity)
    private readonly repository: Repository<SystemLogEntity>,
  ) {}

  async writeHttp(input: {
    requestId?: string;
    userId?: string | null;
    method: string;
    path: string;
    statusCode: number;
    durationMs: number;
  }): Promise<void> {
    await this.repository.insert({
      level: input.statusCode >= 500 ? 'error' : input.statusCode >= 400 ? 'warn' : 'info',
      category: 'http',
      action: `${input.method} ${input.path}`.slice(0, 100),
      message: `HTTP ${input.method} ${input.path} returned ${input.statusCode}`,
      requestId: input.requestId ?? null,
      userId: input.userId ?? null,
      projectId: null,
      jobId: null,
      metadata: { statusCode: input.statusCode, durationMs: input.durationMs },
    });
  }

  /** Generic audit entry for non-HTTP events (e.g. farm sign, act-as). */
  async write(input: {
    level: 'info' | 'warn' | 'error';
    category: string;
    action: string;
    message: string;
    requestId?: string | null;
    userId?: string | null;
    projectId?: string | null;
    jobId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.repository.insert({
      level: input.level,
      category: input.category.slice(0, 40),
      action: input.action.slice(0, 100),
      message: input.message,
      requestId: input.requestId ?? null,
      userId: input.userId ?? null,
      projectId: input.projectId ?? null,
      jobId: input.jobId ?? null,
      metadata: (input.metadata ?? {}) as Record<string, NonNullable<unknown>>,
    });
  }
}
