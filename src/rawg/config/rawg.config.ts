// src/config/rawg.config.ts
// ✅ 운영 정책/플랫폼/임계값을 "문서+코드" 단일 소스로 관리
export const RAWG_API_BASE_URL = 'https://api.rawg.io/api';

// 최신+직전 세대만 사용 (PS: 187,18 | Xbox: 186,1 | Nintendo: 7)
// ⚠️ Switch 2가 RAWG에 추가되면 아래 nintendo 배열에 ID를 "수동으로" 추가하고
// TECHNICAL-DESIGN.md Section 8, CURRENT-STATUS.md도 즉시 갱신할 것.
export const RAWG_PLATFORM_IDS = {
  playstation: [187, 18], // PS5, PS4
  xbox: [186, 1], // Series X|S, One
  nintendo: [7], // Switch (Switch 2 나오면 여기에 추가)
} as const;

// 월 단위 통합 수집 파라미터(기본값)
export const RAWG_COLLECTION = {
  pageSize: 200 as const,
  ordering: '-released' as const,
  pastMonths: 12,
  futureMonths: 12,
  popularityThreshold: 40,
  minAdded: 3,
  requestDelayMs: 350,
  retry: { max: 5, baseDelayMs: 600 },
};
