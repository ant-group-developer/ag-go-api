import { IsArray, IsBoolean, IsDateString, IsEnum, IsOptional, IsUUID } from 'class-validator';

export enum RerenderWatermarkScope {
  PROJECT = 'PROJECT',
  FILTER = 'FILTER',
  NOT_WATERMARKED = 'NOT_WATERMARKED',
}

export enum RerenderMediaType {
  ALL = 'ALL',
  IMAGE = 'IMAGE',
  VIDEO = 'VIDEO',
}

export class RerenderWatermarkDto {
  @IsEnum(RerenderWatermarkScope)
  scope!: RerenderWatermarkScope;

  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  projectIds?: string[];

  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  categoryIds?: string[];

  @IsOptional()
  @IsEnum(RerenderMediaType)
  mediaType?: RerenderMediaType;

  /** Keep previews that already match the profile; default true. */
  @IsOptional()
  @IsBoolean()
  reuseExisting?: boolean;
}
