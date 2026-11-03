import { Injectable, Logger } from '@nestjs/common';
import { AccountApiService } from '../account/account-api.service';
import { PartnersService } from '../partners/partners.service';

/** Event types AG Account sends (ag-account-server webhook-events.ts). */
export const ACCOUNT_WEBHOOK_EVENTS = {
  USER_ACCESS_CHANGED: 'USER_ACCESS_CHANGED',
  ROLE_PERMISSIONS_CHANGED: 'ROLE_PERMISSIONS_CHANGED',
  USER_STATUS_CHANGED: 'USER_STATUS_CHANGED',
  USER_PROFILE_CHANGED: 'USER_PROFILE_CHANGED',
  CONTRACT_PROFILE_CHANGED: 'CONTRACT_PROFILE_CHANGED',
  PING: 'PING',
} as const;

export type AccountWebhookEvent = {
  eventId?: string;
  type?: string;
  applicationCode?: string;
  userIds?: string[];
  occurredAt?: string;
  /** CONTRACT_PROFILE_CHANGED: `{ user_id, changed_fields, version, source, … }`, no values. */
  data?: { user_id?: string; changed_fields?: string[] } & Record<string, unknown>;
};

/** Event ids already handled are kept this long (AG Account retries for about 2.5 hours). */
const PROCESSED_TTL_MS = 24 * 60 * 60 * 1000;
const PROCESSED_MAX = 10_000;

/**
 * Handles AG Account webhooks: the partner display name follows the AG Account name
 * (USER_PROFILE_CHANGED, FR-P-10), a changed contract profile voids the last completeness check
 * (CONTRACT_PROFILE_CHANGED), and cached lookups of the users concerned are dropped.
 */
@Injectable()
export class AccountWebhooksService {
  private readonly logger = new Logger(AccountWebhooksService.name);
  private readonly processed = new Map<string, number>();

  constructor(
    private readonly accountApi: AccountApiService,
    private readonly partners: PartnersService,
  ) {}

  /** Returns false when the event id was already handled (AG Account retried it). */
  async handle(event: AccountWebhookEvent, headerEventId?: string): Promise<boolean> {
    const eventId = event.eventId ?? headerEventId;
    const now = Date.now();
    this.prune(now);
    if (eventId && this.processed.has(eventId)) {
      return false;
    }

    const userIds = (event.userIds ?? []).filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    );
    const contractProfileUser =
      typeof event.data?.user_id === 'string' ? event.data.user_id : undefined;
    const concerned = contractProfileUser ? [...userIds, contractProfileUser] : userIds;
    if (concerned.length > 0) {
      this.accountApi.forgetAccountUsers(concerned);
    }

    switch (event.type) {
      case ACCOUNT_WEBHOOK_EVENTS.USER_PROFILE_CHANGED: {
        const updated = await this.partners.refreshDisplayNames(userIds);
        this.logger.log(`USER_PROFILE_CHANGED: ${updated} partner name(s) updated`);
        break;
      }
      case ACCOUNT_WEBHOOK_EVENTS.CONTRACT_PROFILE_CHANGED:
        for (const id of new Set(concerned)) {
          await this.partners.markProfileChanged(id);
        }
        break;
      default:
        // PING, access changes (caches already dropped) and unknown types: nothing else to do.
        break;
    }

    if (eventId) {
      this.processed.set(eventId, now + PROCESSED_TTL_MS);
    }
    return true;
  }

  private prune(now: number): void {
    for (const [id, expiresAt] of this.processed) {
      if (expiresAt <= now || this.processed.size > PROCESSED_MAX) {
        this.processed.delete(id);
      } else {
        break;
      }
    }
  }
}
