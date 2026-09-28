import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { TagEntity } from '../../database/entities/tag.entity';
import { CreateTagDto } from './dto/create-tag.dto';
import { UpdateTagDto } from './dto/update-tag.dto';

@Injectable()
export class TagsService {
  constructor(
    @InjectRepository(TagEntity)
    private readonly tagRepository: Repository<TagEntity>,
  ) {}

  list() {
    return this.tagRepository
      .createQueryBuilder('tag')
      .addSelect('tag.normalizedName COLLATE natural_sort', 'name_sort')
      .orderBy('name_sort', 'ASC')
      .getMany();
  }

  async create(dto: CreateTagDto, userId: string) {
    const normalizedName = this.normalizeName(dto.name);
    const duplicate = await this.tagRepository.findOne({ where: { normalizedName } });
    if (duplicate) {
      return duplicate;
    }
    return this.tagRepository.save(
      this.tagRepository.create({
        id: uuidv7(),
        name: dto.name.trim(),
        normalizedName,
        createdBy: userId,
      }),
    );
  }

  async update(id: string, dto: UpdateTagDto) {
    const tag = await this.findOrFail(id);
    const normalizedName = this.normalizeName(dto.name);
    const duplicate = await this.tagRepository.findOne({
      where: { normalizedName, id: Not(id) },
    });
    if (duplicate) {
      throw new ConflictException('Tag name already exists');
    }
    tag.name = dto.name.trim();
    tag.normalizedName = normalizedName;
    return this.tagRepository.save(tag);
  }

  async remove(id: string): Promise<void> {
    const tag = await this.findOrFail(id);
    const [{ count }] = await this.tagRepository.query<Array<{ count: number }>>(
      'SELECT COUNT(*)::int AS count FROM project_tags WHERE tag_id = $1',
      [id],
    );
    if (count > 0) {
      throw new ConflictException(`Tag is used by ${count} project(s) and cannot be deleted`);
    }
    await this.tagRepository.remove(tag);
  }

  private async findOrFail(id: string) {
    const tag = await this.tagRepository.findOne({ where: { id } });
    if (!tag) {
      throw new NotFoundException('Tag not found');
    }
    return tag;
  }

  private normalizeName(name: string) {
    return name.trim().toLocaleLowerCase('vi-VN');
  }
}
