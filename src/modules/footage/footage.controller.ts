import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthContextService } from '../../common/auth-context.service';
import { AllowServiceKey } from '../../common/auth/allow-service-key.decorator';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { RequirePermissions } from '../../common/auth/permissions.decorator';
import { FootageCatalogBodyDto } from './dto/catalog-query.dto';
import { ResolveAssetsDto } from './dto/resolve-assets.dto';
import { FootagePreviewUrlQueryDto, FootageSearchQueryDto } from './dto/search-query.dto';
import { FootageService } from './footage.service';

@ApiTags('footage')
@ApiBearerAuth()
@Controller('footage')
export class FootageController {
  constructor(
    private readonly footageService: FootageService,
    private readonly authContext: AuthContextService,
  ) {}

  // ---------------------------------------------------------------------------
  // GET /footage/folders
  // ---------------------------------------------------------------------------

  @Get('folders')
  @RequirePermissions(GO_PERMISSIONS.FOOTAGE_SEARCH)
  @AllowServiceKey('footage:read')
  @ApiSecurity('service-key')
  @ApiOperation({ summary: 'List accessible folders with analysed video counts' })
  getFolders(@Req() req: Request) {
    const ctx = this.authContext.getContext(req);
    return this.footageService.getFolders(ctx.userId, ctx.userType);
  }

  // ---------------------------------------------------------------------------
  // POST /footage/catalog
  // ---------------------------------------------------------------------------

  @Post('catalog')
  @RequirePermissions(GO_PERMISSIONS.FOOTAGE_SEARCH)
  @AllowServiceKey('footage:read')
  @ApiSecurity('service-key')
  @ApiOperation({
    summary: 'Analysed videos of the given folders with their descriptions (AI input)',
  })
  getCatalog(@Body() dto: FootageCatalogBodyDto, @Req() req: Request) {
    const ctx = this.authContext.getContext(req);
    return this.footageService.getCatalog(dto, ctx.userId, ctx.userType);
  }

  // ---------------------------------------------------------------------------
  // GET /footage/assets/:assetId/media
  // ---------------------------------------------------------------------------

  @Get('assets/:assetId/media')
  @RequirePermissions(GO_PERMISSIONS.FOOTAGE_SEARCH)
  @AllowServiceKey('footage:read')
  @ApiSecurity('service-key')
  @ApiOperation({ summary: 'Preview URL of the whole video, keyframes and contact sheet' })
  getAssetMedia(@Param('assetId', ParseUUIDPipe) assetId: string, @Req() req: Request) {
    const ctx = this.authContext.getContext(req);
    return this.footageService.getAssetMedia(assetId, ctx.userId, ctx.userType);
  }

  // ---------------------------------------------------------------------------
  // GET /footage/assets/:assetId/preview-url
  // ---------------------------------------------------------------------------

  @Get('assets/:assetId/preview-url')
  @RequirePermissions(GO_PERMISSIONS.FOOTAGE_SEARCH)
  @AllowServiceKey('footage:read')
  @ApiSecurity('service-key')
  @ApiOperation({ summary: 'Presigned URL of one preview offered by the footage player' })
  getPreviewUrl(
    @Param('assetId', ParseUUIDPipe) assetId: string,
    @Query() query: FootagePreviewUrlQueryDto,
    @Req() req: Request,
  ) {
    const ctx = this.authContext.getContext(req);
    return this.footageService.getPreviewUrl(assetId, query.variantCode, ctx.userId, ctx.userType);
  }

  // ---------------------------------------------------------------------------
  // POST /footage/assets/resolve
  // ---------------------------------------------------------------------------

  @Post('assets/resolve')
  @RequirePermissions(GO_PERMISSIONS.FOOTAGE_PRODUCE)
  @AllowServiceKey('footage:resolve')
  @ApiSecurity('service-key')
  @ApiOperation({ summary: 'Signed URLs of whole video files for rendering (respects decision 8)' })
  resolveAssets(@Body() dto: ResolveAssetsDto, @Req() req: Request) {
    const ctx = this.authContext.getContext(req);
    return this.footageService.resolveAssets(
      dto.assetIds,
      dto.purpose,
      ctx.userId,
      ctx.userType,
      ctx.permissions,
      (req as Request & { requestId?: string }).requestId,
    );
  }

  // ---------------------------------------------------------------------------
  // GET /footage/search
  // ---------------------------------------------------------------------------

  @Get('search')
  @RequirePermissions(GO_PERMISSIONS.FOOTAGE_SEARCH)
  @AllowServiceKey('footage:read')
  @ApiSecurity('service-key')
  @ApiOperation({ summary: 'Full-text + trigram search across analysed videos' })
  search(@Query() query: FootageSearchQueryDto, @Req() req: Request) {
    const ctx = this.authContext.getContext(req);
    return this.footageService.search(query, ctx.userId, ctx.userType);
  }

  // ---------------------------------------------------------------------------
  // GET /footage/facets
  // ---------------------------------------------------------------------------

  @Get('facets')
  @RequirePermissions(GO_PERMISSIONS.FOOTAGE_SEARCH)
  @AllowServiceKey('footage:read')
  @ApiSecurity('service-key')
  @ApiOperation({ summary: 'Facet counts for search filters' })
  getFacets(@Query() query: FootageSearchQueryDto, @Req() req: Request) {
    const ctx = this.authContext.getContext(req);
    // Strip paging params for facets
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { limit: _l, cursor: _c, page: _p, sortBy: _sb, sortOrder: _so, ...facetQuery } = query;
    return this.footageService.getFacets(facetQuery, ctx.userId, ctx.userType);
  }
}
