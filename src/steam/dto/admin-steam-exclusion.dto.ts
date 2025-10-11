import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';

import type { SteamExclusionReason } from '../services/exclusion/steam-exclusion.service';

export class MarkSteamExclusionDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  steamId!: number;

  @IsEnum(['NON_GAME', 'NO_DETAILS', 'REQUEST_FAILED', 'MANUAL'])
  reason!: SteamExclusionReason;
}

export class ClearSteamExclusionDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  steamId!: number;
}

export class BucketSnapshotQueryDto {
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8192)
  sampleLimit?: number;
}
