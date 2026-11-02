import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ActorEnrichmentService } from '../../common/actor-enrichment.service';
import { AuthContextService } from '../../common/auth-context.service';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { RequirePermissions } from '../../common/auth/permissions.decorator';
import { RawResponse } from '../../common/raw-response.decorator';
import { contentDisposition } from '../documents/document-templates.controller';
import type { UploadedFile as ProofFile } from '../documents/documents.service';
import { partnerActor } from '../partners/partner-actor';
import {
  CancelPaymentDto,
  CreatePaymentDto,
  ListPaymentsQueryDto,
  OverdueQueryDto,
  PayoutExportQueryDto,
} from './dto/payment.dto';
import { MAX_PROOF_FILE_BYTES, PaymentsService } from './payments.service';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const ACTOR_FIELDS = [
  { id: 'createdBy' as const, target: 'createdByUser' },
  { id: 'cancelledBy' as const, target: 'cancelledByUser' },
];

const PROOF_FILE_BODY = {
  schema: {
    type: 'object',
    required: ['file'],
    properties: {
      file: {
        type: 'string',
        format: 'binary',
        description: 'Chứng từ chuyển khoản: PDF, JPG hoặc PNG, tối đa 10 MB',
      },
    },
  },
};

/**
 * Payments (spec 6.6, 10): record / cancel advances, payments of signed acceptance records and
 * refunds, transfer proofs, the contract ledger, overdue records and the payout export.
 */
@ApiTags('payments')
@ApiBearerAuth()
@Controller()
export class PaymentsController {
  constructor(
    private readonly service: PaymentsService,
    private readonly authContext: AuthContextService,
    private readonly actorEnrichment: ActorEnrichmentService,
  ) {}

  @Post('contracts/:id/payments')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ, GO_PERMISSIONS.PAYMENT_MANAGE)
  @ApiOperation({
    summary:
      'Ghi nhận chi tạm ứng (advance, HĐ active/suspended, không vượt tạm ứng thoả thuận), chi trả BBNT đã ký (settlement + acceptanceId, một hoặc nhiều lần; đủ thực lĩnh → paid, chưa đủ → partially_paid) hoặc đối tác hoàn tạm ứng (refund, không vượt số dư). Tạm ứng/hoàn đổi thì BBNT nháp của HĐ được tính lại. Ghi audit',
  })
  create(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreatePaymentDto,
  ) {
    return this.service.create(id, dto, this.actor(request));
  }

  @Get('contracts/:id/ledger')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ)
  @ApiOperation({
    summary:
      'Sổ công nợ HĐ (FR-$-04): đã nghiệm thu, thuế, đối trừ, thực lĩnh, đã chi, tạm ứng đã chi / số dư, còn phải trả, quá hạn, % trần và cảnh báo 80%/100%, số phải hoàn khi HĐ đóng (FR-C-10); BBNT đã phát hành và các khoản chi',
  })
  ledger(@Req() request: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.ledger(id, this.actor(request));
  }

  @Get('payments')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ)
  @ApiOperation({
    summary:
      'Danh sách khoản chi (lọc HĐ, đối tác, BBNT, loại, trạng thái, ngày chi). Không có go.contract.read_all: chỉ HĐ mình phụ trách',
  })
  async list(@Req() request: Request, @Query() query: ListPaymentsQueryDto) {
    const result = await this.service.list(query, this.actor(request));
    result.items = (await this.actorEnrichment.enrich(
      result.items as unknown as Array<Record<string, unknown>>,
      ACTOR_FIELDS,
    )) as unknown as typeof result.items;
    return result;
  }

  @Get('payments/overdue')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ)
  @ApiOperation({
    summary:
      'BBNT đã ký quá hạn thanh toán (hạn theo ngày làm việc, BR-34) còn phải trả, kèm số ngày quá hạn (FR-$-03, FR-R-05)',
  })
  overdue(@Req() request: Request, @Query() query: OverdueQueryDto) {
    return this.service.overdue(query, this.actor(request));
  }

  @Get('payments/export')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ, GO_PERMISSIONS.PAYMENT_MANAGE)
  @RawResponse()
  @ApiProduces(XLSX)
  @ApiOperation({
    summary:
      'Xuất Excel danh sách chi trả cho kế toán (FR-$-05): BBNT đã ký còn phải trả, đối tác, MST, số tài khoản, ngân hàng (từ hồ sơ chụp khi phát hành), gộp / thuế / đối trừ / thực lĩnh / đã chi / còn lại / hạn. MST và STK bị che trừ khi reveal=true (cần go.partner.pii_read). Ghi audit',
  })
  async exportPayouts(
    @Req() request: Request,
    @Query() query: PayoutExportQueryDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const file = await this.service.exportPayouts(query, this.actor(request));
    response.setHeader('Content-Type', file.contentType);
    response.setHeader('Content-Disposition', contentDisposition('attachment', file.fileName));
    return new StreamableFile(file.buffer);
  }

  @Get('payments/:id')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ)
  @ApiOperation({ summary: 'Chi tiết một khoản chi' })
  async get(@Req() request: Request, @Param('id', ParseUUIDPipe) id: string) {
    const payment = await this.service.get(id, this.actor(request));
    const [enriched] = await this.actorEnrichment.enrich(
      [payment as unknown as Record<string, unknown>],
      ACTOR_FIELDS,
    );
    return enriched;
  }

  @Post('payments/:id/cancel')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ, GO_PERMISSIONS.PAYMENT_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Huỷ khoản chi kèm lý do (không xoá). Chi trả BBNT huỷ → BBNT về partially_paid / signed; không huỷ được tạm ứng đã đối trừ ở BBNT đã phát hành (409 PAYMENT_ADVANCE_ALREADY_OFFSET). Ghi audit',
  })
  cancel(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelPaymentDto,
  ) {
    return this.service.cancel(id, dto.reason, this.actor(request));
  }

  @Post('payments/:id/proof')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ, GO_PERMISSIONS.PAYMENT_MANAGE)
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_PROOF_FILE_BYTES, files: 1 } }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody(PROOF_FILE_BODY)
  @ApiOperation({
    summary: 'Upload chứng từ chuyển khoản (lưu R2, thay bản trước nếu có). Ghi audit',
  })
  uploadProof(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: ProofFile | undefined,
  ) {
    return this.service.uploadProof(id, file, this.actor(request));
  }

  @Get('payments/:id/proof')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ)
  @RawResponse()
  @ApiProduces('application/pdf', 'image/jpeg', 'image/png')
  @ApiOperation({
    summary:
      'Xem chứng từ chuyển khoản (inline, đọc từ R2 qua API). 404 PAYMENT_PROOF_MISSING. Ghi audit',
  })
  async proof(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const content = await this.service.proofContent(id, this.actor(request));
    response.setHeader('Content-Type', content.contentType);
    response.setHeader('Content-Disposition', contentDisposition('inline', content.fileName));
    return new StreamableFile(content.buffer);
  }

  private actor(request: Request) {
    return partnerActor(this.authContext.getContext(request), request);
  }
}
