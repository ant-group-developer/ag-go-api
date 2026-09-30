// Copied from ag-farm packages/protocol v0.1.0 — keep in sync
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { JobView, SubmitJobRequest, SubmitJobResponse } from './protocol';
import { ListJobsResponseSchema, SubmitJobResponseSchema } from './protocol';

/**
 * Minimal HTTP client for ag-farm owner API.
 * Uses `Authorization: Owner <key>` authentication.
 * Validates responses with zod schemas.
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
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Farm POST ${path} returned ${response.status}: ${text}`);
    }
    return response.json() as Promise<T>;
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
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Farm GET ${path} returned ${response.status}: ${text}`);
    }
    return response.json() as Promise<T>;
  }
}
