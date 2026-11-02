import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ActorEnrichmentService } from '../../common/actor-enrichment.service';
import { AuthContextService } from '../../common/auth-context.service';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { RequirePermissions } from '../../common/auth/permissions.decorator';
import { MAX_CSV_FILE_SIZE_BYTES, type CsvUploadFile } from '../../common/csv/csv-import';
import { partnerActor } from '../partners/partner-actor';
import { LEGACY_CONTRACT_HEADERS } from './contract-import';
import { ContractsService } from './contracts.service';
import {
  ActivateContractDto,
  ContractReasonDto,
  ContractTermsQueryDto,
  CreateAmendmentDto,
  CreateContractDto,
  ListContractsQueryDto,
  NextContractNumberQueryDto,
  SignAmendmentDto,
  TerminateContractDto,
  UpdateAmendmentDto,
  UpdateContractDto,
} from './dto/contract.dto';

const ACTOR_FIELDS = [{ id: 'managerUserId' as const, target: 'managerUser' }];

@ApiTags('contracts')
@ApiBearerAuth()
@Controller('contracts')
export class ContractsController {
  constructor(
    private readonly contractsService: ContractsService,
    private readonly authContext: AuthContextService,
    private readonly actorEnrichment: ActorEnrichmentService,
  ) {}

  @Get()
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ)
  @ApiOperation({
    summary:
      'Danh sách HĐ (lọc đối tác, trạng thái, mô hình giá, người phụ trách). Không có go.contract.read_all: chỉ HĐ mình phụ trách.',
  })
  async list(@Req() request: Request, @Query() query: ListContractsQueryDto) {
    const result = await this.contractsService.list(query, this.actor(request));
    result.items = (await this.actorEnrichment.enrich(
      result.items as unknown as Array<Record<string, unknown>>,
      ACTOR_FIELDS,
    )) as unknown as typeof result.items;
    return result;
  }

  @Get('tech-spec-presets')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ)
  @ApiOperation({ summary: 'Preset tech spec (FR-C-03), vd. Footage 4K60' })
  techSpecPresets() {
    return this.contractsService.techSpecPresets();
  }

  @Get('next-number')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_MANAGE)
  @ApiOperation({ summary: 'Số HĐ sẽ cấp cho đối tác và ngày ký (BR-05)' })
  nextNumber(@Req() request: Request, @Query() query: NextContractNumberQueryDto) {
    return this.contractsService.nextNumber(query.partnerId, query.date, this.actor(request));
  }

  @Post()
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_MANAGE)
  @ApiOperation({ summary: 'Tạo HĐ nháp (cấu hình giá kiểm theo mô hình, FR-C-01)' })
  create(@Req() request: Request, @Body() dto: CreateContractDto) {
    return this.contractsService.create(dto, this.actor(request));
  }

  @Post('import')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: `Nhập HĐ cũ từ CSV (FR-C-11), tất cả hoặc không. Cột: ${LEGACY_CONTRACT_HEADERS.join(', ')}`,
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_CSV_FILE_SIZE_BYTES, files: 1 } }),
  )
  importCsv(@Req() request: Request, @UploadedFile() file?: CsvUploadFile) {
    return this.contractsService.importCsv(file, this.actor(request));
  }

  @Get(':id')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ)
  @ApiOperation({ summary: 'Chi tiết HĐ kèm phụ lục sửa đổi và các thao tác được phép' })
  async get(@Req() request: Request, @Param('id', ParseUUIDPipe) id: string) {
    const contract = await this.contractsService.get(id, this.actor(request));
    const [enriched] = await this.actorEnrichment.enrich(
      [contract as unknown as Record<string, unknown>],
      ACTOR_FIELDS,
    );
    return enriched;
  }

  @Patch(':id')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_MANAGE)
  @ApiOperation({
    summary:
      'Sửa HĐ: điều khoản chỉ khi nháp (409 CONTRACT_TERMS_LOCKED sau đó, dùng phụ lục); người phụ trách, ghi chú lúc nào cũng sửa được',
  })
  update(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateContractDto,
  ) {
    return this.contractsService.update(id, dto, this.actor(request));
  }

  @Delete(':id')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_MANAGE)
  @ApiOperation({ summary: 'Xoá HĐ nháp' })
  async remove(@Req() request: Request, @Param('id', ParseUUIDPipe) id: string) {
    await this.contractsService.remove(id, this.actor(request));
    return { success: true };
  }

  @Get(':id/terms')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ)
  @ApiOperation({ summary: 'Điều khoản hiệu lực tại một ngày (áp các phụ lục đã ký)' })
  terms(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ContractTermsQueryDto,
  ) {
    return this.contractsService.terms(id, query.date, this.actor(request));
  }

  @Post(':id/issue')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Phát hành: đọc hồ sơ AG Account, chụp snapshot mã hoá; 422 PARTNER_PROFILE_INCOMPLETE nếu thiếu trường',
  })
  issue(@Req() request: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.contractsService.issue(id, this.actor(request));
  }

  @Post(':id/unissue')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Huỷ phát hành, về nháp để sửa' })
  unissue(@Req() request: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.contractsService.unissue(id, this.actor(request));
  }

  @Post(':id/activate')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Kích hoạt: cần ngày ký và bản ký (quản trị bỏ qua bản ký được nếu nêu lý do)',
  })
  activate(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ActivateContractDto,
  ) {
    return this.contractsService.activate(id, dto, this.actor(request));
  }

  @Post(':id/suspend')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Tạm dừng HĐ đang hiệu lực' })
  suspend(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ContractReasonDto,
  ) {
    return this.contractsService.suspend(id, dto.reason, this.actor(request));
  }

  @Post(':id/resume')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Tiếp tục HĐ đang tạm dừng' })
  resume(@Req() request: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.contractsService.resume(id, this.actor(request));
  }

  @Post(':id/complete')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Hoàn thành (đủ nghĩa vụ / chạm trần)' })
  complete(@Req() request: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.contractsService.complete(id, this.actor(request));
  }

  @Post(':id/terminate')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Chấm dứt / thanh lý, bắt buộc lý do (FR-C-10)' })
  terminate(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TerminateContractDto,
  ) {
    return this.contractsService.terminate(id, dto.reason, this.actor(request));
  }

  @Get(':id/amendments')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ)
  @ApiOperation({ summary: 'Phụ lục sửa đổi của HĐ' })
  listAmendments(@Req() request: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.contractsService.listAmendments(id, this.actor(request));
  }

  @Post(':id/amendments')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_MANAGE)
  @ApiOperation({ summary: 'Tạo phụ lục sửa đổi nháp (HĐ active / suspended, FR-C-07)' })
  createAmendment(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateAmendmentDto,
  ) {
    return this.contractsService.createAmendment(id, dto, this.actor(request));
  }

  @Patch(':id/amendments/:amendmentId')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_MANAGE)
  @ApiOperation({ summary: 'Sửa phụ lục nháp' })
  updateAmendment(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('amendmentId', ParseUUIDPipe) amendmentId: string,
    @Body() dto: UpdateAmendmentDto,
  ) {
    return this.contractsService.updateAmendment(id, amendmentId, dto, this.actor(request));
  }

  @Delete(':id/amendments/:amendmentId')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_MANAGE)
  @ApiOperation({ summary: 'Xoá phụ lục nháp' })
  async removeAmendment(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('amendmentId', ParseUUIDPipe) amendmentId: string,
  ) {
    await this.contractsService.removeAmendment(id, amendmentId, this.actor(request));
    return { success: true };
  }

  @Post(':id/amendments/:amendmentId/issue')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Phát hành phụ lục (draft → issued)' })
  issueAmendment(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('amendmentId', ParseUUIDPipe) amendmentId: string,
  ) {
    return this.contractsService.issueAmendment(id, amendmentId, this.actor(request));
  }

  @Post(':id/amendments/:amendmentId/sign')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Ghi nhận phụ lục đã ký (issued → signed), có hiệu lực từ effectiveDate',
  })
  signAmendment(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('amendmentId', ParseUUIDPipe) amendmentId: string,
    @Body() dto: SignAmendmentDto,
  ) {
    return this.contractsService.signAmendment(
      id,
      amendmentId,
      dto.signedFileId,
      this.actor(request),
    );
  }

  private actor(request: Request) {
    return partnerActor(this.authContext.getContext(request), request);
  }
}
