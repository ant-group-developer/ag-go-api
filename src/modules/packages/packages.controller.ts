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
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthContextService } from '../../common/auth-context.service';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { RequireAnyPermissions } from '../../common/auth/permissions.decorator';
import { partnerActor } from '../partners/partner-actor';
import {
  CreatePackageDto,
  ListPackagesQueryDto,
  ReturnPackageDto,
  UpdatePackageDto,
} from './dto/package.dto';
import { PackagesService } from './packages.service';

/** CTVs (project editors) handle their own packages; managers and evaluators those they oversee. */
const PACKAGE_ACCESS = [
  GO_PERMISSIONS.PROJECT_EDIT,
  GO_PERMISSIONS.ACCEPTANCE_PREPARE,
  GO_PERMISSIONS.PROJECT_EVALUATE,
] as const;
const PACKAGE_CHANGE = [GO_PERMISSIONS.PROJECT_EDIT, GO_PERMISSIONS.ACCEPTANCE_PREPARE] as const;

@ApiTags('packages')
@ApiBearerAuth()
@Controller('packages')
export class PackagesController {
  constructor(
    private readonly service: PackagesService,
    private readonly authContext: AuthContextService,
  ) {}

  @Get()
  @RequireAnyPermissions(...PACKAGE_ACCESS)
  @ApiOperation({
    summary:
      'Danh sách gói (FR-K-07): CTV thấy gói của mình, người phụ trách (go.acceptance.prepare) gói của HĐ mình phụ trách, người nghiệm thu mọi gói. Lọc HĐ, CTV, danh mục, trạng thái, mine, readyForAcceptance',
  })
  list(@Req() request: Request, @Query() query: ListPackagesQueryDto) {
    return this.service.list(query, this.actor(request));
  }

  @Post()
  @RequireAnyPermissions(...PACKAGE_CHANGE)
  @ApiOperation({
    summary:
      'Tạo gói (FR-K-01): CTV tạo cho mình (contractId tuỳ chọn), người phụ trách tạo hộ. Danh mục thuộc HĐ package_tier đang active và tính theo Mức; mã gói tự sinh',
  })
  create(@Req() request: Request, @Body() dto: CreatePackageDto) {
    return this.service.create(dto, this.actor(request));
  }

  @Get(':id')
  @RequireAnyPermissions(...PACKAGE_ACCESS)
  @ApiOperation({
    summary:
      'Chi tiết gói kèm bảng tính tạm (FR-K-03): bối cảnh tính được / không (lý do), source hợp lệ, tỷ lệ ≥ 20s, Mức hiện tại, thành tiền, còn thiếu để lên Mức tiếp theo',
  })
  get(@Req() request: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(id, this.actor(request));
  }

  @Patch(':id')
  @RequireAnyPermissions(...PACKAGE_CHANGE)
  @ApiOperation({ summary: 'Đổi tên gói' })
  update(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePackageDto,
  ) {
    return this.service.update(id, dto, this.actor(request));
  }

  @Get(':id/preview')
  @RequireAnyPermissions(...PACKAGE_ACCESS)
  @ApiOperation({ summary: 'Tính lại và lưu bảng tính tạm của gói' })
  preview(@Req() request: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.preview(id, this.actor(request));
  }

  @Post(':id/projects/:projectId')
  @RequireAnyPermissions(...PACKAGE_CHANGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Thêm dự án vào gói open (FR-K-02): cùng CTV, cùng HĐ, cùng danh mục, chưa thuộc gói khác; dự án chưa gắn HĐ được gắn vào HĐ của gói',
  })
  addProject(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.service.addProject(id, projectId, this.actor(request));
  }

  @Delete(':id/projects/:projectId')
  @RequireAnyPermissions(...PACKAGE_CHANGE)
  @ApiOperation({ summary: 'Bớt dự án khỏi gói open' })
  removeProject(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.service.removeProject(id, projectId, this.actor(request));
  }

  @Post(':id/submit')
  @RequireAnyPermissions(...PACKAGE_CHANGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Gửi nghiệm thu (FR-K-04): 422 PACKAGE_BELOW_TIER_1 ("Gói chưa đạt Mức 1: thiếu N source") khi tính tạm chưa đạt Mức 1; khoá danh sách dự án',
  })
  submit(@Req() request: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.submit(id, this.actor(request));
  }

  @Post(':id/withdraw')
  @RequireAnyPermissions(...PACKAGE_CHANGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rút lại gói đã gửi (submitted → open)' })
  withdraw(@Req() request: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.withdraw(id, this.actor(request));
  }

  @Post(':id/return')
  @RequireAnyPermissions(GO_PERMISSIONS.PROJECT_EVALUATE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Người nghiệm thu trả lại gói kèm lý do (→ open)' })
  returnPackage(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReturnPackageDto,
  ) {
    return this.service.returnPackage(id, dto.reason, this.actor(request));
  }

  @Post(':id/reopen')
  @RequireAnyPermissions(...PACKAGE_CHANGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mở lại gói đã nghiệm thu xong để bổ sung (evaluated → open, FR-K-08)',
  })
  reopen(@Req() request: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.reopen(id, this.actor(request));
  }

  @Post(':id/cancel')
  @RequireAnyPermissions(...PACKAGE_CHANGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Huỷ gói open, trả các dự án ra ngoài' })
  cancel(@Req() request: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.cancel(id, this.actor(request));
  }

  private actor(request: Request) {
    return partnerActor(this.authContext.getContext(request), request);
  }
}
