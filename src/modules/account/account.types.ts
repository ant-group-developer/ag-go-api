export type AccountUser = {
  id: string;
  [key: string]: unknown;
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
