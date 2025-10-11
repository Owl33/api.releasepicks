// src/youtube.types.ts

export type ConfidenceLevel = 'low' | 'medium' | 'high';

export interface YouTubeSearchItem {
  /** 동영상 제목 */
  title?: string;
  /** https://www.youtube.com/watch?v=... */
  url?: string;
  /** 채널명 */
  channelTitle?: string;
  /** 게시 시각(YouTube 검색 페이지의 사람이 읽는 포맷) */
  publishedAt?: string;
  /** 조회수 텍스트 (예: "1,234,567 views") */
  viewCountText?: string;
  /** 조회수 숫자 파싱 값 (없으면 null) */
  viewCount?: number | null;
  /** 길이 텍스트 (예: "2:31") */
  durationText?: string;
  /** 길이(초) 파싱 값 - 없으면 null */
  durationSeconds?: number | null;
  /** 설명(검색 결과 카드에 노출되는 스니펫) */
  description?: string;
}

export interface YouTubeSearchFilters {
  /** 출시 연도(있으면 쿼리 프라이어리티 높임) */
  releaseYear?: number;
  /** 추가 키워드 (앞쪽 로우에 우선 배치) */
  keywords?: string[];
}

export interface PickedTrailer {
  url: string;
  title: string;
  channel: string;
  publishedAt: string;
  confidence: ConfidenceLevel;
  score: number; // 0~1
  durationSeconds?: number | null;
  durationText?: string;
  viewCount?: number | null;
}

export interface GameTrailerResult {
  slug: string;
  /** 시도한 쿼리들 (로그/디버깅용) */
  queryTried: string[];
  /** 최종 채택 결과 (없으면 null) */
  picked: PickedTrailer | null;
}
