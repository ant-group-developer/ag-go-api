import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { ListResponseDto } from '../../common/dto/list-response.dto';
import { CountryEntity } from '../../database/entities/country.entity';
import { ProvinceEntity } from '../../database/entities/province.entity';
import { CreateProvinceDto } from './dto/create-province.dto';
import { ListProvincesQueryDto } from './dto/list-provinces-query.dto';

@Injectable()
export class ProvincesService {
  constructor(
    @InjectRepository(CountryEntity)
    private readonly countryRepository: Repository<CountryEntity>,
    @InjectRepository(ProvinceEntity)
    private readonly provinceRepository: Repository<ProvinceEntity>,
  ) {}

  async list(query: ListProvincesQueryDto) {
    const page = query.page;
    const pageSize = query.pageSize;
    const builder = this.provinceRepository
      .createQueryBuilder('province')
      .leftJoinAndSelect('province.country', 'country')
      .where('province.is_active = :isActive', { isActive: true });

    if (query.countryId) {
      builder.andWhere('province.country_id = :countryId', { countryId: query.countryId });
    }
    const keyword = query.normalizedKeyword ?? query.search?.trim() ?? undefined;
    if (keyword) {
      const search = `%${keyword.toLowerCase()}%`;
      builder.andWhere(
        "(LOWER(province.name) LIKE :search OR LOWER(COALESCE(province.code, '')) LIKE :search OR LOWER(country.name) LIKE :search OR LOWER(COALESCE(country.code, '')) LIKE :search)",
        { search },
      );
    }

    const [items, total] = await builder
      .orderBy('country.name', 'ASC')
      .addOrderBy('province.sort_order', 'ASC')
      .addOrderBy('province.name', 'ASC')
      .skip(query.skip)
      .take(pageSize)
      .getManyAndCount();

    return new ListResponseDto(items, page, pageSize, total);
  }

  async create(dto: CreateProvinceDto) {
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
}
