import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import {
  type CsvImportError,
  type CsvImportResult,
  type CsvUploadFile,
  failedImportResult,
  parseCsvUpload,
  successfulImportResult,
  toErrorValue,
} from '../../common/csv/csv-import';
import { ListResponseDto } from '../../common/dto/list-response.dto';
import { CountryEntity } from '../../database/entities/country.entity';
import { ProvinceEntity } from '../../database/entities/province.entity';
import { CreateProvinceDto } from './dto/create-province.dto';
import { ListProvincesQueryDto } from './dto/list-provinces-query.dto';

const PROVINCE_HEADERS = ['Country code', 'Tên', 'Code'] as const;

type ProvinceImportRow = {
  row: number;
  countryCode: string;
  name: string;
  code: string | null;
};

type ResolvedProvinceImportRow = ProvinceImportRow & {
  countryId: string;
};

@Injectable()
export class ProvincesService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
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
      .addSelect('country.name COLLATE natural_sort', 'country_name_sort')
      .addSelect('province.name COLLATE natural_sort', 'province_name_sort')
      .orderBy('country_name_sort', 'ASC')
      .addOrderBy('province.sort_order', 'ASC')
      .addOrderBy('province_name_sort', 'ASC')
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

  async importCsv(file?: CsvUploadFile): Promise<CsvImportResult> {
    const parsed = parseCsvUpload(file, PROVINCE_HEADERS);
    if (parsed.errors.length > 0) {
      return failedImportResult(0, parsed.errors);
    }

    const rows: ProvinceImportRow[] = parsed.rows.map(({ row, values }) => ({
      row,
      countryCode: values['Country code'].trim().toUpperCase(),
      name: values['Tên'].trim().normalize('NFC'),
      code: values.Code.trim() ? values.Code.trim().normalize('NFC') : null,
    }));
    const errors = this.validateImportRows(rows);
    if (errors.length > 0) {
      return failedImportResult(rows.length, errors);
    }

    try {
      return await this.dataSource.transaction(async (manager) => {
        const countryCodes = [...new Set(rows.map((row) => row.countryCode))];
        const countries = await manager
          .createQueryBuilder(CountryEntity, 'country')
          .where('country.is_active = :isActive', { isActive: true })
          .andWhere('UPPER(BTRIM(country.code)) IN (:...countryCodes)', { countryCodes })
          .getMany();
        const countriesByCode = new Map<string, CountryEntity[]>();
        for (const country of countries) {
          if (!country.code) {
            continue;
          }
          const code = country.code.trim().toUpperCase();
          countriesByCode.set(code, [...(countriesByCode.get(code) ?? []), country]);
        }

        const countryErrors: CsvImportError[] = [];
        const resolvedRows: ResolvedProvinceImportRow[] = [];
        for (const row of rows) {
          const matches = countriesByCode.get(row.countryCode) ?? [];
          if (matches.length === 0) {
            countryErrors.push({
              row: row.row,
              field: 'Country code',
              value: toErrorValue(row.countryCode),
              reason: 'Không tìm thấy Country đang hoạt động với code này.',
            });
          } else if (matches.length > 1) {
            countryErrors.push({
              row: row.row,
              field: 'Country code',
              value: toErrorValue(row.countryCode),
              reason: 'Country code không duy nhất trong database.',
            });
          } else {
            resolvedRows.push({ ...row, countryId: matches[0].id });
          }
        }
        if (countryErrors.length > 0) {
          return failedImportResult(rows.length, countryErrors);
        }

        const countryIds = [...new Set(resolvedRows.map((row) => row.countryId))];
        const names = [...new Set(resolvedRows.map((row) => this.normalizeName(row.name)))];
        const existing = await manager
          .createQueryBuilder(ProvinceEntity, 'province')
          .where('province.country_id IN (:...countryIds)', { countryIds })
          .andWhere('LOWER(province.name) IN (:...names)', { names })
          .getMany();
        const existingKeys = new Set(
          existing.map(
            (province) => `${province.countryId}\u0000${this.normalizeName(province.name)}`,
          ),
        );
        const duplicateErrors = resolvedRows.flatMap((row): CsvImportError[] => {
          const key = `${row.countryId}\u0000${this.normalizeName(row.name)}`;
          return existingKeys.has(key)
            ? [
                {
                  row: row.row,
                  field: 'Tên',
                  value: toErrorValue(row.name),
                  reason: 'Province đã tồn tại trong Country này.',
                },
              ]
            : [];
        });
        if (duplicateErrors.length > 0) {
          return failedImportResult(rows.length, duplicateErrors);
        }

        await manager.insert(
          ProvinceEntity,
          resolvedRows.map((row) => ({
            id: uuidv7(),
            countryId: row.countryId,
            name: row.name,
            code: row.code,
            sortOrder: 0,
            isActive: true,
          })),
        );
        return successfulImportResult(rows.length);
      });
    } catch (error) {
      if (!this.isUniqueViolation(error)) {
        throw error;
      }
      return failedImportResult(rows.length, [
        {
          row: 0,
          field: 'Tên',
          value: '',
          reason: 'Dữ liệu Province bị trùng với thay đổi vừa phát sinh trong database.',
        },
      ]);
    }
  }

  private validateImportRows(rows: ProvinceImportRow[]): CsvImportError[] {
    const errors: CsvImportError[] = [];
    const duplicateGroups = new Map<string, ProvinceImportRow[]>();

    for (const row of rows) {
      if (!row.countryCode) {
        errors.push({
          row: row.row,
          field: 'Country code',
          value: '',
          reason: 'Country code là bắt buộc.',
        });
      } else if (!/^[A-Z]{2}$/.test(row.countryCode)) {
        errors.push({
          row: row.row,
          field: 'Country code',
          value: toErrorValue(row.countryCode),
          reason: 'Country code phải gồm đúng 2 chữ cái từ A đến Z.',
        });
      }

      if (!row.name) {
        errors.push({ row: row.row, field: 'Tên', value: '', reason: 'Tên là bắt buộc.' });
      } else if (row.name.length > 200) {
        errors.push({
          row: row.row,
          field: 'Tên',
          value: toErrorValue(row.name),
          reason: 'Tên không được vượt quá 200 ký tự.',
        });
      }

      if (row.code && row.code.length > 20) {
        errors.push({
          row: row.row,
          field: 'Code',
          value: toErrorValue(row.code),
          reason: 'Code không được vượt quá 20 ký tự.',
        });
      }

      if (row.countryCode && row.name) {
        const key = `${row.countryCode}\u0000${this.normalizeName(row.name)}`;
        duplicateGroups.set(key, [...(duplicateGroups.get(key) ?? []), row]);
      }
    }

    for (const duplicateRows of duplicateGroups.values()) {
      if (duplicateRows.length < 2) {
        continue;
      }
      for (const row of duplicateRows) {
        errors.push({
          row: row.row,
          field: 'Tên',
          value: toErrorValue(row.name),
          reason: 'Province bị trùng Country và tên trong file CSV.',
        });
      }
    }
    return errors;
  }

  private normalizeName(value: string): string {
    return value.trim().normalize('NFC').toLocaleLowerCase('vi-VN');
  }

  private isUniqueViolation(error: unknown): boolean {
    if (typeof error !== 'object' || error === null || !('driverError' in error)) {
      return false;
    }
    const driverError = error.driverError;
    return (
      typeof driverError === 'object' &&
      driverError !== null &&
      'code' in driverError &&
      driverError.code === '23505'
    );
  }
}
