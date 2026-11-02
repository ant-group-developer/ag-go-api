import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
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
import { AuthContextService } from '../../common/auth-context.service';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { RequireAnyPermissions, RequirePermissions } from '../../common/auth/permissions.decorator';
import { RawResponse } from '../../common/raw-response.decorator';
import { contentDisposition } from '../documents/document-templates.controller';
import {
  MAX_SIGNED_FILE_BYTES,
  type DocumentContent,
  type UploadedFile as SignedFile,
} from '../documents/documents.service';
import { DOCX_CONTENT_TYPE, PDF_CONTENT_TYPE } from '../documents/docx-renderer';
import { DocumentContentQueryDto, PreviewQueryDto } from '../documents/dto/document.dto';
import { partnerActor } from '../partners/partner-actor';
import { ContractDocumentsService } from './contract-documents.service';

const SIGNED_FILE_BODY = {
  schema: {
    type: 'object',
    required: ['file'],
    properties: {
      file: {
        type: 'string',
        format: 'binary',
        description: 'Bản ký (scan / PDF ký): PDF, JPG, PNG hoặc DOCX, tối đa 20 MB',
      },
    },
  },
};

const signedFileInterceptor = () =>
  FileInterceptor('file', { limits: { fileSize: MAX_SIGNED_FILE_BYTES, files: 1 } });

/**
 * Documents of contracts, amendments and acceptance records (spec 6.5, 10, 13): list, inline
 * viewing read from R2 by the backend (no bucket CORS, no URL to the browser), previews of drafts
 * rendered on the server, regeneration and signed copies.
 */
@ApiTags('contract-documents')
@ApiBearerAuth()
@Controller()
export class ContractDocumentsController {
  constructor(
    private readonly service: ContractDocumentsService,
    private readonly authContext: AuthContextService,
  ) {}

  // ----- contracts ---------------------------------------------------------

  @Get('contracts/:id/documents')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ)
  @ApiOperation({
    summary:
      'Chứng từ của HĐ, các phụ lục sửa đổi và BBNT: bản sinh (generated, theo phiên bản, trạng thái DOCX / PDF) và bản ký (signed)',
  })
  contractDocuments(@Req() request: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.list('contract', id, this.actor(request));
  }

  @Get('contracts/:id/versions/:no/content')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ)
  @RawResponse()
  @ApiProduces(DOCX_CONTENT_TYPE, PDF_CONTENT_TYPE)
  @ApiOperation({
    summary:
      'File HĐ phiên bản :no (inline, ?download=true để tải). 409 DOCUMENT_NOT_READY / DOCUMENT_PDF_NOT_READY. Ghi audit',
  })
  async contractVersion(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('no', ParseIntPipe) no: number,
    @Query() query: DocumentContentQueryDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const content = await this.service.versionContent(
      'contract',
      id,
      no,
      query.format ?? 'docx',
      this.actor(request),
    );
    return this.send(response, content, query.download);
  }

  @Post('contracts/:id/preview')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ, GO_PERMISSIONS.CONTRACT_MANAGE)
  @HttpCode(HttpStatus.OK)
  @RawResponse()
  @ApiProduces(DOCX_CONTENT_TYPE, PDF_CONTENT_TYPE)
  @ApiOperation({
    summary:
      'Xem trước HĐ từ dữ liệu hiện tại với template đang dùng, không lưu. Nháp: hồ sơ AG Account đọc trực tiếp (ghi audit như xem PII). Header X-Document-Missing: placeholder còn trống. 409 DOCUMENT_PDF_DISABLED khi chưa cấu hình Gotenberg, 503 DOCUMENT_PDF_FAILED',
  })
  async contractPreview(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: PreviewQueryDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const content = await this.service.preview(
      'contract',
      id,
      query.format ?? 'docx',
      this.actor(request),
    );
    return this.send(response, content, false, content.missing);
  }

  @Post('contracts/:id/signed-file')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_MANAGE)
  @ApiOperation({
    summary:
      'Upload bản ký của HĐ đã phát hành lên R2, gắn signedFileId của HĐ (dùng khi kích hoạt)',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody(SIGNED_FILE_BODY)
  @UseInterceptors(signedFileInterceptor())
  contractSigned(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file?: SignedFile,
  ) {
    return this.service.uploadSigned('contract', id, file, this.actor(request));
  }

  // ----- amendments --------------------------------------------------------

  @Get('contracts/:id/amendments/:amendmentId/documents')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ)
  @ApiOperation({ summary: 'Chứng từ của một phụ lục sửa đổi (bản sinh và bản ký)' })
  amendmentDocuments(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('amendmentId', ParseUUIDPipe) amendmentId: string,
  ) {
    return this.service.list('amendment', amendmentId, this.actor(request), id);
  }

  @Get('contracts/:id/amendments/:amendmentId/versions/:no/content')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ)
  @RawResponse()
  @ApiProduces(DOCX_CONTENT_TYPE, PDF_CONTENT_TYPE)
  @ApiOperation({ summary: 'File phụ lục sửa đổi phiên bản :no (inline). Ghi audit' })
  async amendmentVersion(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('amendmentId', ParseUUIDPipe) amendmentId: string,
    @Param('no', ParseIntPipe) no: number,
    @Query() query: DocumentContentQueryDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const content = await this.service.versionContent(
      'amendment',
      amendmentId,
      no,
      query.format ?? 'docx',
      this.actor(request),
      id,
    );
    return this.send(response, content, query.download);
  }

  @Post('contracts/:id/amendments/:amendmentId/preview')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ, GO_PERMISSIONS.CONTRACT_MANAGE)
  @HttpCode(HttpStatus.OK)
  @RawResponse()
  @ApiProduces(DOCX_CONTENT_TYPE, PDF_CONTENT_TYPE)
  @ApiOperation({ summary: 'Xem trước phụ lục sửa đổi, không lưu (như xem trước HĐ)' })
  async amendmentPreview(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('amendmentId', ParseUUIDPipe) amendmentId: string,
    @Query() query: PreviewQueryDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const content = await this.service.preview(
      'amendment',
      amendmentId,
      query.format ?? 'docx',
      this.actor(request),
      id,
    );
    return this.send(response, content, false, content.missing);
  }

  @Post('contracts/:id/amendments/:amendmentId/signed-file')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_MANAGE)
  @ApiOperation({
    summary: 'Upload bản ký của phụ lục đã phát hành, gắn signedFileId (dùng khi ghi nhận đã ký)',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody(SIGNED_FILE_BODY)
  @UseInterceptors(signedFileInterceptor())
  amendmentSigned(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('amendmentId', ParseUUIDPipe) amendmentId: string,
    @UploadedFile() file?: SignedFile,
  ) {
    return this.service.uploadSigned('amendment', amendmentId, file, this.actor(request), id);
  }

  // ----- acceptance records ------------------------------------------------

  @Get('acceptances/:id/documents')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ)
  @ApiOperation({ summary: 'Chứng từ của BBNT (các phiên bản sinh và bản ký)' })
  acceptanceDocuments(@Req() request: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.list('acceptance', id, this.actor(request));
  }

  @Get('acceptances/:id/versions/:no/content')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ)
  @RawResponse()
  @ApiProduces(DOCX_CONTENT_TYPE, PDF_CONTENT_TYPE)
  @ApiOperation({
    summary:
      'File BBNT đã phát hành phiên bản :no, Content-Disposition inline (backend đọc R2). PDF chưa có: 409 DOCUMENT_PDF_NOT_READY. Ghi audit',
  })
  async acceptanceVersion(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('no', ParseIntPipe) no: number,
    @Query() query: DocumentContentQueryDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const content = await this.service.versionContent(
      'acceptance',
      id,
      no,
      query.format ?? 'docx',
      this.actor(request),
    );
    return this.send(response, content, query.download);
  }

  @Post('acceptances/:id/preview')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ)
  @RequireAnyPermissions(GO_PERMISSIONS.ACCEPTANCE_PREPARE, GO_PERMISSIONS.ACCEPTANCE_APPROVE)
  @HttpCode(HttpStatus.OK)
  @RawResponse()
  @ApiProduces(DOCX_CONTENT_TYPE, PDF_CONTENT_TYPE)
  @ApiOperation({
    summary:
      'Xem trước BBNT từ dữ liệu nháp ở server, không lưu (spec 13); mỗi lần xem ghi audit như xem PII. Header X-Document-Missing; 409 DOCUMENT_PDF_DISABLED, 503 DOCUMENT_PDF_FAILED',
  })
  async acceptancePreview(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: PreviewQueryDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const content = await this.service.preview(
      'acceptance',
      id,
      query.format ?? 'docx',
      this.actor(request),
    );
    return this.send(response, content, false, content.missing);
  }

  @Post('acceptances/:id/signed-file')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ, GO_PERMISSIONS.ACCEPTANCE_APPROVE)
  @ApiOperation({
    summary: 'Upload bản ký của BBNT đã phát hành, gắn signedFileId (dùng khi ghi nhận đã ký)',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody(SIGNED_FILE_BODY)
  @UseInterceptors(signedFileInterceptor())
  acceptanceSigned(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file?: SignedFile,
  ) {
    return this.service.uploadSigned('acceptance', id, file, this.actor(request));
  }

  // ----- documents ---------------------------------------------------------

  @Get('documents/:id/content')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ)
  @RawResponse()
  @ApiProduces(DOCX_CONTENT_TYPE, PDF_CONTENT_TYPE)
  @ApiOperation({
    summary:
      'File của một chứng từ theo id (bản sinh: format=docx|pdf; bản ký: file đã upload). Inline, ?download=true để tải. Ghi audit',
  })
  async documentContent(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: DocumentContentQueryDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const content = await this.service.content(id, query.format ?? 'docx', this.actor(request));
    return this.send(response, content, query.download);
  }

  @Post('documents/:id/regenerate')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ)
  @RequireAnyPermissions(GO_PERMISSIONS.CONTRACT_MANAGE, GO_PERMISSIONS.ACCEPTANCE_APPROVE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Tạo lại: bản sinh lỗi / chưa xong thì sinh lại DOCX (cùng snapshot, cùng template), bản đã có thì tạo lại PDF. HĐ / phụ lục cần go.contract.manage, BBNT cần go.acceptance.approve',
  })
  regenerate(@Req() request: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.regenerate(id, this.actor(request));
  }

  private send(
    response: Response,
    content: DocumentContent,
    download: boolean | undefined,
    missing?: string[],
  ) {
    response.setHeader('Content-Type', content.contentType);
    response.setHeader(
      'Content-Disposition',
      contentDisposition(download ? 'attachment' : 'inline', content.fileName),
    );
    // The file holds personal data: never kept by a browser or proxy cache.
    response.setHeader('Cache-Control', 'no-store');
    if (missing) {
      response.setHeader('X-Document-Missing', missing.join(','));
    }
    return new StreamableFile(content.buffer);
  }

  private actor(request: Request) {
    return partnerActor(this.authContext.getContext(request), request);
  }
}
