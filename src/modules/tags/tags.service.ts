import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { TagEntity } from '../../database/entities/tag.entity';
import { CreateTagDto } from './dto/create-tag.dto';

@Injectable()
export class TagsService {
  constructor(
    @InjectRepository(TagEntity)
    private readonly tagRepository: Repository<TagEntity>,
  ) {}

  list() {
    return this.tagRepository.find({ order: { normalizedName: 'ASC' } });
  }

  async create(dto: CreateTagDto, userId: string) {
    const normalizedName = dto.name.trim().toLocaleLowerCase('vi-VN');
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
}
