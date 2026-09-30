// Copied from ag-farm packages/protocol v0.1.0 — keep in sync
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readApiError, unwrapApiResponse } from './api-envelope';
import type { JobControlAction, JobView, SubmitJobRequest, SubmitJobResponse } from './protocol';
import {
  GetJobResponseSchema,
  JobControlResponseSchema,
  ListJobsResponseSchema,
  SubmitJobResponseSchema,
} from './protocol';

/**
 * Minimal HTTP client for ag-farm owner API.
 * Uses `Authorization: Owner <key>` authentication.
 * Validates responses with zod schemas.
 *
 * Handles both the legacy raw-body format and the new envelope format
 * `{ data, requestId, timestamp, success, error }` transparently via
 * `unwrapApiResponse` / `readApiError` applied before any zod parsing.
 */
@Injectable()
export class FarmClient {
  private readonly logger = new Logger(FarmClient.name);

  private readonly farmUrl: string | undefined;
  private readonly ownerKey: string | undefined;

  constructor(private readonly config: ConfigService) {
    this.farmUrl = config.get<string>('FARM_URL') || undefined;
    this.ownerKey = config.get<string>('FARM_OWNER_KEY') || undefined;
  }

  get isConfigured(): boolean {
    return !!(this.farmUrl && this.ownerKey);
  }

  /** Submits a job; idempotent via correlation_id. Throws if FARM_URL not configured. */
  async submitJob(request: SubmitJobRequest): Promise<SubmitJobResponse> {
    const data = await this.post<unknown>('/v1/owner/jobs', request);
    const parsed = SubmitJobResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(`Farm submit response invalid: ${parsed.error.message}`);
    }
    return parsed.data;
  }

  /** Fetches a single job by id. */
  async getJob(farmJobId: string): Promise<JobView> {
    const data = await this.get<unknown>(`/v1/owner/jobs/${farmJobId}`);
    const parsed = GetJobResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(`Farm get-job response invalid: ${parsed.error.message}`);
    }
    return parsed.data.job;
  }

  /** Lists unacked completed/failed jobs. */
  async listUnackedFinished(limit = 100): Promise<JobView[]> {
    const data = await this.get<unknown>(
      `/v1/owner/jobs?status=completed,failed&unacked=1&limit=${limit}`,
    );
    const parsed = ListJobsResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(`Farm list response invalid: ${parsed.error.message}`);
    }
    return parsed.data.jobs;
  }

  /** Acknowledges a job result. */
  async ackJob(farmJobId: string): Promise<void> {
    await this.post<unknown>(`/v1/owner/jobs/${farmJobId}/ack`, {});
  }

  /** Cancels a job (best-effort). */
  async cancelJob(farmJobId: string): Promise<void> {
    await this.post<unknown>(`/v1/owner/jobs/${farmJobId}/cancel`, {});
  }

  /**
   * Pauses / resumes / cancels jobs by ids or by group (`batch:<id>`). Paused jobs are not handed to
   * workers; a running job loses its lease without the attempt being counted. Returns how many changed.
   */
  async controlJobs(
    action: JobControlAction,
    selector: { ids: string[] } | { group_key: string },
  ): Promise<number> {
    if ('ids' in selector && selector.ids.length === 0) return 0;
    const data = await this.post<unknown>(`/v1/owner/jobs/${action}`, selector);
    const parsed = JobControlResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(`Farm ${action} response invalid: ${parsed.error.message}`);
    }
    return parsed.data.affected;
  }

  private requireConfigured(): void {
    if (!this.farmUrl || !this.ownerKey) {
      throw new Error('FARM_URL and FARM_OWNER_KEY must be configured to use the farm client');
    }
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    this.requireConfigured();
    const url = `${this.farmUrl}${path}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Owner ${this.ownerKey}`,
      },
      body: JSON.stringify(body),
    });
    const rawBody = await this.parseResponseBody(response);
    if (!response.ok) {
      throw readApiError(response.status, path, rawBody);
    }
    return unwrapApiResponse(rawBody) as T;
  }

  private async get<T>(path: string): Promise<T> {
    this.requireConfigured();
    const url = `${this.farmUrl}${path}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Owner ${this.ownerKey}`,
      },
    });
    const rawBody = await this.parseResponseBody(response);
    if (!response.ok) {
      throw readApiError(response.status, path, rawBody);
    }
    return unwrapApiResponse(rawBody) as T;
  }

  /** Reads the response body as text, then attempts JSON.parse. Falls back to the raw string. */
  private async parseResponseBody(response: Response): Promise<unknown> {
    const text = await response.text().catch(() => '');
    if (!text) return text;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
}
