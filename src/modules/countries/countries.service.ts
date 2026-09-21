import { ConflictException, Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { isURL } from 'class-validator';
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
import { CountryEntity } from '../../database/entities/country.entity';
import { CreateCountryDto } from './dto/create-country.dto';

const COUNTRY_HEADERS = ['Tên quốc gia', 'Code', 'Flag'] as const;

type CountryImportRow = {
  row: number;
  name: string;
  code: string;
  flagUrl: string | null;
};

@Injectable()
export class CountriesService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
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

  async importCsv(file?: CsvUploadFile): Promise<CsvImportResult> {
    const parsed = parseCsvUpload(file, COUNTRY_HEADERS);
    if (parsed.errors.length > 0) {
      return failedImportResult(0, parsed.errors);
    }

    const rows: CountryImportRow[] = parsed.rows.map(({ row, values }) => ({
      row,
      name: values['Tên quốc gia'].trim().normalize('NFC'),
      code: values.Code.trim().toUpperCase(),
      flagUrl: values.Flag.trim() ? values.Flag.trim() : null,
    }));
    const errors = this.validateImportRows(rows);
    if (errors.length > 0) {
      return failedImportResult(rows.length, errors);
    }

    try {
      return await this.dataSource.transaction(async (manager) => {
        const codes = rows.map((row) => row.code);
        const names = rows.map((row) => this.normalizeName(row.name));
        const existing = await manager
          .createQueryBuilder(CountryEntity, 'country')
          .where('UPPER(BTRIM(country.code)) IN (:...codes)', { codes })
          .orWhere('LOWER(country.name) IN (:...names)', { names })
          .getMany();
        const existingCodes = new Set(
          existing.flatMap((country) => (country.code ? [country.code.trim().toUpperCase()] : [])),
        );
        const existingNames = new Set(existing.map((country) => this.normalizeName(country.name)));
        const databaseErrors: CsvImportError[] = [];

        for (const row of rows) {
          if (existingCodes.has(row.code)) {
            databaseErrors.push({
              row: row.row,
              field: 'Code',
              value: toErrorValue(row.code),
              reason: 'Mã quốc gia đã tồn tại.',
            });
          }
          if (existingNames.has(this.normalizeName(row.name))) {
            databaseErrors.push({
              row: row.row,
              field: 'Tên quốc gia',
              value: toErrorValue(row.name),
              reason: 'Tên quốc gia đã tồn tại.',
            });
          }
        }

        if (databaseErrors.length > 0) {
          return failedImportResult(rows.length, databaseErrors);
        }

        await manager.insert(
          CountryEntity,
          rows.map((row) => ({
            id: uuidv7(),
            name: row.name,
            code: row.code,
            flagUrl: row.flagUrl,
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
          field: 'Code',
          value: '',
          reason: 'Dữ liệu Country bị trùng với thay đổi vừa phát sinh trong database.',
        },
      ]);
    }
  }

  private validateImportRows(rows: CountryImportRow[]): CsvImportError[] {
    const errors: CsvImportError[] = [];
    const rowsByCode = new Map<string, CountryImportRow[]>();
    const rowsByName = new Map<string, CountryImportRow[]>();

    for (const row of rows) {
      if (!row.name) {
        errors.push({ row: row.row, field: 'Tên quốc gia', value: '', reason: 'Tên là bắt buộc.' });
      } else if (row.name.length > 200) {
        errors.push({
          row: row.row,
          field: 'Tên quốc gia',
          value: toErrorValue(row.name),
          reason: 'Tên không được vượt quá 200 ký tự.',
        });
      } else {
        this.appendRow(rowsByName, this.normalizeName(row.name), row);
      }

      if (!row.code) {
        errors.push({ row: row.row, field: 'Code', value: '', reason: 'Code là bắt buộc.' });
      } else if (!/^[A-Z]{2}$/.test(row.code)) {
        errors.push({
          row: row.row,
          field: 'Code',
          value: toErrorValue(row.code),
          reason: 'Code phải gồm đúng 2 chữ cái từ A đến Z.',
        });
      } else {
        this.appendRow(rowsByCode, row.code, row);
      }

      if (row.flagUrl && row.flagUrl.length > 500) {
        errors.push({
          row: row.row,
          field: 'Flag',
          value: toErrorValue(row.flagUrl),
          reason: 'Flag URL không được vượt quá 500 ký tự.',
        });
      } else if (row.flagUrl && !isURL(row.flagUrl, { require_protocol: true })) {
        errors.push({
          row: row.row,
          field: 'Flag',
          value: toErrorValue(row.flagUrl),
          reason: 'Flag phải là URL hợp lệ và có protocol.',
        });
      }
    }

    this.addDuplicateErrors(rowsByCode, errors, 'Code', 'Code bị trùng trong file CSV');
    this.addDuplicateErrors(
      rowsByName,
      errors,
      'Tên quốc gia',
      'Tên quốc gia bị trùng trong file CSV',
    );
    return errors;
  }

  private appendRow(
    groups: Map<string, CountryImportRow[]>,
    key: string,
    row: CountryImportRow,
  ): void {
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  private addDuplicateErrors(
    groups: Map<string, CountryImportRow[]>,
    errors: CsvImportError[],
    field: 'Code' | 'Tên quốc gia',
    reason: string,
  ): void {
    for (const duplicateRows of groups.values()) {
      if (duplicateRows.length < 2) {
        continue;
      }
      for (const row of duplicateRows) {
        errors.push({
          row: row.row,
          field,
          value: toErrorValue(field === 'Code' ? row.code : row.name),
          reason,
        });
      }
    }
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
