import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import type { SteamExclusionReason } from '../services/exclusion/steam-exclusion.service';

export class MarkSteamExclusionDto {
  @ApiProperty({
    description: '제외 처리할 Steam AppID',
    example: 123456,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  steamId!: number;

  @ApiProperty({
    description: "제외 사유 ('NON_GAME', 'NO_DETAILS', 'REQUEST_FAILED', 'MANUAL')",
    example: 'NON_GAME',
  })
  @IsEnum(['NON_GAME', 'NO_DETAILS', 'REQUEST_FAILED', 'MANUAL'])
  reason!: SteamExclusionReason;
}

export class ClearSteamExclusionDto {
  @ApiProperty({
    description: '제외 해제할 Steam AppID',
    example: 123456,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  steamId!: number;
}

export class BucketSnapshotQueryDto {
  @ApiPropertyOptional({
    description: '버킷에서 가져올 샘플 개수',
    default: 50,
    example: 100,
  })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8192)
  sampleLimit?: number;
}
