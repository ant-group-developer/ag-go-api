import {
  BadGatewayException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { USER_TYPES, type UserType } from '../../common/auth/user-type';
import type {
  AccountApplication,
  AccountCurrentUser,
  AccountPaginationMeta,
  AccountUser,
  AccountUserQuery,
  AccountUserSearchQuery,
  AccountUserSearchResponse,
  AccountUserSummary,
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

const ACTOR_FIELDS = 'id,name,email,avatar';

export type AccountUserAccess = {
  user_type: UserType;
  permissions: string[];
};

@Injectable()
export class AccountApiService {
  private readonly logger = new Logger(AccountApiService.name);
  private readonly actorCache = new Map<string, { expiresAt: number; value: AccountUser | null }>();
  /** Cache for getUserAccess: userId → { expiresAt, value }. TTL 60 s. */
  private readonly accessCache = new Map<string, { expiresAt: number; value: AccountUserAccess }>();

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

  /**
   * Returns the user_type and app permissions for `userId` in the `ant-go-v2` application.
   * Used by the service-key act-as flow; results are cached for 60 seconds.
   *
   * Endpoint: `ACCOUNT_API_USER_ACCESS_PATH` env var, default
   * `/v2/public/users/{userId}/access?application=ant-go-v2`.
   * Expects `{ user_type, permissions: string[] }` (possibly wrapped in the standard envelope).
   *
   * On any failure: throws 503 (never guesses ADMIN).
   */
  async getUserAccess(userId: string): Promise<AccountUserAccess> {
    const now = Date.now();
    const cached = this.accessCache.get(userId);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const pathTemplate =
      this.config.get<string>('ACCOUNT_API_USER_ACCESS_PATH') ??
      '/v2/public/users/{userId}/access?application=ant-go-v2';
    const resolvedPath = pathTemplate.replace('{userId}', encodeURIComponent(userId));

    const baseUrl = this.config.get<string>('ACCOUNT_API_URL')?.trim();
    if (!baseUrl) {
      throw new ServiceUnavailableException('Account API integration is not configured');
    }
    const normalizedBase = `${baseUrl.replace(/\/+$/, '')}/`;
    // If path template starts with /v2 and base already ends in /v2, avoid duplication
    const cleanPath = resolvedPath.startsWith('/') ? resolvedPath.slice(1) : resolvedPath;
    const fullUrl = new URL(cleanPath, normalizedBase).toString();

    let response: Response;
    try {
      const apiKey = this.config.get<string>('ACCOUNT_API_KEY')?.trim();
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (apiKey) {
        headers['x-api-key'] = apiKey;
      }
      response = await fetch(fullUrl, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      this.logger.error(
        `Account API getUserAccess failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new ServiceUnavailableException('Account API is unavailable');
    }

    if (response.status === 401 || response.status === 403) {
      throw new ServiceUnavailableException('Account API denied access for getUserAccess');
    }

    const bodyText = await response.text();
    if (!response.ok) {
      this.logger.warn(`Account API getUserAccess returned HTTP ${response.status}`);
      throw new ServiceUnavailableException('Account API request failed');
    }

    let body: unknown;
    try {
      body = JSON.parse(bodyText) as unknown;
    } catch {
      throw new ServiceUnavailableException('Account API returned invalid JSON');
    }

    // Unwrap envelope if present
    let data: unknown = body;
    if (
      typeof body === 'object' &&
      body !== null &&
      'data' in body &&
      ('statusCode' in body || 'success' in body)
    ) {
      const env = body as Record<string, unknown>;
      if (env['success'] === false) {
        throw new ServiceUnavailableException('Account API getUserAccess failed');
      }
      data = env['data'];
    }

    if (!this.isUserAccess(data)) {
      this.logger.warn(`Account API getUserAccess returned unexpected shape`);
      throw new ServiceUnavailableException('Account API returned an invalid access response');
    }

    const result: AccountUserAccess = { user_type: data.user_type, permissions: data.permissions };
    this.accessCache.set(userId, { expiresAt: now + 60_000, value: result });
    return result;
  }

  private isUserAccess(value: unknown): value is AccountUserAccess {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const c = value as Record<string, unknown>;
    return (
      (c['user_type'] === USER_TYPES.ADMIN || c['user_type'] === USER_TYPES.USER) &&
      Array.isArray(c['permissions']) &&
      (c['permissions'] as unknown[]).every((p) => typeof p === 'string')
    );
  }

  async getCurrentUser(accessToken: string): Promise<AccountCurrentUser> {
    const payload = await this.request<AccountCurrentUser>(
      this.buildAccountUrl('users/me').toString(),
      false,
      accessToken,
    );
    const result = this.unwrap(payload);
    if (!this.isCurrentUserResponse(result)) {
      throw new BadGatewayException('Account API returned an invalid current user response');
    }
    return result;
  }

  /** Searches users with the caller's own bearer token (never the API key). */
  async searchUsers(
    accessToken: string,
    query: AccountUserSearchQuery,
  ): Promise<AccountUserSearchResponse> {
    // GET /v2/users (ag-account-server UsersController.findAll): searches name/email by `keyword`,
    // non-admin callers only see members of groups they manage. It has no `fields` param, so the
    // response is trimmed to the summary fields below.
    const url = this.buildAccountUrl('users');
    url.searchParams.set('page', String(query.page ?? 1));
    url.searchParams.set('limit', String(query.limit ?? 20));
    url.searchParams.set('is_active', 'true');
    url.searchParams.set('sort_by', 'name');
    url.searchParams.set('sort_order', 'asc');
    const keyword = query.keyword?.trim();
    if (keyword) {
      url.searchParams.set('keyword', keyword);
    }

    const payload = await this.request<{ data: AccountUser[]; meta: AccountPaginationMeta }>(
      url.toString(),
      false,
      accessToken,
      true,
    );
    const result = this.unwrap(payload);
    if (!this.isPaginatedUsersResponse(result)) {
      throw new BadGatewayException('Account API returned an invalid user response');
    }

    const { total, page, limit, totalPages, hasNextPage } = result.meta;
    return {
      data: result.data.map((user) => this.toUserSummary(user)),
      meta: { total, page, limit, totalPages, hasNextPage: hasNextPage ?? page < totalPages },
    };
  }

  async getUsersByIds(userIds: string[], fields = ACTOR_FIELDS): Promise<Map<string, AccountUser>> {
    const ids = [...new Set(userIds.map((id) => id.trim()).filter(Boolean))];
    const result = new Map<string, AccountUser>();
    const missing: string[] = [];
    const now = Date.now();

    for (const id of ids) {
      const cached = this.actorCache.get(id);
      if (cached && cached.expiresAt > now) {
        if (cached.value) {
          result.set(id, cached.value);
        }
      } else {
        this.actorCache.delete(id);
        missing.push(id);
      }
    }

    for (let index = 0; index < missing.length; index += 50) {
      const chunk = missing.slice(index, index + 50);
      try {
        const response = await this.getUsersByIdChunk(chunk, fields);
        const foundIds = new Set<string>();
        for (const user of response.data) {
          foundIds.add(user.id);
          result.set(user.id, user);
          this.actorCache.set(user.id, {
            expiresAt: now + 5 * 60 * 1000,
            value: user,
          });
        }
        for (const id of chunk) {
          if (!foundIds.has(id)) {
            this.actorCache.set(id, {
              expiresAt: now + 5 * 60 * 1000,
              value: null,
            });
          }
        }
      } catch (error) {
        this.logger.warn(
          `Actor lookup failed for ${chunk.length} users: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return result;
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

  private toUserSummary(user: AccountUser): AccountUserSummary {
    const text = (value: unknown) =>
      typeof value === 'string' && value.trim() ? value.trim() : undefined;
    return {
      id: user.id,
      name: text(user.name),
      email: text(user.email),
      avatar: text(user.avatar),
    };
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

  private async getUsersByIdChunk(
    userIds: string[],
    fields: string,
  ): Promise<AccountUsersResponse> {
    const url = this.buildAccountUrl('public/users');
    url.searchParams.set('user_ids', userIds.join(','));
    url.searchParams.set('fields', fields);
    const payload = await this.request<AccountUsersResponse>(url.toString());
    const result = this.unwrap(payload);
    if (!this.isUsersResponse(result)) {
      throw new BadGatewayException('Account API returned an invalid user response');
    }
    return result;
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

  private async request<T>(
    url: string,
    requireApiKey = true,
    accessToken?: string,
    forwardAuthErrors = false,
  ): Promise<T | AccountApiEnvelope<T>> {
    const apiKey = this.config.get<string>('ACCOUNT_API_KEY')?.trim();
    if (requireApiKey && !apiKey) {
      throw new ServiceUnavailableException('Account API key is not configured');
    }

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (requireApiKey && apiKey) {
      headers['x-api-key'] = apiKey;
    }
    if (accessToken) {
      headers.authorization = `Bearer ${accessToken}`;
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

    if (forwardAuthErrors && (response.status === 401 || response.status === 403)) {
      // Mapped to 403 (not 401) so the web client does not treat it as an expired session.
      throw new ForbiddenException('Account API denied access for the current user');
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

  private isPaginatedUsersResponse(
    value: unknown,
  ): value is { data: AccountUser[]; meta: AccountPaginationMeta } {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const { data, meta } = value as Record<string, unknown>;
    if (!Array.isArray(data) || typeof meta !== 'object' || meta === null) {
      return false;
    }
    const candidate = meta as Record<string, unknown>;
    return (
      data.every((user) => typeof (user as Record<string, unknown>)?.id === 'string') &&
      typeof candidate.total === 'number' &&
      typeof candidate.page === 'number' &&
      typeof candidate.limit === 'number' &&
      typeof candidate.totalPages === 'number'
    );
  }

  private isCurrentUserResponse(value: unknown): value is AccountCurrentUser {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const candidate = value as Record<string, unknown>;
    return (
      typeof candidate.id === 'string' &&
      (candidate.user_type === USER_TYPES.ADMIN || candidate.user_type === USER_TYPES.USER) &&
      Array.isArray(candidate.permissions) &&
      candidate.permissions.every((permission) => typeof permission === 'string')
    );
  }
}
