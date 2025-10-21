import {
  IsOptional,
  Matches,
  IsInt,
  Min,
  Max,
  IsIn,
  IsBoolean,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

function toNumber(value: any): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function toBoolean(value: any): boolean | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lowered = value.toLowerCase();
    if (['true', '1', 'yes'].includes(lowered)) return true;
    if (['false', '0', 'no'].includes(lowered)) return false;
  }
  return undefined;
}

export class RawgNewDto {
  @ApiPropertyOptional({
    description: '조회 시작 월(YYYY-MM)',
    example: '2025-10',
  })
  @ApiPropertyOptional({
    description: '조회 종료 월(YYYY-MM)',
    example: '2025-12',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}$/, {
    message: 'startMonth는 YYYY-MM 형식이어야 합니다.',
  })
  startMonth?: string;

  @ApiPropertyOptional({
    description: '조회 종료 월(YYYY-MM)',
    example: '2025-12',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}$/, {
    message: 'endMonth는 YYYY-MM 형식이어야 합니다.',
  })
  endMonth?: string;

  @ApiPropertyOptional({
    description: '현재 시점 기준 과거로 몇 개월까지 조회할지',
    default: 0,
    example: 2,
  })
  @IsOptional()
  @Transform(({ value }) => toNumber(value))
  @IsInt()
  @Min(0)
  monthsBack?: number;

  @ApiPropertyOptional({
    description: '현재 시점 기준 미래로 몇 개월까지 조회할지',
    default: 0,
    example: 1,
  })
  @IsOptional()
  @Transform(({ value }) => toNumber(value))
  @IsInt()
  @Min(0)
  monthsForward?: number;

  @ApiPropertyOptional({
    description: '조회할 월 개수 제한',
    example: 6,
  })
  @IsOptional()
  @Transform(({ value }) => toNumber(value))
  @IsInt()
  @Min(1)
  limitMonths?: number;

  @ApiPropertyOptional({
    description: "정렬 기준 ('-released' 또는 '-added')",
    default: '-released',
  })
  @IsOptional()
  @IsIn(['-released', '-added'])
  ordering?: '-released' | '-added';

  @ApiPropertyOptional({
    description: 'Metacritic 필터 (예: 80,100)',
    example: '80,100',
  })
  @IsOptional()
  metacritic?: string;

  @ApiPropertyOptional({
    description: 'RAWG API 페이지 크기 (1~40)',
    default: 5,
    example: 5,
  })
  @IsOptional()
  @Transform(({ value }) => toNumber(value))
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;

  @ApiPropertyOptional({
    description: '이미 존재하는 RAWG ID를 제외할지 여부',
    default: true,
    example: true,
  })
  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  excludeExisting?: boolean;

  @ApiPropertyOptional({
    description: '드라이런 여부 (저장 없이 시뮬레이션)',
    default: false,
    example: false,
  })
  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  dryRun?: boolean;
}
