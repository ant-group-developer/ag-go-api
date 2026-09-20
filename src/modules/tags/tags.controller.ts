import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthContextService } from '../../common/auth-context.service';
import { CreateTagDto } from './dto/create-tag.dto';
import { TagsService } from './tags.service';

@ApiTags('tags')
@ApiBearerAuth()
@Controller('tags')
export class TagsController {
  constructor(
    private readonly tagsService: TagsService,
    private readonly authContext: AuthContextService,
  ) {}

  @Get()
  list() {
    return this.tagsService.list();
  }

  @Post()
  create(@Body() dto: CreateTagDto, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.tagsService.create(dto, context.userId);
  }
}
