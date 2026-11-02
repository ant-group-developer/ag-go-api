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
import { AuthContextService } from '../../common/auth-context.service';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { RequireAnyPermissions, RequirePermissions } from '../../common/auth/permissions.decorator';
import { RawResponse } from '../../common/raw-response.decorator';
import { partnerActor } from '../partners/partner-actor';
import {
  CloneRateCardDto,
  CreateRateCardDto,
  EffectiveRateCardQueryDto,
  ImportRateCardDto,
  ListRateCardsQueryDto,
  PublishRateCardDto,
  UpdateRateCardDto,
} from './dto/rate-card.dto';
import { MAX_RATE_CARD_FILE_SIZE_BYTES } from './rate-card-excel';
import { RateCardsService, type RateCardFile } from './rate-cards.service';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

@ApiTags('rate-cards')
@ApiBearerAuth()
@Controller('rate-cards')
export class RateCardsController {
  constructor(
    private readonly service: RateCardsService,
    private readonly authContext: AuthContextService,
  ) {}

  @Get()
  @RequireAnyPermissions(GO_PERMISSIONS.CONTRACT_READ, GO_PERMISSIONS.RATE_CARD_MANAGE)
  @ApiOperation({ summary: 'Các phiên bản bảng giá CTV (lọc mã, trạng thái), mới nhất trước' })
  list(@Query() query: ListRateCardsQueryDto) {
    return this.service.list(query);
  }

  @Get('effective')
  @RequireAnyPermissions(GO_PERMISSIONS.CONTRACT_READ, GO_PERMISSIONS.RATE_CARD_MANAGE)
  @ApiOperation({
    summary:
      'Phiên bản đã phát hành của mã bảng giá hiệu lực tại một ngày (Q-R1); 404 RATE_CARD_NOT_IN_FORCE',
  })
  effective(@Query() query: EffectiveRateCardQueryDto) {
    return this.service.effective(query.code, query.date);
  }

  @Post()
  @RequirePermissions(GO_PERMISSIONS.RATE_CARD_MANAGE)
  @ApiOperation({ summary: 'Tạo phiên bản nháp (phiên bản tự tăng theo mã)' })
  create(@Req() request: Request, @Body() dto: CreateRateCardDto) {
    return this.service.create(dto, this.actor(request));
  }

  @Post('import')
  @RequirePermissions(GO_PERMISSIONS.RATE_CARD_MANAGE)
  @ApiOperation({
    summary:
      'Nhập file Excel theo bố cục "Bảng lương CTV (chuẩn)" thành phiên bản nháp mới (tất cả hoặc không; 400 RATE_CARD_FILE_INVALID kèm details.errors)',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'code', 'effectiveFrom'],
      properties: {
        file: { type: 'string', format: 'binary' },
        code: { type: 'string', example: 'CTV-2026' },
        effectiveFrom: { type: 'string', example: '2026-07-15' },
        note: { type: 'string' },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_RATE_CARD_FILE_SIZE_BYTES, files: 1 } }),
  )
  importXlsx(
    @Req() request: Request,
    @Body() dto: ImportRateCardDto,
    @UploadedFile() file?: RateCardFile,
  ) {
    return this.service.importXlsx(file, dto, this.actor(request));
  }

  @Get(':id')
  @RequireAnyPermissions(GO_PERMISSIONS.CONTRACT_READ, GO_PERMISSIONS.RATE_CARD_MANAGE)
  @ApiOperation({ summary: 'Chi tiết phiên bản: ô giá (sản phẩm × cấp × Mức), quy tắc cấp' })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(id);
  }

  @Patch(':id')
  @RequirePermissions(GO_PERMISSIONS.RATE_CARD_MANAGE)
  @ApiOperation({
    summary:
      'Sửa bản nháp (items / levelRules thay toàn bộ); 409 RATE_CARD_LOCKED khi đã phát hành',
  })
  update(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRateCardDto,
  ) {
    return this.service.update(id, dto, this.actor(request));
  }

  @Delete(':id')
  @RequirePermissions(GO_PERMISSIONS.RATE_CARD_MANAGE)
  @ApiOperation({ summary: 'Xoá bản nháp' })
  async remove(@Req() request: Request, @Param('id', ParseUUIDPipe) id: string) {
    await this.service.remove(id, this.actor(request));
    return { success: true };
  }

  @Post(':id/clone')
  @RequirePermissions(GO_PERMISSIONS.RATE_CARD_MANAGE)
  @ApiOperation({ summary: 'Tạo phiên bản mới (nháp) từ phiên bản này' })
  clone(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloneRateCardDto,
  ) {
    return this.service.clone(id, dto, this.actor(request));
  }

  @Post(':id/publish')
  @RequirePermissions(GO_PERMISSIONS.RATE_CARD_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Phát hành bản nháp; phiên bản trước kết thúc ngày hôm trước. 409 RATE_CARD_EFFECTIVE_FROM_INVALID nếu không sau phiên bản đã phát hành',
  })
  publish(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PublishRateCardDto,
  ) {
    return this.service.publish(id, dto.effectiveFrom, this.actor(request));
  }

  @Post(':id/archive')
  @RequirePermissions(GO_PERMISSIONS.RATE_CARD_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Lưu trữ (không còn dùng để tính tiền)' })
  archive(@Req() request: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.archive(id, this.actor(request));
  }

  @Get(':id/export')
  @RequireAnyPermissions(GO_PERMISSIONS.CONTRACT_READ, GO_PERMISSIONS.RATE_CARD_MANAGE)
  @RawResponse()
  @ApiProduces(XLSX)
  @ApiOperation({ summary: 'Xuất Excel theo bố cục "Bảng lương CTV (chuẩn)"' })
  async exportXlsx(
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { fileName, buffer } = await this.service.exportXlsx(id);
    response.setHeader('Content-Type', XLSX);
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    );
    return new StreamableFile(buffer);
  }

  private actor(request: Request) {
    return partnerActor(this.authContext.getContext(request), request);
  }
}
