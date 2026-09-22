import {
  BadGatewayException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  AccountApplication,
  AccountUser,
  AccountUserQuery,
  AccountUsersResponse,
} from './account.types';

type AccountApiEnvelope<T> = {
  data?: T;
  statusCode?: number;
  message?: string;
  success?: boolean;
  error?: unknown;
};

const DEFAULT_USER_FIELDS = [
  'id',
  'name',
  'email',
  'department',
  'phone_number',
  'birthday',
  'avatar',
  'is_active',
  'email_verified',
  'last_login',
  'created_at',
  'updated_at',
].join(',');

@Injectable()
export class AccountApiService {
  private readonly logger = new Logger(AccountApiService.name);

  constructor(private readonly config: ConfigService) {}

  async getUsers(userId: string, query: AccountUserQuery = {}): Promise<AccountUsersResponse> {
    const url = this.buildUsersUrl(userId, query);
    const payload = await this.request<AccountUsersResponse>(url);
    const result = this.unwrap(payload);
    if (!this.isUsersResponse(result)) {
      throw new BadGatewayException('Account API returned an invalid user response');
    }
    return result;
  }

  async getUserById(userId: string, query: AccountUserQuery = {}): Promise<AccountUser> {
    const response = await this.getUsers(userId, {
      ...query,
      fields: query.fields ?? DEFAULT_USER_FIELDS,
    });
    const user = response.data[0];

    if (!user) {
      throw new NotFoundException('User not found in Account API');
    }

    return user;
  }

  async getApplications(): Promise<AccountApplication[]> {
    const payload = await this.request<AccountApplication[]>(
      this.buildAccountUrl('public/applications').toString(),
      false,
    );
    const result = this.unwrap(payload);

    if (!Array.isArray(result)) {
      throw new BadGatewayException('Account API returned an invalid application response');
    }

    return result;
  }

  private buildUsersUrl(userId: string, query: AccountUserQuery): string {
    const url = this.buildAccountUrl('public/users');
    url.searchParams.set('user_ids', userId);
    url.searchParams.set('fields', query.fields ?? DEFAULT_USER_FIELDS);

    if (query.include_inactive === true) {
      url.searchParams.set('include_inactive', 'true');
    }

    return url.toString();
  }

  private buildAccountUrl(path: string): URL {
    const baseUrl = this.config.get<string>('ACCOUNT_API_URL')?.trim();
    if (!baseUrl) {
      throw new ServiceUnavailableException('Account API integration is not configured');
    }

    const normalizedBaseUrl = `${baseUrl.replace(/\/+$/, '')}/`;
    const basePath = new URL(normalizedBaseUrl).pathname.replace(/\/+$/, '');
    const accountPath = basePath.endsWith('/v2') ? path : `v2/${path}`;
    return new URL(accountPath, normalizedBaseUrl);
  }

  private async request<T>(url: string, requireApiKey = true): Promise<T | AccountApiEnvelope<T>> {
    const apiKey = this.config.get<string>('ACCOUNT_API_KEY')?.trim();
    if (requireApiKey && !apiKey) {
      throw new ServiceUnavailableException('Account API key is not configured');
    }

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (requireApiKey && apiKey) {
      headers['x-api-key'] = apiKey;
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      this.logger.error(
        `Account API request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new BadGatewayException('Account API is unavailable');
    }

    const body = await this.readBody(response);
    if (!response.ok) {
      this.logger.warn(`Account API returned HTTP ${response.status}`);
      throw new BadGatewayException('Account API request failed');
    }

    return body as T | AccountApiEnvelope<T>;
  }

  private async readBody(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) {
      return null;
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new BadGatewayException('Account API returned invalid JSON');
    }
  }

  private unwrap<T>(payload: T | AccountApiEnvelope<T>): T {
    if (this.isEnvelope<T>(payload)) {
      if (payload.success === false) {
        throw new BadGatewayException('Account API request failed');
      }
      return payload.data as T;
    }

    return payload;
  }

  private isEnvelope<T>(value: unknown): value is AccountApiEnvelope<T> {
    return (
      typeof value === 'object' &&
      value !== null &&
      'data' in value &&
      ('statusCode' in value || 'timestamp' in value || 'success' in value)
    );
  }

  private isUsersResponse(value: unknown): value is AccountUsersResponse {
    if (typeof value !== 'object' || value === null) {
      return false;
    }

    const candidate = value as Record<string, unknown>;
    const meta = candidate.meta;
    return (
      Array.isArray(candidate.data) &&
      typeof meta === 'object' &&
      meta !== null &&
      typeof (meta as Record<string, unknown>).total === 'number' &&
      typeof (meta as Record<string, unknown>).page === 'number' &&
      typeof (meta as Record<string, unknown>).page_size === 'number' &&
      typeof (meta as Record<string, unknown>).total_pages === 'number'
    );
  }
}
