import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';
const REQUEST_TIMEOUT_MS = 30_000;

/** Class A operations per https://developers.cloudflare.com/r2/pricing/ (the rest is B or free). */
const CLASS_A_ACTIONS = new Set([
  'ListBuckets',
  'PutBucket',
  'ListObjects',
  'PutObject',
  'CopyObject',
  'CompleteMultipartUpload',
  'CreateMultipartUpload',
  'LifecycleStorageTierTransition',
  'ListMultipartUploads',
  'UploadPart',
  'UploadPartCopy',
  'ListParts',
  'PutBucketEncryption',
  'PutBucketCors',
  'PutBucketLifecycleConfiguration',
]);
const CLASS_B_ACTIONS = new Set([
  'HeadBucket',
  'HeadObject',
  'GetObject',
  'UsageSummary',
  'GetBucketEncryption',
  'GetBucketLocation',
  'GetBucketCors',
  'GetBucketLifecycleConfiguration',
]);

const STORAGE_QUERY = `
query R2Storage($accountTag: string!, $bucketName: string!, $from: Time!, $to: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      r2StorageAdaptiveGroups(
        limit: 1
        filter: { datetime_geq: $from, datetime_leq: $to, bucketName: $bucketName }
        orderBy: [datetime_DESC]
      ) {
        max { objectCount uploadCount payloadSize metadataSize }
        dimensions { datetime }
      }
    }
  }
}`;

const OPERATIONS_QUERY = `
query R2Operations($accountTag: string!, $bucketName: string!, $from: Time!, $to: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      r2OperationsAdaptiveGroups(
        limit: 10000
        filter: { datetime_geq: $from, datetime_leq: $to, bucketName: $bucketName }
      ) {
        sum { requests }
        dimensions { actionType }
      }
    }
  }
}`;

export type R2BucketStorage = {
  payloadBytes: number;
  metadataBytes: number;
  objects: number;
  /** Multipart uploads started and not completed or aborted. */
  pendingUploads: number;
  measuredAt: string;
};

export type R2BucketOperations = {
  byAction: Record<string, number>;
  classA: number;
  classB: number;
};

type GraphqlResponse<T> = {
  data?: { viewer?: { accounts?: T[] } } | null;
  errors?: Array<{ message: string }> | null;
};

/**
 * Reads a bucket's size and operation counts from the Cloudflare GraphQL Analytics API: the
 * numbers the R2 dashboard shows, without listing the bucket.
 */
@Injectable()
export class CloudflareR2AnalyticsClient {
  private readonly accountId?: string;
  private readonly token?: string;

  constructor(config: ConfigService) {
    this.accountId = config.get<string>('CLOUDFLARE_ACCOUNT_ID')?.trim() || undefined;
    this.token = config.get<string>('CLOUDFLARE_ANALYTICS_TOKEN')?.trim() || undefined;
  }

  get isConfigured(): boolean {
    return Boolean(this.accountId && this.token);
  }

  /** Latest storage sample of the last two days, null when Cloudflare has none. */
  async storage(bucketName: string, now: Date): Promise<R2BucketStorage | null> {
    const accounts = await this.query<{
      r2StorageAdaptiveGroups: Array<{
        max: {
          objectCount: number;
          uploadCount: number;
          payloadSize: number;
          metadataSize: number;
        };
        dimensions: { datetime: string };
      }>;
    }>(STORAGE_QUERY, {
      bucketName,
      from: new Date(now.getTime() - 2 * 86_400_000).toISOString(),
      to: now.toISOString(),
    });
    const sample = accounts[0]?.r2StorageAdaptiveGroups?.[0];
    if (!sample) {
      return null;
    }
    return {
      payloadBytes: Number(sample.max.payloadSize ?? 0),
      metadataBytes: Number(sample.max.metadataSize ?? 0),
      objects: Number(sample.max.objectCount ?? 0),
      pendingUploads: Number(sample.max.uploadCount ?? 0),
      measuredAt: new Date(sample.dimensions.datetime).toISOString(),
    };
  }

  /** Requests on the bucket in [from, to], by action type and by billing class. */
  async operations(bucketName: string, from: Date, to: Date): Promise<R2BucketOperations> {
    const accounts = await this.query<{
      r2OperationsAdaptiveGroups: Array<{
        sum: { requests: number };
        dimensions: { actionType: string };
      }>;
    }>(OPERATIONS_QUERY, { bucketName, from: from.toISOString(), to: to.toISOString() });
    const byAction: Record<string, number> = {};
    for (const group of accounts[0]?.r2OperationsAdaptiveGroups ?? []) {
      const action = group.dimensions.actionType;
      byAction[action] = (byAction[action] ?? 0) + Number(group.sum.requests ?? 0);
    }
    return {
      byAction,
      classA: sumActions(byAction, CLASS_A_ACTIONS),
      classB: sumActions(byAction, CLASS_B_ACTIONS),
    };
  }

  private async query<T>(query: string, variables: Record<string, string>): Promise<T[]> {
    if (!this.accountId || !this.token) {
      throw new Error('CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_ANALYTICS_TOKEN is not set');
    }
    const response = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { accountTag: this.accountId, ...variables } }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Cloudflare analytics answered HTTP ${response.status}`);
    }
    const body = (await response.json()) as GraphqlResponse<T>;
    if (body.errors?.length) {
      throw new Error(`Cloudflare analytics: ${body.errors.map((e) => e.message).join('; ')}`);
    }
    return body.data?.viewer?.accounts ?? [];
  }
}

function sumActions(byAction: Record<string, number>, actions: Set<string>): number {
  return Object.entries(byAction).reduce(
    (sum, [action, requests]) => (actions.has(action) ? sum + requests : sum),
    0,
  );
}
