import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
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
  AccountContractProfile,
  AccountContractProfileChanges,
  AccountContractProfileUpdateResult,
  AccountCurrentUser,
  AccountPaginationMeta,
  AccountUser,
  AccountUserBySub,
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
  /** Account API's `is_active`; absent from older Account API versions (treated as active). */
  is_active?: boolean;
};

/** Code of this application in Account API: every user_type/permission lookup is made for it. */
const DEFAULT_APPLICATION_CODE = 'ant-go-v2';

/** Account API only takes `X-Acting-User-Id` values matching its VarChar(36) log columns. */
const ACTING_USER_PATTERN = /^[\w.@|-]{1,36}$/;

const BY_SUB_TTL_MS = 10 * 60 * 1000;

/** Error codes of the contract-profile proxy, for the web client to show its own message. */
export const ACCOUNT_ERROR_CODES = {
  USER_NOT_IN_APPLICATION: 'ACCOUNT_USER_NOT_IN_APPLICATION',
  PROFILE_VERSION_CONFLICT: 'CONTRACT_PROFILE_VERSION_CONFLICT',
  PROFILE_INVALID: 'CONTRACT_PROFILE_INVALID',
  UNAVAILABLE: 'ACCOUNT_API_UNAVAILABLE',
} as const;

type ApiKeyRequestOptions = {
  method?: 'GET' | 'PATCH';
  headers?: Record<string, string>;
  body?: unknown;
  /** Name of the calling method, for logs only. */
  operation: string;
};

@Injectable()
export class AccountApiService {
  private readonly logger = new Logger(AccountApiService.name);
  private readonly actorCache = new Map<string, { expiresAt: number; value: AccountUser | null }>();
  /** Cache for getUserAccess: userId → { expiresAt, value }. TTL 60 s. */
  private readonly accessCache = new Map<string, { expiresAt: number; value: AccountUserAccess }>();
  /** Cache for resolveBySub: token subject → AG Account user. TTL 10 min. */
  private readonly bySubCache = new Map<string, { expiresAt: number; value: AccountUserBySub }>();

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

    const isActive = (data as { is_active?: unknown }).is_active;
    const result: AccountUserAccess = {
      user_type: data.user_type,
      permissions: data.permissions,
      ...(typeof isActive === 'boolean' ? { is_active: isActive } : {}),
    };
    this.accessCache.set(userId, { expiresAt: now + 60_000, value: result });
    return result;
  }

  /**
   * AG Account's own user id (and access in this application) of a token subject (`sub`, with its
   * `auth0|` / `google-oauth2|` prefix). AG Go ids are the subject without `auth0|`, which is not
   * always the AG Account id (users linked by email, long ids). Cached 10 minutes per subject.
   *
   * Endpoint: `GET /v2/public/users/by-sub/access?sub=&application=ant-go-v2` (API key). Errors as
   * getUserAccess (503), except an unknown user: 404 `ACCOUNT_USER_NOT_IN_APPLICATION`.
   */
  async resolveBySub(sub: string): Promise<AccountUserBySub> {
    const subject = sub.trim();
    const now = Date.now();
    const cached = this.bySubCache.get(subject);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
    const url = this.buildAccountUrl('public/users/by-sub/access');
    url.searchParams.set('sub', subject);
    url.searchParams.set('application', this.applicationCode());
    const data = await this.sendApiKeyRequest(url.toString(), { operation: 'resolveBySub' });
    if (!this.isUserBySub(data)) {
      this.logger.warn('Account API resolveBySub returned unexpected shape');
      throw new ServiceUnavailableException('Account API returned an invalid access response');
    }
    const isActive = (data as { is_active?: unknown }).is_active;
    const value: AccountUserBySub = {
      user_id: data.user_id,
      user_type: data.user_type,
      permissions: data.permissions,
      ...(typeof data.application === 'string' ? { application: data.application } : {}),
      ...(typeof isActive === 'boolean' ? { is_active: isActive } : {}),
    };
    this.bySubCache.set(subject, { expiresAt: now + BY_SUB_TTL_MS, value });
    return value;
  }

  /** Drops cached lookups (by-sub, names) of these AG Account users after a webhook. */
  forgetAccountUsers(accountUserIds: string[]): void {
    const ids = new Set(accountUserIds);
    for (const [sub, entry] of this.bySubCache) {
      if (ids.has(entry.value.user_id)) {
        this.bySubCache.delete(sub);
      }
    }
    for (const id of accountUserIds) {
      this.actorCache.delete(id);
    }
  }

  /**
   * Contract profile of an AG Account user, decrypted (never cached: each call is logged as a VIEW
   * by AG Account). `actingUserId` is the AG Account id of the AG Go user doing it.
   *
   * 404 `ACCOUNT_USER_NOT_IN_APPLICATION` when the user does not exist or is not a member of AG Go;
   * 503 when the API key lacks `contract_profile_access` or Account API is down.
   */
  async getContractProfile(
    accountUserId: string,
    actingUserId?: string,
  ): Promise<AccountContractProfile> {
    const data = await this.sendApiKeyRequest(this.contractProfileUrl(accountUserId), {
      operation: 'getContractProfile',
      headers: this.actingHeaders(actingUserId),
    });
    if (!this.isContractProfile(data)) {
      this.logger.warn('Account API getContractProfile returned unexpected shape');
      throw new ServiceUnavailableException('Account API returned an invalid contract profile');
    }
    return data;
  }

  /**
   * Partial update: only the keys present are written, null clears. `version` (from the last GET)
   * is always sent as `If-Match`; a profile changed since then gives 409
   * `CONTRACT_PROFILE_VERSION_CONFLICT`. Values Account API refuses (format, duplicate ID card
   * number) give 400 `CONTRACT_PROFILE_INVALID` with its messages in `details.messages`.
   */
  async patchContractProfile(
    accountUserId: string,
    changes: AccountContractProfileChanges,
    options: { version: string; actingUserId?: string },
  ): Promise<AccountContractProfileUpdateResult> {
    const data = await this.sendApiKeyRequest(this.contractProfileUrl(accountUserId), {
      operation: 'patchContractProfile',
      method: 'PATCH',
      headers: { ...this.actingHeaders(options.actingUserId), 'If-Match': options.version },
      body: changes,
    });
    if (
      !this.isContractProfile(data) ||
      !Array.isArray((data as { changed_fields?: unknown }).changed_fields)
    ) {
      this.logger.warn('Account API patchContractProfile returned unexpected shape');
      throw new ServiceUnavailableException('Account API returned an invalid contract profile');
    }
    return data as AccountContractProfileUpdateResult;
  }

  /** Members of this application in Account API, by name or email (API key, summary fields). */
  async searchApplicationUsers(query: AccountUserSearchQuery): Promise<AccountUsersResponse> {
    const url = this.buildAccountUrl('public/users');
    url.searchParams.set('application', this.applicationCode());
    url.searchParams.set('fields', ACTOR_FIELDS);
    url.searchParams.set('page', String(query.page ?? 1));
    url.searchParams.set('page_size', String(query.limit ?? 20));
    url.searchParams.set('sort_by', 'name');
    url.searchParams.set('sort_order', 'asc');
    const keyword = query.keyword?.trim();
    if (keyword) {
      url.searchParams.set('keyword', keyword);
    }
    const payload = await this.request<AccountUsersResponse>(url.toString());
    const result = this.unwrap(payload);
    if (!this.isUsersResponse(result)) {
      throw new BadGatewayException('Account API returned an invalid user response');
    }
    return result;
  }

  private contractProfileUrl(accountUserId: string): string {
    return this.buildAccountUrl(
      `public/users/${encodeURIComponent(accountUserId)}/contract-profile`,
    ).toString();
  }

  private actingHeaders(actingUserId?: string): Record<string, string> {
    const acting = actingUserId?.trim();
    if (!acting) {
      return {};
    }
    if (!ACTING_USER_PATTERN.test(acting)) {
      // Account API would refuse the whole request (400): log without the acting user instead.
      this.logger.warn('Acting user id is not accepted by Account API; sent without it');
      return {};
    }
    return { 'X-Acting-User-Id': acting };
  }

  /**
   * Calls Account API with the API key like getUserAccess does: network failure, 401/403 (key not
   * allowed) and unexpected statuses are 503; 404, 409 and 400 keep their meaning with a code.
   * Returns the unwrapped `data`.
   */
  private async sendApiKeyRequest(url: string, options: ApiKeyRequestOptions): Promise<unknown> {
    const apiKey = this.config.get<string>('ACCOUNT_API_KEY')?.trim();
    if (!apiKey) {
      throw new ServiceUnavailableException('Account API key is not configured');
    }
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'x-api-key': apiKey,
      ...options.headers,
    };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: options.method ?? 'GET',
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      this.logger.error(
        `Account API ${options.operation} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new ServiceUnavailableException({
        code: ACCOUNT_ERROR_CODES.UNAVAILABLE,
        message: 'Account API is unavailable',
      });
    }

    if (response.status === 401 || response.status === 403) {
      this.logger.warn(`Account API denied ${options.operation} (HTTP ${response.status})`);
      throw new ServiceUnavailableException({
        code: ACCOUNT_ERROR_CODES.UNAVAILABLE,
        message: `Account API denied access for ${options.operation}`,
      });
    }

    const bodyText = await response.text();
    let body: unknown = null;
    if (bodyText) {
      try {
        body = JSON.parse(bodyText) as unknown;
      } catch {
        if (response.ok) {
          throw new ServiceUnavailableException('Account API returned invalid JSON');
        }
      }
    }

    if (!response.ok) {
      if (response.status === 404) {
        throw new NotFoundException({
          code: ACCOUNT_ERROR_CODES.USER_NOT_IN_APPLICATION,
          message: 'User does not exist or is not a member of AG Go in Account API',
        });
      }
      if (response.status === 409) {
        throw new ConflictException({
          code: ACCOUNT_ERROR_CODES.PROFILE_VERSION_CONFLICT,
          message: 'The contract profile was changed elsewhere; reload it and save again',
        });
      }
      if (response.status === 400) {
        const messages = this.errorMessages(body);
        throw new BadRequestException({
          code: ACCOUNT_ERROR_CODES.PROFILE_INVALID,
          message: messages[0] ?? 'Account API refused the contract profile',
          details: { messages },
        });
      }
      this.logger.warn(`Account API ${options.operation} returned HTTP ${response.status}`);
      throw new ServiceUnavailableException({
        code: ACCOUNT_ERROR_CODES.UNAVAILABLE,
        message: 'Account API request failed',
      });
    }

    if (
      typeof body === 'object' &&
      body !== null &&
      'data' in body &&
      ('statusCode' in body || 'success' in body || 'timestamp' in body)
    ) {
      const envelope = body as Record<string, unknown>;
      if (envelope['success'] === false) {
        throw new ServiceUnavailableException(`Account API ${options.operation} failed`);
      }
      return envelope['data'];
    }
    return body;
  }

  /** `message` of an Account API error: a string, or the validation messages. */
  private errorMessages(body: unknown): string[] {
    if (typeof body !== 'object' || body === null) {
      return [];
    }
    const record = body as Record<string, unknown>;
    const nested =
      typeof record['error'] === 'object' && record['error'] !== null
        ? (record['error'] as Record<string, unknown>)['message']
        : undefined;
    const message = record['message'] ?? nested;
    if (typeof message === 'string') {
      return [message];
    }
    return Array.isArray(message)
      ? message.filter((item): item is string => typeof item === 'string')
      : [];
  }

  private isUserBySub(value: unknown): value is AccountUserBySub {
    return (
      this.isUserAccess(value) &&
      typeof (value as unknown as Record<string, unknown>)['user_id'] === 'string'
    );
  }

  private isContractProfile(value: unknown): value is AccountContractProfile {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const candidate = value as Record<string, unknown>;
    return typeof candidate['user_id'] === 'string' && typeof candidate['version'] === 'string';
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

  /**
   * The caller's profile, user_type and permissions IN THIS APPLICATION. Account API otherwise picks the
   * application from the token's client id, and a token issued to another web app (ag-studio-web calling
   * this API) would get that app's permissions. Older Account API versions ignore the parameter.
   */
  async getCurrentUser(accessToken: string): Promise<AccountCurrentUser> {
    const url = this.buildAccountUrl('users/me');
    url.searchParams.set('application', this.applicationCode());
    const payload = await this.request<AccountCurrentUser>(url.toString(), false, accessToken);
    const result = this.unwrap(payload);
    if (!this.isCurrentUserResponse(result)) {
      throw new BadGatewayException('Account API returned an invalid current user response');
    }
    return result;
  }

  private applicationCode(): string {
    return this.config.get<string>('ACCOUNT_APPLICATION_CODE')?.trim() || DEFAULT_APPLICATION_CODE;
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
