export const ALLOWED_SERVICE_SCOPES = ['footage:read', 'footage:resolve', 'usage:write'] as const;

export type AllowedServiceScope = (typeof ALLOWED_SERVICE_SCOPES)[number];

export interface ServiceKeyEntry {
  name: string;
  sha256: string;
  scopes: string[];
  canActAsAdmin?: boolean;
}
