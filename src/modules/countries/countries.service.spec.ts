import { DataSource, Repository } from 'typeorm';
import { CountryEntity } from '../../database/entities/country.entity';
import { CountriesService } from './countries.service';

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
    originalname: 'countries.csv',
    size: buffer.length,
  };
}

describe('CountriesService.importCsv', () => {
  it('rejects duplicate normalized codes before opening a transaction', async () => {
    const transaction = jest.fn();
    const service = new CountriesService(
      { transaction } as unknown as DataSource,
      {} as Repository<CountryEntity>,
    );

    const result = await service.importCsv(
      csvFile('Tên quốc gia,Code,Flag\nAfghanistan,af,\nAnother Afghanistan,AF,'),
    );

    expect(result).toMatchObject({ totalRows: 2, inserted: 0, failed: 2 });
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'Code', value: 'AF' })]),
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it('checks existing data once and inserts all rows in one batch', async () => {
    const getMany = jest.fn().mockResolvedValue([]);
    const queryBuilder = {
      where: jest.fn().mockReturnThis(),
      orWhere: jest.fn().mockReturnThis(),
      getMany,
    };
    const manager = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
      insert: jest.fn().mockResolvedValue(undefined),
    };
    const transaction = jest.fn(async (callback: (value: typeof manager) => Promise<unknown>) =>
      callback(manager),
    );
    const service = new CountriesService(
      { transaction } as unknown as DataSource,
      {} as Repository<CountryEntity>,
    );

    const result = await service.importCsv(
      csvFile('Tên quốc gia,Code,Flag\nAfghanistan,af,\nViệt Nam,vn,'),
    );

    expect(result).toEqual({ totalRows: 2, inserted: 2, failed: 0, errors: [] });
    expect(manager.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(manager.insert).toHaveBeenCalledTimes(1);
    expect(manager.insert.mock.calls[0][1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'AF' }),
        expect.objectContaining({ code: 'VN' }),
      ]),
    );
  });
});
