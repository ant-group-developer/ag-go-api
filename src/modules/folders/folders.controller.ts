import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseArrayPipe,
  Patch,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthContextService } from '../../common/auth-context.service';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { RequirePermissions } from '../../common/auth/permissions.decorator';
import { CreateFolderDto } from './dto/create-folder.dto';
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
  tree(@Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.foldersService.tree(context.userId, context.userType);
  }

  @Post()
  @RequirePermissions(GO_PERMISSIONS.FOLDER_MANAGE)
  create(@Body() dto: CreateFolderDto, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.foldersService.create(dto, context.userId, context.userType);
  }

  @Patch(':id')
  @RequirePermissions(GO_PERMISSIONS.FOLDER_MANAGE)
  update(@Param('id') id: string, @Body() dto: UpdateFolderDto, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.foldersService.update(id, dto, context.userId, context.userType);
  }

  @Delete(':id')
  @RequirePermissions(GO_PERMISSIONS.FOLDER_MANAGE)
  async remove(@Param('id') id: string, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    await this.foldersService.remove(id, context.userId, context.userType);
    return { success: true };
  }

  @Get(':id/access-grants')
  @RequirePermissions(GO_PERMISSIONS.FOLDER_MANAGE)
  grants(@Param('id') id: string, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.foldersService.grants(id, context.userId, context.userType);
  }

  @Put(':id/access-grants')
  @RequirePermissions(GO_PERMISSIONS.FOLDER_MANAGE)
  replaceGrants(
    @Param('id') id: string,
    @Body(new ParseArrayPipe({ items: UpsertFolderGrantDto })) entries: UpsertFolderGrantDto[],
    @Req() request: Request,
  ) {
    const context = this.authContext.getContext(request);
    return this.foldersService.replaceGrants(id, entries, context.userId, context.userType);
  }

  @Put(':id/access-grants/:principalId')
  @RequirePermissions(GO_PERMISSIONS.FOLDER_MANAGE)
  setGrant(
    @Param('id') id: string,
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
    @Param('id') id: string,
    @Param('principalId') principalId: string,
    @Req() request: Request,
  ) {
    const context = this.authContext.getContext(request);
    await this.foldersService.removeGrant(id, principalId, context.userId, context.userType);
    return { success: true };
  }
}
