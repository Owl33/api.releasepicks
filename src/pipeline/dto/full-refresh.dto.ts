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

export class FullRefreshDto {
  @IsOptional()
  @IsEnum(ModeEnum)
  mode?: ModeEnum;

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
