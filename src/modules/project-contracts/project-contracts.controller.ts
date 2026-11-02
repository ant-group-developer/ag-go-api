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
import { AuthContextService } from '../../common/auth-context.service';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { RequireAnyPermissions, RequirePermissions } from '../../common/auth/permissions.decorator';
import { partnerActor } from '../partners/partner-actor';
import {
  ListContractProjectsQueryDto,
  ListPartnerProjectsQueryDto,
  UpdateProjectContractDto,
} from './dto/project-contract.dto';
import { ProjectContractsService } from './project-contracts.service';

@ApiTags('project-contracts')
@ApiBearerAuth()
@Controller()
export class ProjectContractsController {
  constructor(
    private readonly service: ProjectContractsService,
    private readonly authContext: AuthContextService,
  ) {}

  @Get('projects/:id/contract')
  @RequirePermissions(GO_PERMISSIONS.PROJECT_READ, GO_PERMISSIONS.CONTRACT_READ)
  @ApiOperation({
    summary:
      'HĐ đã gắn, thời điểm giao, "nghiệm thu ngoài hệ thống" và các HĐ hiệu lực của đối tác sở hữu để chọn (FR-P-09)',
  })
  getLink(@Req() request: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.getLink(id, this.actor(request));
  }

  @Patch('projects/:id/contract')
  @RequirePermissions(GO_PERMISSIONS.PROJECT_EDIT, GO_PERMISSIONS.CONTRACT_READ)
  @ApiOperation({
    summary:
      'Gắn / bỏ gắn HĐ (chỉ HĐ active của đúng đối tác, FR-C-08); sửa deliveredAt, đánh dấu nghiệm thu ngoài hệ thống (cần go.contract.manage). Gắn mới thì xếp phân tích còn thiếu và chạy kiểm tra kỹ thuật.',
  })
  update(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProjectContractDto,
  ) {
    return this.service.update(id, dto, this.actor(request));
  }

  @Get('projects/:id/spec-checks')
  @RequirePermissions(GO_PERMISSIONS.PROJECT_READ)
  @ApiOperation({
    summary:
      'Kết quả kiểm tra kỹ thuật theo tech spec của HĐ tại ngày giao: từng video (pass/warn/fail/unknown kèm lý do) và tổng hợp project (FR-T-02, FR-T-03). Chỉ là gợi ý cho người nghiệm thu.',
  })
  specChecks(@Req() request: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.getSpecChecks(id, this.actor(request));
  }

  @Post('projects/:id/spec-checks/recheck')
  @RequirePermissions(GO_PERMISSIONS.PROJECT_READ)
  @RequireAnyPermissions(GO_PERMISSIONS.PROJECT_EVALUATE, GO_PERMISSIONS.CONTRACT_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Xếp phân tích còn thiếu rồi kiểm tra lại mọi video của project (FR-T-05)',
  })
  recheck(@Req() request: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.recheck(id, this.actor(request));
  }

  @Get('partners/:id/projects')
  @RequirePermissions(GO_PERMISSIONS.PARTNER_READ, GO_PERMISSIONS.CONTRACT_READ)
  @ApiOperation({
    summary:
      'Project của đối tác (owner = go_user_id), lọc đã / chưa gắn HĐ, đã giao; kèm số kết quả kiểm tra',
  })
  partnerProjects(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListPartnerProjectsQueryDto,
  ) {
    return this.service.listPartnerProjects(id, query, this.actor(request));
  }

  @Get('contracts/:id/projects')
  @RequirePermissions(GO_PERMISSIONS.CONTRACT_READ)
  @ApiOperation({ summary: 'Project đã gắn vào HĐ, mới giao trước; kèm số kết quả kiểm tra' })
  contractProjects(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListContractProjectsQueryDto,
  ) {
    return this.service.listContractProjects(id, query, this.actor(request));
  }

  private actor(request: Request) {
    return partnerActor(this.authContext.getContext(request), request);
  }
}
