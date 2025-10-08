import { IsString, MinLength, IsOptional, IsInt, Min, Max } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * 게임 검색 요청 DTO
 * 자동완성 검색에 사용
 */
export class SearchGamesDto {
  /**
   * 검색어 (최소 2자)
   */
  @IsString()
  @MinLength(2, { message: '검색어는 최소 2자 이상이어야 합니다.' })
  q: string;

  /**
   * 결과 개수 제한
   */
  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  @Max(20)
  limit?: number; // 기본값: 10
}

/**
 * 검색 결과 단일 게임 DTO
 */
export interface SearchGameDto {
  gameId: number;
  name: string;
  slug: string;
  headerImage: string | null;
  releaseDate: Date | null;
  popularityScore: number;
  followersCache: number | null;
  platforms: string[];
  developers: string[];
  publishers: string[];
}

/**
 * 검색 응답 DTO
 */
export interface SearchResponseDto {
  query: string;
  count: number;
  data: SearchGameDto[];
}
