import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  IsInt,
  Min,
  Max,
  IsDateString,
  IsBoolean,
  IsArray,
  IsIn,
} from 'class-validator';

/**
 * 게임 필터 및 페이지네이션 요청 DTO
 * 캘린더 API와 전체 게임 조회 API 통합에 사용
 */
export class GameFilterDto {
  // ===== 날짜 필터 =====
  @IsOptional()
  @IsString()
  month?: string; // YYYY-MM 형식 (있으면 월별, 없으면 전체)

  @IsOptional()
  @IsDateString()
  startDate?: string; // YYYY-MM-DD

  @IsOptional()
  @IsDateString()
  endDate?: string; // YYYY-MM-DD

  // ===== 출시 상태 필터 =====
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  includeUnreleased?: boolean; // 미출시 게임 포함 여부 (기본 true)

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  onlyUpcoming?: boolean; // 미출시 게임만 조회

  // ===== 장르/태그 필터 =====
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      return value.split(',').map((v) => v.trim());
    }
    return value;
  })
  @IsArray()
  @IsString({ each: true })
  genres?: string[]; // 장르 배열 (OR 조건)

  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      return value.split(',').map((v) => v.trim());
    }
    return value;
  })
  @IsArray()
  @IsString({ each: true })
  tags?: string[]; // 태그 배열 (OR 조건)

  // ===== 회사 필터 =====
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      return value.split(',').map((v) => v.trim());
    }
    return value;
  })
  @IsArray()
  @IsString({ each: true })
  developers?: string[]; // 개발사 배열 (OR 조건)

  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      return value.split(',').map((v) => v.trim());
    }
    return value;
  })
  @IsArray()
  @IsString({ each: true })
  publishers?: string[]; // 퍼블리셔 배열 (OR 조건)

  // ===== 플랫폼 필터 =====
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      return value.split(',').map((v) => v.trim());
    }
    return value;
  })
  @IsArray()
  @IsString({ each: true })
  platforms?: string[]; // 플랫폼 배열 (OR 조건)

  // ===== 인기도 필터 =====
  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  @Min(40)
  @Max(100)
  popularityScore?: number; // 최소 인기도 (기본 40, 범위: 40-100)

  // ===== 페이지네이션 =====
  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  page?: number; // 페이지 번호 (기본 1)

  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number; // 페이지 크기 (기본 20, 범위 10-50)

  // ===== 정렬 =====
  @IsOptional()
  @IsString()
  sortBy?: 'releaseDate' | 'popularity' | 'name'; // 정렬 기준 (기본 releaseDate)

  @IsOptional()
  @IsString()
  sortOrder?: 'ASC' | 'DESC'; // 정렬 순서 (기본 ASC)

  // ===== 게임 타입 필터 =====
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toLowerCase().trim() : value,
  )
  @IsIn(['all', 'game', 'dlc'], {
    message: "gameType은 'all', 'game', 'dlc' 중 하나여야 합니다",
  })
  gameType?: 'all' | 'game' | 'dlc';
}

/**
 * 페이지네이션 메타 정보
 */
export interface PaginationMeta {
  currentPage: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

/**
 * 필터가 적용된 게임 목록 응답 DTO
 * CalendarResponseDto와 구조 통일
 */
export interface FilteredGamesResponseDto {
  filters: {
    month?: string;
    dateRange?: {
      start: string;
      end: string;
    };
    genres?: string[];
    tags?: string[];
    developers?: string[];
    publishers?: string[];
    platforms?: string[];
    gameType?: 'all' | 'game' | 'dlc';
  };
  pagination: PaginationMeta;
  count: {
    total: number;
    filtered: number;
  };
  data: any[]; // CalendarReleaseDto 타입 재사용
}
