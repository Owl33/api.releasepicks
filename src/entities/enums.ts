/**
 * 데이터베이스 Enum 타입 정의
 * FINAL-ARCHITECTURE-DESIGN 명세 기반
 */

// 게임 타입 enum (TypeORM enum용)
export enum GameType {
  GAME = 'game',
  DLC = 'dlc',
  DEMO = 'demo',
  SOUNDTRACK = 'soundtrack',
}

// 출시 상태 enum
export enum ReleaseStatus {
  RELEASED = 'released',
  COMING_SOON = 'coming_soon',
  EARLY_ACCESS = 'early_access',
  CANCELLED = 'cancelled',
  TBA = 'tba',
}
export type SteamReleaseDateRaw = {
  coming_soon?: boolean;
  date?: string; // e.g. "19 Aug, 2024", "To be announced", "Q4 2025", ...
};
// 부모 게임 참조 타입 enum
export enum ParentReferenceType {
  INTERNAL = 'internal', // games 테이블 parent_game_id
  STEAM_ID = 'steam_id', // parent_steam_id
  RAWG_ID = 'rawg_id', // parent_rawg_id
}

// 플랫폼 enum (통합 플랫폼만 사용)
export enum Platform {
  PC = 'pc',
  PLAYSTATION = 'playstation', // PS5/PS4/PS3 통합
  XBOX = 'xbox', // Series X|S/One/360 통합
  NINTENDO = 'nintendo', // Switch/Switch 2 통합
}

// 스토어 enum
export enum Store {
  STEAM = 'steam',
  EPIC = 'epic',
  GOG = 'gog',
  PSN = 'psn',
  XBOX = 'xbox', // RAWG 콘솔 통합
  NINTENDO = 'nintendo', // RAWG 콘솔 통합
  XBOX_STORE = 'xbox_store',
  ESHOP = 'eshop',
  APP_STORE = 'app_store',
  GOOGLE_PLAY = 'google_play',
}

// 회사 역할 enum
export enum CompanyRole {
  DEVELOPER = 'developer',
  PUBLISHER = 'publisher',
}

// 데이터베이스용 SQL enum 타입 정의
export const EnumDefinitions = {
  game_type_enum: ['game', 'dlc', 'demo', 'soundtrack'],
  release_status_enum: [
    'released',
    'coming_soon',
    'early_access',
    'cancelled',
    'tba',
  ],
  parent_reference_type_enum: ['internal', 'steam_id', 'rawg_id'],
  platform_enum: ['pc', 'playstation', 'xbox', 'nintendo'],
  store_enum: [
    'steam',
    'epic',
    'gog',
    'psn',
    'xbox',
    'nintendo',
    'xbox_store',
    'eshop',
    'app_store',
    'google_play',
  ],
  company_role_enum: ['developer', 'publisher'],
};
