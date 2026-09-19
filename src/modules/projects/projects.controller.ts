import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthContextService } from '../../common/auth-context.service';
import { CreateProjectDto } from './dto/create-project.dto';
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
  list(@Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.projectsService.list(context.userId, context.groupIds);
  }

  @Post()
  create(@Body() dto: CreateProjectDto, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.projectsService.create(dto, context.userId, context.groupIds);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.projectsService.findOne(id, context.userId, context.groupIds);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateProjectDto, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.projectsService.update(id, dto, context.userId, context.groupIds);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.projectsService.remove(id, context.userId, context.groupIds);
  }
}
