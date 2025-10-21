import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { ModeEnum } from './single-game-manual-dto';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class FullRefreshDto {
  @ApiPropertyOptional({
    description: "수집 모드 ('bootstrap' | 'operational')",
    example: 'operational',
  })
  @IsOptional()
  @IsEnum(ModeEnum)
  mode?: ModeEnum;

  @ApiPropertyOptional({
    description: '드라이런 여부 (저장 없이 실행)',
    default: false,
    example: true,
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const lowered = value.toLowerCase();
      return lowered === 'true' || lowered === '1';
    }
    if (typeof value === 'number') return value === 1;
    return false;
  })
  @IsBoolean()
  dryRun?: boolean;

  @ApiPropertyOptional({
    description: '한 번에 처리할 게임 수 (100~2000)',
    example: 500,
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'number') return Math.trunc(value);
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  })
  @IsInt()
  @Min(100)
  @Max(2000)
  batchSize?: number;
}
