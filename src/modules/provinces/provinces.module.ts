import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CountryEntity } from '../../database/entities/country.entity';
import { ProvinceEntity } from '../../database/entities/province.entity';
import { ProvincesController } from './provinces.controller';
import { ProvincesService } from './provinces.service';

@Module({
  imports: [TypeOrmModule.forFeature([CountryEntity, ProvinceEntity])],
  controllers: [ProvincesController],
  providers: [ProvincesService],
})
export class ProvincesModule {}
