import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ActorEnrichmentService } from '../../common/actor-enrichment.service';
import { AuthContextService } from '../../common/auth-context.service';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { RequireAnyPermissions, RequirePermissions } from '../../common/auth/permissions.decorator';
import { partnerActor } from '../partners/partner-actor';
import { AcceptancesService } from './acceptances.service';
import {
  AcceptanceReasonDto,
  AdjustItemDto,
  ApproveAcceptanceDto,
  CreateAcceptanceDto,
  EligibleQueryDto,
  ListAcceptancesQueryDto,
  SignAcceptanceDto,
  UpdateAcceptanceDto,
} from './dto/acceptance.dto';

const ACTOR_FIELDS = [
  { id: 'preparedBy' as const, target: 'preparedByUser' },
  { id: 'approvedBy' as const, target: 'approvedByUser' },
];

@ApiTags('acceptances')
@ApiBearerAuth()
@Controller()
export class AcceptancesController {
  constructor(
    private readonly service: AcceptancesService,
    private readonly authContext: AuthContextService,
    private readonly actorEnrichment: ActorEnrichmentService,
  ) {}

  @Get('contracts/:id/eligible-projects')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ, GO_PERMISSIONS.ACCEPTANCE_PREPARE)
  @ApiOperation({
    summary:
      'Xem trước BBNT của HĐ cho kỳ kết thúc ngày periodEnd: dòng sẽ gom (gói evaluated / dự án đã giao), dự án không tính kèm lý do, cảnh báo. Không lưu',
  })
  eligible(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: EligibleQueryDto,
  ) {
    return this.service.eligible(id, query.periodEnd, this.actor(request));
  }

  @Post('contracts/:id/acceptances')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ, GO_PERMISSIONS.ACCEPTANCE_PREPARE)
  @ApiOperation({
    summary:
      'Tạo BBNT nháp cho HĐ active và kỳ: tự gom (BR-20) và tính tiền theo mô hình giá, thuế, đối trừ tạm ứng, bằng chữ (FR-A-01, FR-A-02, FR-A-05)',
  })
  create(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateAcceptanceDto,
  ) {
    return this.service.create(id, dto, this.actor(request));
  }

  @Get('acceptances')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ)
  @ApiOperation({
    summary:
      'Danh sách BBNT (lọc HĐ, đối tác, trạng thái, người phụ trách). Không có go.contract.read_all: chỉ HĐ mình phụ trách',
  })
  list(@Req() request: Request, @Query() query: ListAcceptancesQueryDto) {
    return this.service.list(query, this.actor(request));
  }

  @Get('acceptances/:id')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ)
  @ApiOperation({
    summary:
      'Chi tiết BBNT: dòng (giá trị tính / điều chỉnh / lý do), dự án gom vào và bị loại kèm lý do, tổng tiền, trần HĐ, cảnh báo, thao tác được phép',
  })
  async get(@Req() request: Request, @Param('id', ParseUUIDPipe) id: string) {
    const detail = await this.service.get(id, this.actor(request));
    const [enriched] = await this.actorEnrichment.enrich(
      [detail as unknown as Record<string, unknown>],
      ACTOR_FIELDS,
    );
    return enriched;
  }

  @Patch('acceptances/:id')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ, GO_PERMISSIONS.ACCEPTANCE_PREPARE)
  @ApiOperation({
    summary:
      'Sửa BBNT nháp: kỳ, ngày lập, hình thức bàn giao, thuế (tỷ lệ / nhập tay có lý do), đối trừ tạm ứng nhập tay, bỏ dự án / gói (FR-A-04). Đổi kỳ hoặc danh sách bỏ thì tính lại',
  })
  update(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAcceptanceDto,
  ) {
    return this.service.update(id, dto, this.actor(request));
  }

  @Patch('acceptances/:id/items/:itemId')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ, GO_PERMISSIONS.ACCEPTANCE_PREPARE)
  @ApiOperation({
    summary:
      'Điều chỉnh một dòng (khối lượng, đơn giá, tên): bắt buộc lý do khi khác giá trị hệ thống tính (FR-A-03, BR-14); ghi audit chênh lệch',
  })
  adjustItem(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: AdjustItemDto,
  ) {
    return this.service.adjustItem(id, itemId, dto, this.actor(request));
  }

  @Post('acceptances/:id/recalculate')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ, GO_PERMISSIONS.ACCEPTANCE_PREPARE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Gom và tính lại từ dữ liệu mới nhất, giữ điều chỉnh của các dòng còn lại',
  })
  recalculate(@Req() request: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.recalculate(id, this.actor(request));
  }

  @Post('acceptances/:id/submit')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ, GO_PERMISSIONS.ACCEPTANCE_PREPARE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Gửi duyệt (draft → submitted); 422 ACCEPTANCE_EMPTY khi không có gì để trả',
  })
  submit(@Req() request: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.submit(id, this.actor(request));
  }

  @Post('acceptances/:id/return')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ, GO_PERMISSIONS.ACCEPTANCE_APPROVE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Trả lại kèm lý do (submitted → draft)' })
  returnRecord(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AcceptanceReasonDto,
  ) {
    return this.service.returnRecord(id, dto.reason, this.actor(request));
  }

  @Post('acceptances/:id/approve')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ, GO_PERMISSIONS.ACCEPTANCE_APPROVE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Duyệt (submitted → approved). 409 ACCEPTANCE_CAP_EXCEEDED khi vượt trần; 422 ACCEPTANCE_APPROVAL_NOTE_REQUIRED khi còn cảnh báo (80/20, tụt Mức…) mà không ghi quyết định',
  })
  approve(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveAcceptanceDto,
  ) {
    return this.service.approve(id, dto.note, this.actor(request));
  }

  @Post('acceptances/:id/issue')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ, GO_PERMISSIONS.ACCEPTANCE_APPROVE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Phát hành và khoá (approved → issued): cấp số phụ lục tiếp theo của HĐ, chụp hồ sơ đối tác mã hoá (BR-02) và thông tin Bên A, gói → accepted, worker-io sinh file DOCX/PDF (GET /acceptances/:id/documents). Chặn khi HĐ không active, dòng không có giá, vượt trần (FR-A-07); 422 COMPANY_PROFILE_INCOMPLETE / DOCUMENT_TEMPLATE_MISSING / DOCUMENT_DATA_MISSING (details.missing) trước khi sinh (FR-D-03)',
  })
  issue(@Req() request: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.issue(id, this.actor(request));
  }

  @Post('acceptances/:id/sign')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ, GO_PERMISSIONS.ACCEPTANCE_APPROVE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Ghi nhận đã ký (issued → signed), tính hạn thanh toán theo ngày làm việc (BR-34). signedFileId: bản ký đã upload (POST /acceptances/:id/signed-file)',
  })
  sign(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SignAcceptanceDto,
  ) {
    return this.service.sign(id, dto, this.actor(request));
  }

  @Post('acceptances/:id/cancel')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ)
  @RequireAnyPermissions(GO_PERMISSIONS.ACCEPTANCE_PREPARE, GO_PERMISSIONS.ACCEPTANCE_APPROVE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Huỷ kèm lý do: nháp / chờ duyệt cần go.acceptance.prepare, đã duyệt / đã phát hành cần go.acceptance.approve. Trả dự án và gói, số phụ lục không dùng lại',
  })
  cancel(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AcceptanceReasonDto,
  ) {
    return this.service.cancel(id, dto.reason, this.actor(request));
  }

  private actor(request: Request) {
    return partnerActor(this.authContext.getContext(request), request);
  }
}
