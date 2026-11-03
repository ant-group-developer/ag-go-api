import {
  Body,
  Controller,
  Get,
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
import { RequirePermissions } from '../../common/auth/permissions.decorator';
import {
  CreatePartnerDto,
  ListPartnersQueryDto,
  PartnerProfileQueryDto,
  UpdatePartnerDto,
} from './dto/partner.dto';
import { SearchPartnerCandidatesDto } from './dto/search-partner-candidates.dto';
import { UpdatePartnerProfileDto } from './dto/update-partner-profile.dto';
import { partnerActor } from './partner-actor';
import { PartnersService } from './partners.service';

const MANAGER_FIELD = [{ id: 'managerUserId' as const, target: 'managerUser' }];

@ApiTags('partners')
@ApiBearerAuth()
@Controller('partners')
export class PartnersController {
  constructor(
    private readonly partnersService: PartnersService,
    private readonly authContext: AuthContextService,
    private readonly actorEnrichment: ActorEnrichmentService,
  ) {}

  @Get()
  @RequirePermissions(GO_PERMISSIONS.PARTNER_READ)
  @ApiOperation({
    summary:
      'Danh sách đối tác (không có thông tin cá nhân). Người không có go.partner.read_all chỉ thấy đối tác mình phụ trách.',
  })
  async list(@Req() request: Request, @Query() query: ListPartnersQueryDto) {
    const result = await this.partnersService.list(query, this.actor(request));
    result.items = (await this.actorEnrichment.enrich(
      result.items as unknown as Array<Record<string, unknown>>,
      MANAGER_FIELD,
    )) as unknown as typeof result.items;
    return result;
  }

  @Get('account-users')
  @RequirePermissions(GO_PERMISSIONS.PARTNER_MANAGE)
  @ApiOperation({
    summary:
      'Tìm user AG Account thuộc ứng dụng AG Go để thêm làm đối tác (id, tên, email, goUserId, partnerId nếu đã là đối tác)',
  })
  searchCandidates(@Query() query: SearchPartnerCandidatesDto) {
    return this.partnersService.searchCandidates(query);
  }

  @Post()
  @RequirePermissions(GO_PERMISSIONS.PARTNER_MANAGE)
  @ApiOperation({ summary: 'Thêm đối tác từ một user AG Go (FR-P-01)' })
  create(@Req() request: Request, @Body() dto: CreatePartnerDto) {
    return this.partnersService.create(dto, this.actor(request));
  }

  @Get(':id')
  @RequirePermissions(GO_PERMISSIONS.PARTNER_READ)
  @ApiOperation({
    summary:
      'Đối tác (bản ghi AG Go, trạng thái hồ sơ lần kiểm gần nhất). Hồ sơ AG Account: GET /partners/:id/profile',
  })
  async get(@Req() request: Request, @Param('id', ParseUUIDPipe) id: string) {
    const partner = await this.partnersService.get(id, this.actor(request));
    const [enriched] = await this.actorEnrichment.enrich(
      [partner as unknown as Record<string, unknown>],
      MANAGER_FIELD,
    );
    return enriched;
  }

  @Patch(':id')
  @RequirePermissions(GO_PERMISSIONS.PARTNER_MANAGE)
  @ApiOperation({ summary: 'Sửa mã, người phụ trách, trạng thái, ghi chú' })
  update(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePartnerDto,
  ) {
    return this.partnersService.update(id, dto, this.actor(request));
  }

  @Get(':id/profile')
  @RequirePermissions(GO_PERMISSIONS.PARTNER_READ)
  @ApiOperation({
    summary:
      'Hồ sơ hợp đồng từ AG Account: đã che, hoặc đầy đủ với ?reveal=pii (cần go.partner.pii_read). Mỗi lần xem ghi audit PARTNER_PROFILE_VIEWED.',
  })
  getProfile(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: PartnerProfileQueryDto,
  ) {
    return this.partnersService.getProfile(id, query.reveal === 'pii', this.actor(request));
  }

  @Patch(':id/profile')
  @RequirePermissions(GO_PERMISSIONS.PARTNER_MANAGE)
  @ApiOperation({
    summary:
      'Sửa một phần hồ sơ ở AG Account (PATCH + If-Match = version). 409 CONTRACT_PROFILE_VERSION_CONFLICT khi hồ sơ đã đổi: tải lại.',
  })
  updateProfile(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePartnerProfileDto,
  ) {
    return this.partnersService.updateProfile(id, dto, this.actor(request));
  }

  private actor(request: Request) {
    return partnerActor(this.authContext.getContext(request), request);
  }
}
