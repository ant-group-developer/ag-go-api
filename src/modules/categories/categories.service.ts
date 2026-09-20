import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { CategoryEntity } from '../../database/entities/category.entity';
import { CreateCategoryDto } from './dto/create-category.dto';

@Injectable()
export class CategoriesService {
  constructor(
    @InjectRepository(CategoryEntity)
    private readonly categoryRepository: Repository<CategoryEntity>,
  ) {}

  list() {
    return this.categoryRepository.find({
      where: { isActive: true },
      order: { sortOrder: 'ASC', name: 'ASC' },
    });
  }

  async create(dto: CreateCategoryDto) {
    const duplicate = await this.categoryRepository
      .createQueryBuilder('category')
      .where('LOWER(category.name) = LOWER(:name) OR category.slug = :slug', dto)
      .getOne();
    if (duplicate) {
      throw new ConflictException('Category name or slug already exists');
    }
    return this.categoryRepository.save(
      this.categoryRepository.create({
        id: uuidv7(),
        name: dto.name.trim(),
        slug: dto.slug.trim().toLowerCase(),
        description: dto.description ?? null,
        sortOrder: dto.sortOrder ?? 0,
      }),
    );
  }
}
