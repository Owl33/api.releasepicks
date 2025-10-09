import {
  IsString,
  MinLength,
  IsOptional,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * 게임 검색 요청 DTO
 * 자동완성 검색에 사용
 */
export class SearchGamesDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  // ⛔️ MinLength(2) 제거 — 짧은 q도 통과시켜 서비스에서 처리
  q?: string;

  @IsOptional()
  // undefined/null/''는 그대로 undefined 유지 → @IsOptional() 통과
  @Transform(({ value }) =>
    value === undefined || value === null || value === ''
      ? undefined
      : parseInt(value, 10),
  )
  @IsInt()
  @Min(1)
  @Max(20)
  limit?: number; // 기본값은 서비스에서 10으로 처리
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
