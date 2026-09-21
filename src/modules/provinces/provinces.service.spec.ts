import { DataSource, Repository } from 'typeorm';
import { CountryEntity } from '../../database/entities/country.entity';
import { ProvinceEntity } from '../../database/entities/province.entity';
import { ProvincesService } from './provinces.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectDataSource: () => () => undefined,
  InjectRepository: () => () => undefined,
}));
jest.mock('uuid', () => ({ v7: () => 'generated-uuid' }));

function csvFile(content: string) {
  const buffer = Buffer.from(content, 'utf8');
  return {
    buffer,
    mimetype: 'text/csv',
    originalname: 'provinces.csv',
    size: buffer.length,
  };
}

describe('ProvincesService.importCsv', () => {
  it('reports a missing active Country without inserting data', async () => {
    const countryBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    const manager = {
      createQueryBuilder: jest.fn().mockReturnValue(countryBuilder),
      insert: jest.fn(),
    };
    const transaction = jest.fn(async (callback: (value: typeof manager) => Promise<unknown>) =>
      callback(manager),
    );
    const service = new ProvincesService(
      { transaction } as unknown as DataSource,
      {} as Repository<CountryEntity>,
      {} as Repository<ProvinceEntity>,
    );

    const result = await service.importCsv(csvFile('Country code,Tên,Code\nVN,Hà Nội,HN'));

    expect(result).toMatchObject({ totalRows: 1, inserted: 0, failed: 1 });
    expect(result.errors[0]).toMatchObject({
      row: 2,
      field: 'Country code',
      value: 'VN',
    });
    expect(manager.insert).not.toHaveBeenCalled();
  });

  it('resolves Countries in one query and inserts Provinces in one batch', async () => {
    const countryBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([
        { id: 'country-af', code: 'AF', isActive: true },
        { id: 'country-vn', code: 'VN', isActive: true },
      ]),
    };
    const provinceBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    const manager = {
      createQueryBuilder: jest
        .fn()
        .mockImplementation((entity: unknown) =>
          entity === CountryEntity ? countryBuilder : provinceBuilder,
        ),
      insert: jest.fn().mockResolvedValue(undefined),
    };
    const transaction = jest.fn(async (callback: (value: typeof manager) => Promise<unknown>) =>
      callback(manager),
    );
    const service = new ProvincesService(
      { transaction } as unknown as DataSource,
      {} as Repository<CountryEntity>,
      {} as Repository<ProvinceEntity>,
    );

    const result = await service.importCsv(
      csvFile('Country code,Tên,Code\naf,Badakhshān,BDS\nvn,Hà Nội,HN'),
    );

    expect(result).toEqual({ totalRows: 2, inserted: 2, failed: 0, errors: [] });
    expect(manager.createQueryBuilder).toHaveBeenCalledTimes(2);
    expect(manager.insert).toHaveBeenCalledTimes(1);
    expect(manager.insert.mock.calls[0][1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ countryId: 'country-af', name: 'Badakhshān' }),
        expect.objectContaining({ countryId: 'country-vn', name: 'Hà Nội' }),
      ]),
    );
  });
});
