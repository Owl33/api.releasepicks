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
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * 게임 타입 필터 (타입 안전성 강화)
 */
export type GameTypeFilter = 'all' | 'game' | 'dlc';

/**
 * 정렬 기준 타입
 */
export type SortBy = 'releaseDate' | 'popularity' | 'name';

/**
 * 정렬 순서 타입
 */
export type SortOrder = 'ASC' | 'DESC';

/**
 * 게임 필터 및 페이지네이션 요청 DTO
 * 캘린더 API와 전체 게임 조회 API 통합에 사용
 */
export class GameFilterDto {
  // ===== 날짜 필터 =====
  @ApiPropertyOptional({
    description: '조회할 월(YYYY-MM)',
    example: '2025-11',
  })
  @IsOptional()
  @IsString()
  month?: string; // YYYY-MM 형식 (있으면 월별, 없으면 전체)

  @ApiPropertyOptional({
    description: '조회 시작일(YYYY-MM-DD)',
    example: '2025-10-01',
  })
  @IsOptional()
  @IsDateString()
  startDate?: string; // YYYY-MM-DD

  @ApiPropertyOptional({
    description: '조회 종료일(YYYY-MM-DD)',
    example: '2025-12-31',
  })
  @IsOptional()
  @IsDateString()
  endDate?: string; // YYYY-MM-DD

  // ===== 출시 상태 필터 =====
  @ApiPropertyOptional({
    description: '미출시 게임 포함 여부',
    default: true,
    example: true,
  })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  includeUnreleased?: boolean; // 미출시 게임 포함 여부 (기본 true)

  @ApiPropertyOptional({
    description: '미출시 게임만 조회',
    example: false,
  })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  onlyUpcoming?: boolean; // 미출시 게임만 조회

  // ===== 장르/태그 필터 =====
  @ApiPropertyOptional({
    description: '장르 목록 (콤마 구분)',
    example: 'Action,RPG',
  })
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

  @ApiPropertyOptional({
    description: '태그 목록 (콤마 구분)',
    example: 'Soulslike,Multiplayer',
  })
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
  @ApiPropertyOptional({
    description: '개발사 목록 (콤마 구분)',
    example: 'Larian Studios,FromSoftware',
  })
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

  @ApiPropertyOptional({
    description: '퍼블리셔 목록 (콤마 구분)',
    example: 'Bandai Namco,Sony Interactive Entertainment',
  })
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
  @ApiPropertyOptional({
    description: '플랫폼 목록 (콤마 구분)',
    example: 'pc,ps5,xbox-series',
  })
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

  // ===== 리뷰 점수 필터 =====
  @ApiPropertyOptional({
    description:
      'Steam 리뷰 요약(desc) 목록 (콤마 구분) — all, none, 영어 원문 값 사용',
    example: 'Overwhelmingly Positive,Mixed',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      return value
        .split(',')
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
    }
    return value;
  })
  @IsArray()
  @IsString({ each: true })
  reviewScoreDesc?: string[]; // Steam 리뷰 요약 필터

  // ===== 인기도 필터 =====
  @ApiPropertyOptional({
    description: '최소 인기도 점수 (40~100)',
    default: 40,
    example: 60,
  })
  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  @Min(40)
  @Max(100)
  popularityScore?: number; // 최소 인기도 (기본 40, 범위: 40-100)

  // ===== 페이지네이션 =====
  @ApiPropertyOptional({
    description: '페이지 번호 (1 이상)',
    default: 1,
    example: 1,
  })
  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  page?: number; // 페이지 번호 (기본 1)

  @ApiPropertyOptional({
    description: '페이지 크기 (1~200)',
    default: 20,
    example: 20,
  })
  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  @Max(250)
  pageSize?: number; // 페이지 크기

  // ===== 정렬 =====
  @ApiPropertyOptional({
    description: "정렬 기준 ('releaseDate' | 'popularity' | 'name')",
    example: 'releaseDate',
  })
  @IsOptional()
  @IsString()
  @IsIn(['releaseDate', 'popularity', 'name'], {
    message: "sortBy는 'releaseDate', 'popularity', 'name' 중 하나여야 합니다",
  })
  sortBy?: SortBy; // 정렬 기준 (기본 releaseDate)

  @ApiPropertyOptional({
    description: "정렬 순서 ('ASC' | 'DESC')",
    default: 'ASC',
    example: 'ASC',
  })
  @IsOptional()
  @IsString()
  @IsIn(['ASC', 'DESC'], {
    message: "sortOrder는 'ASC', 'DESC' 중 하나여야 합니다",
  })
  sortOrder?: SortOrder; // 정렬 순서 (기본 ASC)

  // ===== 게임 타입 필터 =====
  @ApiPropertyOptional({
    description: "게임 타입 필터 ('all' | 'game' | 'dlc')",
    default: 'all',
    example: 'all',
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toLowerCase().trim() : value,
  )
  @IsIn(['all', 'game', 'dlc'], {
    message: "gameType은 'all', 'game', 'dlc' 중 하나여야 합니다",
  })
  gameType?: GameTypeFilter;
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
    gameType?: GameTypeFilter; // ✅ 타입 명시화
    reviewScoreDesc?: string[];
  };
  pagination: PaginationMeta;
  count: {
    total: number;
    filtered: number;
  };
  data: any[]; // CalendarReleaseDto 타입 재사용
}
