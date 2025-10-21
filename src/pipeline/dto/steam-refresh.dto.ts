import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Steam 출시 윈도우 갱신 DTO
 * Body 파라미터 검증
 */
export class SteamRefreshDto {
  /**
   * 갱신 대상 최대 개수
   * @default 40
   */
  @ApiPropertyOptional({
    description: '갱신할 게임 수 제한',
    default: 40,
    example: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit은 정수여야 합니다' })
  @Min(1, { message: 'limit은 최소 1 이상이어야 합니다' })
  @Max(10000, { message: 'limit은 최대 10000 이하여야 합니다' })
  limit?: number = 40;

  /**
   * Dry-run 여부 (실제 저장/갱신 없이 후보만 확인)
   * @default false
   */
  @ApiPropertyOptional({
    description: '드라이런 여부 (저장 없이 후보 확인)',
    default: false,
    example: true,
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean({ message: 'dryRun은 boolean 값이어야 합니다' })
  dryRun?: boolean = false;
}
