import {
  IsInt,
  IsOptional,
  Max,
  Min,
  IsBoolean,
  IsEnum,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Steam 신규 감지 실행 DTO
 */
export class SteamNewDto {
  /**
   * 수집 모드: 'bootstrap' | 'operational'
   * @default 'operational'
   */
  @ApiPropertyOptional({
    description: "수집 모드 ('bootstrap' 또는 'operational')",
    default: 'operational',
    example: 'operational',
  })
  @IsOptional()
  @IsEnum(['bootstrap', 'operational'], {
    message: 'mode는 bootstrap 또는 operational 이어야 합니다',
  })
  mode?: 'bootstrap' | 'operational' = 'operational';

  /**
   * 처리할 신규 게임 수 상한
   * @default 200
   */
  @ApiPropertyOptional({
    description: '처리할 신규 게임 수 제한',
    default: 200,
    example: 500,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit은 정수여야 합니다' })
  @Min(1, { message: 'limit은 최소 1 이상이어야 합니다' })
  @Max(50000, { message: 'limit은 최대 50000 이하여야 합니다' })
  limit?: number;

  /**
   * Dry-run 여부 (수집/저장 없이 대상 목록만 계산)
   * @default false
   */
  @ApiPropertyOptional({
    description: '드라이런 여부 (저장 없이 미리보기)',
    default: false,
    example: false,
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean({ message: 'dryRun은 boolean이어야 합니다' })
  dryRun?: boolean = false;
}
