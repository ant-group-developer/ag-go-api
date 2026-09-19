import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { CategoryEntity } from '../../database/entities/category.entity';
import { CountryEntity } from '../../database/entities/country.entity';
import { ProvinceEntity } from '../../database/entities/province.entity';
import { TagEntity } from '../../database/entities/tag.entity';
import {
  CreateCategoryDto,
  CreateCountryDto,
  CreateProvinceDto,
  CreateTagDto,
} from './dto/create-catalog.dto';

@Injectable()
export class CatalogsService {
  constructor(
    @InjectRepository(CategoryEntity)
    private readonly categoryRepository: Repository<CategoryEntity>,
    @InjectRepository(CountryEntity)
    private readonly countryRepository: Repository<CountryEntity>,
    @InjectRepository(ProvinceEntity)
    private readonly provinceRepository: Repository<ProvinceEntity>,
    @InjectRepository(TagEntity)
    private readonly tagRepository: Repository<TagEntity>,
  ) {}

  listCategories() {
    return this.categoryRepository.find({
      where: { isActive: true },
      order: { sortOrder: 'ASC', name: 'ASC' },
    });
  }

  async createCategory(dto: CreateCategoryDto) {
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

  listCountries() {
    return this.countryRepository.find({
      where: { isActive: true },
      order: { sortOrder: 'ASC', name: 'ASC' },
    });
  }

  async createCountry(dto: CreateCountryDto) {
    const duplicate = await this.countryRepository
      .createQueryBuilder('country')
      .where('LOWER(country.name) = LOWER(:name)', { name: dto.name })
      .getOne();
    if (duplicate) {
      throw new ConflictException('Country name already exists');
    }
    return this.countryRepository.save(
      this.countryRepository.create({
        id: uuidv7(),
        code: dto.code?.trim() ?? null,
        name: dto.name.trim(),
      }),
    );
  }

  listProvinces(countryId?: string) {
    return this.provinceRepository.find({
      where: countryId ? { countryId, isActive: true } : { isActive: true },
      order: { sortOrder: 'ASC', name: 'ASC' },
    });
  }

  async createProvince(dto: CreateProvinceDto) {
    const country = await this.countryRepository.findOne({
      where: { id: dto.countryId, isActive: true },
    });
    if (!country) {
      throw new NotFoundException('Country not found');
    }
    return this.provinceRepository.save(
      this.provinceRepository.create({
        id: uuidv7(),
        countryId: dto.countryId,
        code: dto.code?.trim() ?? null,
        name: dto.name.trim(),
      }),
    );
  }

  listTags() {
    return this.tagRepository.find({ order: { normalizedName: 'ASC' } });
  }

  async createTag(dto: CreateTagDto, userId: string) {
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
