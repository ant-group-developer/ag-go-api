import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseArrayPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthContextService } from '../../common/auth-context.service';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { RequirePermissions } from '../../common/auth/permissions.decorator';
import { CreateFolderDto } from './dto/create-folder.dto';
import { FolderDto, FolderOptionDto } from './dto/folder-response.dto';
import { SetFolderGrantDto } from './dto/set-folder-grant.dto';
import { UpdateFolderDto } from './dto/update-folder.dto';
import { UpsertFolderGrantDto } from './dto/upsert-folder-grant.dto';
import { FoldersService } from './folders.service';

@ApiTags('folders')
@ApiBearerAuth()
@Controller('folders')
export class FoldersController {
  constructor(
    private readonly foldersService: FoldersService,
    private readonly authContext: AuthContextService,
  ) {}

  @Get('tree')
  @RequirePermissions(GO_PERMISSIONS.PROJECT_READ)
  @ApiOkResponse({ type: FolderDto, isArray: true })
  tree(@Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.foldersService.tree(context.userId, context.userType);
  }

  @Get('options')
  @RequirePermissions(GO_PERMISSIONS.PROJECT_READ)
  @ApiOperation({
    summary: 'Every active folder, to filter the "Projects" page (listed by category grants)',
  })
  @ApiOkResponse({ type: FolderOptionDto, isArray: true })
  options() {
    return this.foldersService.options();
  }

  @Post()
  @RequirePermissions(GO_PERMISSIONS.FOLDER_MANAGE)
  @ApiCreatedResponse({ type: FolderDto })
  create(@Body() dto: CreateFolderDto, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.foldersService.create(dto, context.userId, context.userType, context.permissions);
  }

  @Patch(':id')
  @RequirePermissions(GO_PERMISSIONS.FOLDER_MANAGE)
  @ApiOkResponse({ type: FolderDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFolderDto,
    @Req() request: Request,
  ) {
    const context = this.authContext.getContext(request);
    return this.foldersService.update(
      id,
      dto,
      context.userId,
      context.userType,
      context.permissions,
    );
  }

  @Delete(':id')
  @RequirePermissions(GO_PERMISSIONS.FOLDER_MANAGE)
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    await this.foldersService.remove(id, context.userId, context.userType);
    return { success: true };
  }

  @Get(':id/access-grants')
  @RequirePermissions(GO_PERMISSIONS.FOLDER_MANAGE)
  grants(@Param('id', ParseUUIDPipe) id: string, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.foldersService.grants(id, context.userId, context.userType);
  }

  @Put(':id/access-grants')
  @RequirePermissions(GO_PERMISSIONS.FOLDER_MANAGE)
  replaceGrants(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ParseArrayPipe({ items: UpsertFolderGrantDto })) entries: UpsertFolderGrantDto[],
    @Req() request: Request,
  ) {
    const context = this.authContext.getContext(request);
    return this.foldersService.replaceGrants(id, entries, context.userId, context.userType);
  }

  @Put(':id/access-grants/:principalId')
  @RequirePermissions(GO_PERMISSIONS.FOLDER_MANAGE)
  setGrant(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('principalId') principalId: string,
    @Body() dto: SetFolderGrantDto,
    @Req() request: Request,
  ) {
    const context = this.authContext.getContext(request);
    return this.foldersService.setGrant(id, principalId, dto, context.userId, context.userType);
  }

  @Delete(':id/access-grants/:principalId')
  @RequirePermissions(GO_PERMISSIONS.FOLDER_MANAGE)
  async removeGrant(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('principalId') principalId: string,
    @Req() request: Request,
  ) {
    const context = this.authContext.getContext(request);
    await this.foldersService.removeGrant(id, principalId, context.userId, context.userType);
    return { success: true };
  }
}
