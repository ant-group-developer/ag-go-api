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

/**
 * Fields of the AG Account contract profile (`/v2/public/users/:userId/contract-profile`), as named
 * there. `contract_number` / `contract_date` belong to AG Music (one contract per person) and are
 * never written by AG Go.
 */
export const ACCOUNT_CONTRACT_PROFILE_FIELDS = [
  'citizen_id_number',
  'id_issued_date',
  'id_issued_place',
  'tax_number',
  'phone_number',
  'birthday',
  'address',
  'permanent_address',
  'passport_number',
  'contract_number',
  'contract_date',
  'bank_account_name',
  'bank_account_number',
  'bank_code',
  'bank_name',
  'tax_mode',
] as const;

export type AccountContractProfileField = (typeof ACCOUNT_CONTRACT_PROFILE_FIELDS)[number];

/** Tax modes of AG Account (`tax_mode`); the person's, not the contract's (Q16). */
export const ACCOUNT_TAX_MODES = ['WITHHOLD_10', 'SELF_DECLARE', 'BUSINESS_HOUSEHOLD'] as const;

export type AccountContractProfile = Record<AccountContractProfileField, string | null> & {
  user_id: string;
  name: string;
  bank_account_last4: string | null;
  /** The passport number is stored but could not be decrypted (returned as null). */
  passport_unreadable: boolean;
  bank_account_unreadable: boolean;
  updated_at: string | null;
  /** Opaque version, sent back in `If-Match` when patching. */
  version: string;
};

export type AccountContractProfileUpdateResult = AccountContractProfile & {
  changed_fields: AccountContractProfileField[];
  warnings?: string[];
};

/** Writes of a PATCH: null clears the field, a missing key keeps it. */
export type AccountContractProfileChanges = Partial<
  Record<AccountContractProfileField, string | null>
>;

/** `GET /v2/public/users/by-sub/access`: AG Account's own id of a token subject. */
export type AccountUserBySub = {
  user_id: string;
  application?: string;
  is_active?: boolean;
  user_type: UserType;
  permissions: string[];
};
