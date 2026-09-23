import { Injectable, Logger } from '@nestjs/common';
import { AccountApiService } from '../modules/account/account-api.service';
import type { AccountUser } from '../modules/account/account.types';

export type ActorUser = Pick<AccountUser, 'id'> & {
  name?: unknown;
  email?: unknown;
  avatar?: unknown;
};

export type ActorField<T> = {
  id: keyof T & string;
  target: string;
};

@Injectable()
export class ActorEnrichmentService {
  private readonly logger = new Logger(ActorEnrichmentService.name);

  constructor(private readonly accountApi: AccountApiService) {}

  async enrich<T extends Record<string, unknown>>(
    rows: T[],
    fields: ActorField<T>[],
  ): Promise<T[]> {
    const ids: string[] = [];
    for (const row of rows) {
      for (const field of fields) {
        const value = row[field.id];
        if (typeof value === 'string' && value.length > 0) {
          ids.push(value);
        }
      }
    }
    if (ids.length === 0 || rows.length === 0) {
      return rows;
    }

    let users = new Map<string, AccountUser>();
    try {
      users = await this.accountApi.getUsersByIds(ids, 'id,name,email,avatar');
    } catch (error) {
      this.logger.warn(
        `Actor enrichment failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return rows.map((row) => {
      const enriched = { ...row };
      for (const field of fields) {
        const id = row[field.id];
        (enriched as Record<string, unknown>)[field.target] =
          typeof id === 'string' ? (users.get(id) ?? null) : null;
      }
      return enriched;
    });
  }
}
