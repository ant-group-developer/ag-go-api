import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthContextService } from '../../common/auth-context.service';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { RequirePermissions } from '../../common/auth/permissions.decorator';
import { CreateFolderDto } from './dto/create-folder.dto';
import { UpdateFolderDto } from './dto/update-folder.dto';
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

  @Get('options')
  @RequirePermissions(GO_PERMISSIONS.PROJECT_READ)
  @ApiOperation({
    summary:
      'Every active folder, to filter the "Projects" page (it lists every evaluated project)',
  })
  options() {
    return this.foldersService.options();
  }

  @Post()
  @RequirePermissions(GO_PERMISSIONS.FOLDER_MANAGE)
  create(@Body() dto: CreateFolderDto, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.foldersService.create(dto, context.userId, context.userType, context.permissions);
  }

  @Patch(':id')
  @RequirePermissions(GO_PERMISSIONS.FOLDER_MANAGE)
  update(@Param('id') id: string, @Body() dto: UpdateFolderDto, @Req() request: Request) {
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
  async remove(@Param('id') id: string, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    await this.foldersService.remove(id, context.userId, context.userType);
    return { success: true };
  }
}
