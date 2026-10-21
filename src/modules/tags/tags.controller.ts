import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ActorEnrichmentService } from '../../common/actor-enrichment.service';
import { AuthContextService } from '../../common/auth-context.service';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { RequirePermissions } from '../../common/auth/permissions.decorator';
import { CreateTagDto } from './dto/create-tag.dto';
import { TagDto } from './dto/tag-response.dto';
import { UpdateTagDto } from './dto/update-tag.dto';
import { TagsService } from './tags.service';

@ApiTags('tags')
@ApiBearerAuth()
@Controller('tags')
export class TagsController {
  constructor(
    private readonly tagsService: TagsService,
    private readonly authContext: AuthContextService,
    private readonly actorEnrichment: ActorEnrichmentService,
  ) {}

  /** Each tag with its creator as `createdByUser` (null when unknown). */
  @Get()
  @ApiOkResponse({ type: TagDto, isArray: true })
  async list() {
    const tags = await this.tagsService.list();
    return this.actorEnrichment.enrich(tags as unknown as Array<Record<string, unknown>>, [
      { id: 'createdBy', target: 'createdByUser' },
    ]);
  }

  @Post()
  @RequirePermissions(GO_PERMISSIONS.TAG_CREATE)
  @ApiCreatedResponse({ type: TagDto })
  create(@Body() dto: CreateTagDto, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.tagsService.create(dto, context.userId);
  }

  @Patch(':id')
  @RequirePermissions(GO_PERMISSIONS.TAG_EDIT)
  @ApiOkResponse({ type: TagDto })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTagDto) {
    return this.tagsService.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions(GO_PERMISSIONS.TAG_DELETE)
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.tagsService.remove(id);
    return { success: true };
  }
}
