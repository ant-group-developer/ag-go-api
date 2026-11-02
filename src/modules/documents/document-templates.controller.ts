import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
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
import { CompanySettingsService } from './company-settings.service';
import {
  DocumentTemplatesService,
  MAX_TEMPLATE_BYTES,
  type TemplateUploadFile,
} from './document-templates.service';
import { DOCX_CONTENT_TYPE } from './docx-renderer';
import {
  ListTemplatesQueryDto,
  PlaceholdersQueryDto,
  UpdateCompanySettingsDto,
  UploadTemplateDto,
  ValidateTemplateDto,
} from './dto/document.dto';

/** `Content-Disposition` with an ASCII fallback and the UTF-8 name. */
export function contentDisposition(type: 'inline' | 'attachment', fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

const TEMPLATE_FILE_BODY = {
  schema: {
    type: 'object',
    required: ['file', 'kind'],
    properties: {
      file: { type: 'string', format: 'binary' },
      kind: { type: 'string', enum: ['contract', 'amendment', 'acceptance'] },
      pricingModel: { type: 'string', enum: ['per_topic', 'per_unit', 'package_tier'] },
      name: { type: 'string' },
      note: { type: 'string' },
      activate: { type: 'boolean', default: true },
    },
  },
};

@ApiTags('contract-templates')
@ApiBearerAuth()
@Controller('contract-templates')
export class DocumentTemplatesController {
  constructor(
    private readonly templates: DocumentTemplatesService,
    private readonly authContext: AuthContextService,
  ) {}

  @Get()
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_TEMPLATE_MANAGE)
  @ApiOperation({
    summary:
      'Các phiên bản template (HĐ theo mô hình giá, phụ lục sửa đổi, BBNT), mới nhất trước; isActive = bản dùng khi phát hành',
  })
  list(@Query() query: ListTemplatesQueryDto) {
    return this.templates.list(query);
  }

  @Get('placeholders')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_TEMPLATE_MANAGE)
  @ApiOperation({
    summary:
      'Danh sách placeholder dùng được cho một loại chứng từ (giá trị, vòng lặp, điều kiện) kèm ví dụ (spec 13)',
  })
  placeholders(@Query() query: PlaceholdersQueryDto) {
    return this.templates.placeholders(query.kind);
  }

  @Post('validate')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_TEMPLATE_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Kiểm tra file DOCX không lưu: lỗi cú pháp, placeholder lạ (unknown), placeholder nên có mà thiếu (missingRecommended)',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'kind'],
      properties: {
        file: { type: 'string', format: 'binary' },
        kind: { type: 'string', enum: ['contract', 'amendment', 'acceptance'] },
      },
    },
  })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_TEMPLATE_BYTES, files: 1 } }))
  validate(@Body() dto: ValidateTemplateDto, @UploadedFile() file?: TemplateUploadFile) {
    return this.templates.validate(dto.kind, file);
  }

  @Post()
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_TEMPLATE_MANAGE)
  @ApiOperation({
    summary:
      'Upload phiên bản mới (DOCX ≤ 10 MB) lên R2. 422 DOCUMENT_TEMPLATE_INVALID khi lỗi cú pháp hoặc có placeholder lạ; warnings = placeholder nên có mà thiếu',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody(TEMPLATE_FILE_BODY)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_TEMPLATE_BYTES, files: 1 } }))
  upload(
    @Req() request: Request,
    @Body() dto: UploadTemplateDto,
    @UploadedFile() file?: TemplateUploadFile,
  ) {
    return this.templates.upload(dto, file, this.actor(request));
  }

  @Post('install-defaults')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_TEMPLATE_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Cài mẫu tạm của hệ thống (Q-R9) cho loại / mô hình chưa có template nào: HĐ package_tier, per_topic, per_unit, phụ lục sửa đổi, BBNT',
  })
  installDefaults(@Req() request: Request) {
    return this.templates.installDefaults(this.actor(request));
  }

  @Get(':id/content')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_TEMPLATE_MANAGE)
  @RawResponse()
  @ApiProduces(DOCX_CONTENT_TYPE)
  @ApiOperation({ summary: 'Tải file DOCX của phiên bản template' })
  async content(
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { template, buffer } = await this.templates.content(id);
    response.setHeader('Content-Type', DOCX_CONTENT_TYPE);
    response.setHeader('Content-Disposition', contentDisposition('attachment', template.fileName));
    return new StreamableFile(buffer);
  }

  @Post(':id/activate')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_TEMPLATE_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Dùng phiên bản này khi phát hành (bỏ kích hoạt bản trước cùng loại)' })
  activate(@Req() request: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.templates.activate(id, this.actor(request));
  }

  private actor(request: Request) {
    return partnerActor(this.authContext.getContext(request), request);
  }
}

@ApiTags('settings')
@ApiBearerAuth()
@Controller('settings/company')
export class CompanySettingsController {
  constructor(
    private readonly company: CompanySettingsService,
    private readonly authContext: AuthContextService,
  ) {}

  @Get()
  @RequireAnyPermissions(
    GO_PERMISSIONS.CONTRACT_TEMPLATE_MANAGE,
    GO_PERMISSIONS.SETTINGS_MANAGE,
    GO_PERMISSIONS.CONTRACT_MANAGE,
  )
  @ApiOperation({
    summary:
      'Thông tin Bên A (tên, MST, người đại diện, chức vụ, địa chỉ…) in trên chứng từ; complete / missing (FR-D-05)',
  })
  get() {
    return this.company.get();
  }

  @Put()
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_TEMPLATE_MANAGE)
  @ApiOperation({
    summary:
      'Sửa thông tin Bên A (trường gửi lên được ghi, null xoá). Chứng từ đã phát hành giữ bản chụp cũ',
  })
  update(@Req() request: Request, @Body() dto: UpdateCompanySettingsDto) {
    return this.company.update(dto, this.authContext.getContext(request).userId);
  }
}
