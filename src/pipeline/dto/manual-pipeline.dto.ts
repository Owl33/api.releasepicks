import { IsEnum, IsInt, IsOptional, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * 수동 파이프라인 실행 DTO
 * Query Parameters 검증
 */
export class ManualPipelineDto {
  /**
   * 실행 단계: 'steam' | 'rawg' | 'full'
   * @default 'full'
   */
  @IsOptional()
  @IsEnum(['steam', 'rawg', 'full'], {
    message: 'phase는 steam, rawg, full 중 하나여야 합니다',
  })
  phase?: 'steam' | 'rawg' | 'full' = 'full';

  /**
   * 실행 모드: 'bootstrap' | 'operational'
   * @default 'bootstrap'
   */
  @IsOptional()
  @IsEnum(['bootstrap', 'operational'], {
    message: 'mode는 bootstrap, operational 중 하나여야 합니다',
  })
  mode?: 'bootstrap' | 'operational' = 'bootstrap';

  /**
   * 수집할 게임 수
   * @default 200
   * @min 1
   * @max 10000
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit은 정수여야 합니다' })
  @Min(1, { message: 'limit은 최소 1 이상이어야 합니다' })
  @Max(10000, { message: 'limit은 최대 10000 이하여야 합니다' })
  limit?: number = 200;

  /**
   * 수집 전략: 'latest' | 'priority'
   * - latest: 최신순 (bootstrap 테스트용)
   * - priority: 복합 우선순위 (operational 모드)
   * @default 'latest'
   */
  @IsOptional()
  @IsEnum(['latest', 'priority'], {
    message: 'strategy는 latest, priority 중 하나여야 합니다',
  })
  strategy?: 'latest' | 'priority' = 'latest';
}
