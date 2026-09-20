import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { CountryEntity } from '../../database/entities/country.entity';
import { CreateCountryDto } from './dto/create-country.dto';

@Injectable()
export class CountriesService {
  constructor(
    @InjectRepository(CountryEntity)
    private readonly countryRepository: Repository<CountryEntity>,
  ) {}

  list() {
    return this.countryRepository.find({
      where: { isActive: true },
      order: { sortOrder: 'ASC', name: 'ASC' },
    });
  }

  async create(dto: CreateCountryDto) {
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
        flagUrl: dto.flagUrl?.trim() ?? null,
      }),
    );
  }
}
