import { Controller, Get, Query, Req, Res, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuthContextService } from '../../common/auth-context.service';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { RequirePermissions } from '../../common/auth/permissions.decorator';
import { RawResponse } from '../../common/raw-response.decorator';
import { contentDisposition } from '../documents/document-templates.controller';
import { partnerActor } from '../partners/partner-actor';
import {
  AcceptanceStatusReportQueryDto,
  PaymentReportQueryDto,
  ReportExportQueryDto,
  TaxReportQueryDto,
} from './dto/payment.dto';
import { PaymentReportsService } from './payment-reports.service';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Reports of payments and acceptance records (spec 6.7). Without go.contract.read_all only the
 * contracts one manages are counted.
 */
@ApiTags('payment-reports')
@ApiBearerAuth()
@Controller('payment-reports')
export class PaymentReportsController {
  constructor(
    private readonly service: PaymentReportsService,
    private readonly authContext: AuthContextService,
  ) {}

  @Get('payables')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ)
  @ApiOperation({
    summary:
      'Công nợ hiện tại theo HĐ và theo đối tác (sổ công nợ của nhiều HĐ): nghiệm thu, thuế, thực lĩnh, đã chi, tạm ứng, số dư tạm ứng, còn phải trả, quá hạn, % trần; capAlerts: HĐ đạt 80%/100% trần (FR-C-09, FR-R-05). from/to không áp dụng',
  })
  payables(@Req() request: Request, @Query() query: PaymentReportQueryDto) {
    return this.service.payables(query, this.actor(request));
  }

  @Get('payments')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ)
  @ApiOperation({
    summary:
      'Thanh toán theo kỳ (ngày chi trong from–to): tổng theo tháng và loại (tạm ứng, thanh toán BBNT, hoàn tạm ứng, chi ròng) và danh sách khoản chi (FR-R-01)',
  })
  payments(@Req() request: Request, @Query() query: PaymentReportQueryDto) {
    return this.service.paymentsByPeriod(query, this.actor(request));
  }

  @Get('acceptances')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ)
  @ApiOperation({
    summary:
      'BBNT theo trạng thái (ngày lập trong from–to): số lượng, gộp, thuế, thực lĩnh, đã chi, còn phải trả theo trạng thái và danh sách (lọc status)',
  })
  acceptances(@Req() request: Request, @Query() query: AcceptanceStatusReportQueryDto) {
    return this.service.acceptancesByStatus(query, this.actor(request));
  }

  @Get('tax')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ)
  @ApiOperation({
    summary:
      'Thuế TNCN đã khấu trừ theo đối tác trong năm (BBNT đã phát hành, theo ngày lập), hỗ trợ quyết toán (FR-R-04)',
  })
  tax(@Req() request: Request, @Query() query: TaxReportQueryDto) {
    return this.service.taxByPartner(query, this.actor(request));
  }

  @Get('export')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ)
  @RawResponse()
  @ApiProduces(XLSX)
  @ApiOperation({
    summary:
      'Xuất Excel một báo cáo: report=payables (2 sheet: theo HĐ, theo đối tác) | payments (theo tháng, chi tiết) | acceptances (theo trạng thái, danh sách) | tax (cần year). Ghi audit',
  })
  async export(
    @Req() request: Request,
    @Query() query: ReportExportQueryDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const file = await this.service.exportXlsx(query, this.actor(request));
    response.setHeader('Content-Type', file.contentType);
    response.setHeader('Content-Disposition', contentDisposition('attachment', file.fileName));
    return new StreamableFile(file.buffer);
  }

  private actor(request: Request) {
    return partnerActor(this.authContext.getContext(request), request);
  }
}
