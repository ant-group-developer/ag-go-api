import type { AccountApiService } from '../account/account-api.service';
import type { PartnersService } from '../partners/partners.service';
import { AccountWebhooksService } from './account-webhooks.service';
import { accountWebhookRejectReason, signAccountWebhook } from './webhook-signature';

jest.mock('uuid', () => ({ v7: () => 'generated-uuid' }));
jest.mock('@nestjs/typeorm', () => ({ InjectRepository: () => () => undefined }));
describe('AG Account webhook signature', () => {
  const secret = 'whsec';
  const body = Buffer.from('{"eventId":"e-1","type":"PING"}', 'utf8');
  const now = 1_800_000_000;

  it('accepts the signature AG Account computes', () => {
    // Same as ag-account-server signWebhook: sha256= + hex HMAC(secret, `${ts}.${body}`).
    const signature = signAccountWebhook(secret, String(now), body);
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(
      accountWebhookRejectReason({
        secret,
        timestamp: String(now),
        signature,
        body,
        nowSeconds: now + 60,
      }),
    ).toBeNull();
  });

  it('refuses a wrong signature, an altered body, a stale timestamp or missing headers', () => {
    const signature = signAccountWebhook(secret, String(now), body);
    const check = (overrides: Partial<Parameters<typeof accountWebhookRejectReason>[0]>) =>
      accountWebhookRejectReason({
        secret,
        timestamp: String(now),
        signature,
        body,
        nowSeconds: now,
        ...overrides,
      });

    expect(check({ secret: 'other' })).toBe('signature mismatch');
    expect(check({ body: Buffer.from('{"eventId":"e-2"}') })).toBe('signature mismatch');
    expect(check({ nowSeconds: now + 301 })).toMatch(/skewed/);
    expect(check({ signature: undefined })).toBe('missing timestamp or signature');
    expect(check({ signature: 'md5=abc' })).toBe('missing timestamp or signature');
    expect(check({ timestamp: 'yesterday' })).toBe('invalid timestamp');
    expect(check({ body: undefined })).toBe('missing raw body');
  });
});

describe('AccountWebhooksService', () => {
  function setup() {
    const accountApi = { forgetAccountUsers: jest.fn() };
    const partners = {
      refreshDisplayNames: jest.fn().mockResolvedValue(1),
      markProfileChanged: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AccountWebhooksService(
      accountApi as unknown as AccountApiService,
      partners as unknown as PartnersService,
    );
    return { service, accountApi, partners };
  }

  it('updates partner names on USER_PROFILE_CHANGED', async () => {
    const { service, accountApi, partners } = setup();

    await expect(
      service.handle({ eventId: 'e-1', type: 'USER_PROFILE_CHANGED', userIds: ['acc-1'] }),
    ).resolves.toBe(true);

    expect(accountApi.forgetAccountUsers).toHaveBeenCalledWith(['acc-1']);
    expect(partners.refreshDisplayNames).toHaveBeenCalledWith(['acc-1']);
  });

  it('voids the profile check on CONTRACT_PROFILE_CHANGED', async () => {
    const { service, partners } = setup();

    await service.handle({
      eventId: 'e-2',
      type: 'CONTRACT_PROFILE_CHANGED',
      userIds: ['acc-1'],
      data: { user_id: 'acc-1', changed_fields: ['bank_account_number'] },
    });

    expect(partners.markProfileChanged).toHaveBeenCalledTimes(1);
    expect(partners.markProfileChanged).toHaveBeenCalledWith('acc-1');
  });

  it('handles a retried event once and accepts unknown types', async () => {
    const { service, partners } = setup();
    const event = { eventId: 'e-3', type: 'USER_PROFILE_CHANGED', userIds: ['acc-1'] };

    await expect(service.handle(event)).resolves.toBe(true);
    await expect(service.handle(event)).resolves.toBe(false);
    await expect(service.handle({ type: 'SOMETHING_NEW' }, 'e-4')).resolves.toBe(true);
    await expect(service.handle({ type: 'PING' })).resolves.toBe(true);

    expect(partners.refreshDisplayNames).toHaveBeenCalledTimes(1);
  });
});
