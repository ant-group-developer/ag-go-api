import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  type RawBodyRequest,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../../common/auth/public.decorator';
import { AccountWebhooksService, type AccountWebhookEvent } from './account-webhooks.service';
import { ACCOUNT_WEBHOOK_HEADERS, accountWebhookRejectReason } from './webhook-signature';

/**
 * Receives AG Account webhooks (applications.webhook_url = `<API>/api/webhooks/account`). No user
 * token: the request is handled only when `X-AgAccount-Signature` matches ACCOUNT_WEBHOOK_SECRET
 * and the timestamp is within 5 minutes. Any accepted event answers 200, including a retried one
 * and unknown types; AG Account only looks at the status.
 */
@ApiExcludeController()
@Public()
@Controller('webhooks/account')
export class AccountWebhooksController {
  private readonly logger = new Logger(AccountWebhooksController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly webhooks: AccountWebhooksService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async receive(
    @Req() request: RawBodyRequest<Request>,
    @Headers(ACCOUNT_WEBHOOK_HEADERS.EVENT_ID) eventId?: string,
    @Headers(ACCOUNT_WEBHOOK_HEADERS.TIMESTAMP) timestamp?: string,
    @Headers(ACCOUNT_WEBHOOK_HEADERS.SIGNATURE) signature?: string,
  ) {
    const secret = this.config.get<string>('ACCOUNT_WEBHOOK_SECRET')?.trim();
    if (!secret) {
      throw new ServiceUnavailableException('AG Account webhooks are not configured');
    }
    const reason = accountWebhookRejectReason({
      secret,
      timestamp,
      signature,
      body: request.rawBody,
    });
    if (reason) {
      this.logger.warn(`Refused AG Account webhook (event ${eventId ?? '-'}): ${reason}`);
      throw new UnauthorizedException('Invalid webhook signature');
    }

    let event: AccountWebhookEvent;
    try {
      event = JSON.parse(request.rawBody!.toString('utf8')) as AccountWebhookEvent;
    } catch {
      throw new BadRequestException('Webhook body is not valid JSON');
    }
    if (typeof event !== 'object' || event === null) {
      throw new BadRequestException('Webhook body is not an event');
    }
    const handled = await this.webhooks.handle(event, eventId);
    return { received: true, duplicate: !handled };
  }
}
