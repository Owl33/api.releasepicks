import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

const toOptionalNumber = (value: any): number | undefined => {
  if (value === null || value === undefined || value === '') return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
};

const toOptionalBoolean = (value: any): boolean | undefined => {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lowered = value.toLowerCase();
    if (['true', '1', 'yes'].includes(lowered)) return true;
    if (['false', '0', 'no'].includes(lowered)) return false;
  }
  return undefined;
};

const toNumberArray = (value: any): number[] | undefined => {
  if (value === null || value === undefined || value === '') return undefined;
  const arr = Array.isArray(value) ? value : [value];
  const numeric = arr
    .map((item) => Number(item))
    .filter((num) => Number.isFinite(num) && num > 0);
  return numeric.length > 0 ? numeric : undefined;
};

export class RawgRefreshDto {
  @ApiPropertyOptional({
    description: '갱신할 RAWG ID 배열 (지정하면 해당 ID만 갱신)',
    example: [1234, 5678],
  })
  @IsOptional()
  @Transform(({ value }) => toNumberArray(value))
  @IsArray()
  @ArrayNotEmpty()
  rawgIds?: number[];

  @ApiPropertyOptional({
    description: '전체 갱신 시 상위 N개만 처리',
    example: 100,
  })
  @IsOptional()
  @Transform(({ value }) => toOptionalNumber(value))
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiPropertyOptional({
    description: '한 번에 요청할 RAWG ID 수 (1 이상)',
    default: 20,
    example: 20,
  })
  @IsOptional()
  @Transform(({ value }) => toOptionalNumber(value))
  @IsInt()
  @Min(1)
  chunkSize?: number;

  @ApiPropertyOptional({
    description: '청크 사이 대기 시간(ms)',
    default: 1000,
    example: 1500,
  })
  @IsOptional()
  @Transform(({ value }) => toOptionalNumber(value))
  @IsInt()
  @Min(0)
  delayMs?: number;

  @ApiPropertyOptional({
    description: '드라이런 여부',
    default: false,
    example: false,
  })
  @IsOptional()
  @Transform(({ value }) => toOptionalBoolean(value))
  @IsBoolean()
  dryRun?: boolean;
}
