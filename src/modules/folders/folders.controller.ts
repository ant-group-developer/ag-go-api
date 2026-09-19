import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthContextService } from '../../common/auth-context.service';
import { CreateFolderDto } from './dto/create-folder.dto';
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
  tree(@Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.foldersService.tree(context.userId, context.groupIds);
  }

  @Post()
  create(@Body() dto: CreateFolderDto, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.foldersService.create(dto, context.userId, context.groupIds);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateFolderDto, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.foldersService.update(id, dto, context.userId, context.groupIds);
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    await this.foldersService.remove(id, context.userId, context.groupIds);
    return { success: true };
  }

  @Get(':id/access-grants')
  grants(@Param('id') id: string, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.foldersService.grants(id, context.userId, context.groupIds);
  }

  @Put(':id/access-grants')
  replaceGrants(
    @Param('id') id: string,
    @Body() entries: UpsertFolderGrantDto[],
    @Req() request: Request,
  ) {
    const context = this.authContext.getContext(request);
    return this.foldersService.replaceGrants(id, entries, context.userId, context.groupIds);
  }
}
