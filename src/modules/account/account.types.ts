import type { UserType } from '../../common/auth/user-type';

export type AccountUser = {
  id: string;
  [key: string]: unknown;
};

export type AccountCurrentUser = AccountUser & {
  user_type: UserType;
  permissions: string[];
};

export type AccountUsersResponse = {
  data: AccountUser[];
  meta: {
    total: number;
    page: number;
    page_size: number;
    total_pages: number;
  };
};

export type AccountApplication = {
  id: string;
  name: string;
  code: string;
  description?: string | null;
  website?: string | null;
  logo?: string | null;
  visibility?: string;
  is_active?: boolean;
};

export type AccountUserQuery = {
  fields?: string;
  include_inactive?: boolean;
};

export type AccountUserSearchQuery = {
  keyword?: string;
  page?: number;
  limit?: number;
};

export type AccountUserSummary = {
  id: string;
  name?: string;
  email?: string;
  avatar?: string;
};

/** Pagination meta of Account API admin lists (`GET /v2/users`), unlike `public/users`. */
export type AccountPaginationMeta = {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
};

export type AccountUserSearchResponse = {
  data: AccountUserSummary[];
  meta: Pick<AccountPaginationMeta, 'total' | 'page' | 'limit' | 'totalPages' | 'hasNextPage'>;
};
