import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
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
import { CreateProjectDto } from './dto/create-project.dto';
import { ListProjectsQueryDto, ProjectScopeQueryDto } from './dto/list-projects-query.dto';
import { ProjectDto, ProjectOwnerUserDto, ProjectPageDto } from './dto/project-response.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { ProjectsService } from './projects.service';

@ApiTags('projects')
@ApiBearerAuth()
@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly authContext: AuthContextService,
  ) {}

  @Get()
  @RequirePermissions(GO_PERMISSIONS.PROJECT_READ)
  @ApiOkResponse({ type: ProjectPageDto })
  list(@Query() query: ListProjectsQueryDto, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.projectsService.list(query, context.userId, context.userType);
  }

  @Get('owners')
  @RequirePermissions(GO_PERMISSIONS.PROJECT_READ)
  @ApiOperation({ summary: 'Owners (authors) of the projects the user can list' })
  @ApiOkResponse({ type: ProjectOwnerUserDto, isArray: true })
  owners(@Query() query: ProjectScopeQueryDto, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.projectsService.owners(query.scope, context.userId, context.userType);
  }

  @Post()
  @RequirePermissions(GO_PERMISSIONS.PROJECT_EDIT)
  @ApiCreatedResponse({ type: ProjectDto })
  create(@Body() dto: CreateProjectDto, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.projectsService.create(dto, context.userId, context.userType);
  }

  @Get(':id')
  @RequirePermissions(GO_PERMISSIONS.PROJECT_READ)
  @ApiOkResponse({ type: ProjectDto })
  findOne(@Param('id', ParseUUIDPipe) id: string, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.projectsService.findOne(id, context.userId, context.userType);
  }

  @Patch(':id')
  @RequirePermissions(GO_PERMISSIONS.PROJECT_EDIT)
  @ApiOkResponse({ type: ProjectDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProjectDto,
    @Req() request: Request,
  ) {
    const context = this.authContext.getContext(request);
    return this.projectsService.update(id, dto, context.userId, context.userType);
  }

  @Delete(':id')
  @RequirePermissions(GO_PERMISSIONS.PROJECT_EDIT)
  remove(@Param('id', ParseUUIDPipe) id: string, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.projectsService.remove(id, context.userId, context.userType);
  }
}
