import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { CategoryEntity } from '../../database/entities/category.entity';
import { ProjectEntity } from '../../database/entities/project.entity';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

@Injectable()
export class CategoriesService {
  constructor(
    @InjectRepository(CategoryEntity)
    private readonly categoryRepository: Repository<CategoryEntity>,
    @InjectRepository(ProjectEntity)
    private readonly projectRepository: Repository<ProjectEntity>,
  ) {}

  list() {
    return this.categoryRepository.find({
      where: { isActive: true },
      order: { sortOrder: 'ASC', name: 'ASC' },
    });
  }

  async create(dto: CreateCategoryDto) {
    await this.assertUnique(dto.name, dto.slug);
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

  async update(id: string, dto: UpdateCategoryDto) {
    const category = await this.findOrFail(id);
    const name = dto.name?.trim() ?? category.name;
    const slug = dto.slug?.trim().toLowerCase() ?? category.slug;
    await this.assertUnique(name, slug, id);
    category.name = name;
    category.slug = slug;
    if (dto.description !== undefined) {
      category.description = dto.description?.trim() || null;
    }
    if (dto.sortOrder !== undefined) {
      category.sortOrder = dto.sortOrder;
    }
    return this.categoryRepository.save(category);
  }

  async remove(id: string): Promise<void> {
    const category = await this.findOrFail(id);
    const projectCount = await this.projectRepository.count({ where: { categoryId: id } });
    if (projectCount > 0) {
      throw new ConflictException(
        `Category is used by ${projectCount} project(s) and cannot be deleted`,
      );
    }
    await this.categoryRepository.remove(category);
  }

  private async findOrFail(id: string) {
    const category = await this.categoryRepository.findOne({ where: { id, isActive: true } });
    if (!category) {
      throw new NotFoundException('Category not found');
    }
    return category;
  }

  private async assertUnique(name: string, slug: string, excludeId?: string) {
    const query = this.categoryRepository
      .createQueryBuilder('category')
      .where('(LOWER(category.name) = LOWER(:name) OR category.slug = :slug)', {
        name: name.trim(),
        slug: slug.trim().toLowerCase(),
      });
    if (excludeId) {
      query.andWhere('category.id <> :excludeId', { excludeId });
    }
    if (await query.getOne()) {
      throw new ConflictException('Category name or slug already exists');
    }
  }
}
