/**
 * 🎯 데이터 처리 유틸리티
 * DataMapper 클래스 - 엔티티와 DTO 간의 데이터 변환 및 매핑 통합
 *
 * 통합된 기능:
 * - 스크린샷 데이터 표준화
 * - Steam 리뷰 데이터 계산
 * - 엔티티 ↔ DTO 매핑
 * - 태그/카테고리 필터링
 * - 플랫폼 타입 결정
 */

import { GameCalendarData } from '../types/game-calendar-unified.types';
import { Game } from '../entities/game.entity';
import { GameDetail } from '../entities/game-detail.entity';

export class DataMapper {

  /**
   * 🖼️ 스크린샷 데이터 표준화
   * 다양한 형태의 스크린샷 데이터를 string[]로 통일
   */
  static normalizeScreenshots(screenshots: any): string[] {
    if (!screenshots) return [];

    if (Array.isArray(screenshots)) {
      return screenshots.map((s) => {
        if (typeof s === 'string') return s;
        if (s && typeof s === 'object') {
          return s.image || s.path_full || s.url || String(s);
        }
        return String(s);
      }).filter(Boolean);
    }

    return [];
  }

  /**
   * 🏷️ RAWG 태그 표준화
   * 영어 태그만 필터링하고 최대 10개로 제한
   */
  static normalizeRawgTags(tags: any[]): string[] {
    if (!Array.isArray(tags)) return [];

    return tags
      .filter((t: any) => t.language === 'eng')
      .map((t: any) => t.name)
      .slice(0, 10);
  }

  /**
   * 📂 Steam 카테고리 표준화
   * Steam 카테고리 객체를 문자열 배열로 변환
   */
  static normalizeSteamCategories(categories: any[]): string[] {
    if (!Array.isArray(categories)) return [];

    return categories
      .map((cat: any) => {
        if (typeof cat === 'string') return cat;
        return cat?.description || '';
      })
      .filter(Boolean);
  }

  /**
   * ⭐ Steam 리뷰 데이터 계산
   * positive, negative, total 리뷰 수 계산
   */
  static calculateReviewData(steamReviews: any): {
    total_positive?: number;
    total_negative?: number;
    total_reviews?: number;
    review_score?: number;
    review_score_desc?: string;
  } {
    if (!steamReviews) return {};

    const positive = steamReviews.total_positive || 0;
    const total = steamReviews.total_reviews || 0;
    const negative = total > 0 && positive > 0 ? total - positive : 0;

    return {
      total_positive: positive || undefined,
      total_negative: negative || undefined,
      total_reviews: total || undefined,
      review_score: steamReviews.review_score || undefined,
      review_score_desc: steamReviews.review_score_desc || undefined,
    };
  }

  /**
   * 🎮 GameCalendarData → Game Entity 매핑
   * 통합된 게임 데이터를 DB 엔티티로 변환
   */
  static mapToGameEntity(gameData: GameCalendarData): Partial<Game> {
    return {
      rawg_id: gameData.rawg_id,
      name: gameData.name,
      released: new Date(gameData.released),
      platforms: gameData.platforms,
      genres: gameData.genres,
      added: gameData.added,
      image: gameData.image,
      developers: gameData.developers,
      publishers: gameData.publishers,

      // Steam 통합 필드들
      steam_id: gameData.steam_id || undefined,
      korea_name: gameData.korea_name || undefined,
      steam_price: gameData.price || undefined,
      steam_type: gameData.steam_type || (gameData.is_full_game === false ? 'dlc' : 'game'),
      fullgame_info: undefined, // DLC의 경우 추후 본편 정보 추가
      dlc_list: gameData.dlc_list || undefined,

      // Steam 리뷰 데이터
      steam_reviews_positive: gameData.total_positive || undefined,
      steam_reviews_total: gameData.total_reviews || undefined,
      steam_review_score: gameData.review_score_desc || undefined,
    };
  }

  /**
   * 📝 GameCalendarData → GameDetail Entity 매핑
   * 게임 상세 정보를 DB 엔티티로 변환
   */
  static mapToGameDetailEntity(gameData: GameCalendarData, gameId: number): Partial<GameDetail> {
    return {
      game_id: gameId,
      slug_name: gameData.slug_name || '',
      tags: gameData.tags || [],
      rating: gameData.rating || 0,
      early_access: gameData.early_access || false,
      ratings_count: gameData.ratings_count || 0,
      screenshots: this.normalizeScreenshots(gameData.screenshots),
      store_links: gameData.store_links || {},
      esrb_rating: gameData.esrb_rating || undefined,
      description: gameData.description || undefined,
      website: gameData.website || undefined,
    };
  }

  /**
   * 🔄 Game Entity → GameCalendarData 매핑
   * DB 엔티티를 통합 게임 데이터로 변환
   */
  static mapFromGameEntity(
    game: Game,
    gameDetail?: GameDetail | null
  ): GameCalendarData {
    // Steam 리뷰 데이터 계산
    const reviewData = {
      total_positive: game.steam_reviews_positive || undefined,
      total_negative:
        game.steam_reviews_total && game.steam_reviews_positive
          ? game.steam_reviews_total - game.steam_reviews_positive
          : undefined,
      total_reviews: game.steam_reviews_total || undefined,
    };

    return {
      // === RAWG 기본 정보 ===
      rawg_id: game.rawg_id,
      name: game.name,
      required_age: '', // Steam에서만 제공
      released: game.released.toISOString().split('T')[0],
      tba: false,
      platforms: this.normalizePlatforms(game.platforms || []),
      genres: game.genres || [],
      tags: gameDetail?.tags || [],
      early_access: gameDetail?.early_access || false,
      image: game.image || '',

      // === 인기도 및 미디어 ===
      added: game.added || 0,
      added_by_status: {},
      screenshots: this.normalizeScreenshots(gameDetail?.screenshots),

      // === 평점 및 등급 ===
      esrb_rating: gameDetail?.esrb_rating || null,
      rating: gameDetail?.rating || 0,
      ratings_count: gameDetail?.ratings_count || 0,
      description: gameDetail?.description || '',

      // === Steam 전용 데이터 ===
      metacritic: undefined,
      categories: [],

      // === 개발사/배급사 정보 ===
      slug_name: gameDetail?.slug_name || '',
      website: gameDetail?.website || game.developers?.[0] || '',
      developers: game.developers || [],
      publishers: game.publishers || [],

      // === 링크 및 미디어 ===
      store_links: gameDetail?.store_links || {},
      video: undefined, // YouTube 데이터는 실시간 조회 필요

      // === Steam 리뷰 관련 ===
      review_score: undefined, // Steam review score는 숫자 타입이지만 DB에는 문자열로 저장
      review_score_desc: game.steam_review_score || undefined,
      ...reviewData,

      // === Steam 통합 필드들 ===
      steam_id: game.steam_id || undefined,
      original_name: game.name,
      korea_name: game.korea_name || undefined,
      steam_type: game.steam_type || undefined,
      price: game.steam_price || undefined,
      is_full_game: game.steam_type === 'game',
      dlc_list: game.dlc_list || undefined,
      is_free: game.steam_price === '무료',

      // === DLC 관련 ===
      is_dlc: game.steam_type === 'dlc',
      game_type: game.steam_type === 'dlc' ? 'dlc' : 'main_game',
      game_type_confidence: 0.95,
      game_type_reason: 'DB에서 기존 데이터 사용',

      // === 메타 정보 ===
      platform_type: this.determinePlatformType(this.normalizePlatforms(game.platforms || [])),
      steam_integrated: !!game.steam_id,
    };
  }

  /**
   * 🔄 Game Entity 업데이트 매핑
   * 새로운 GameCalendarData로 기존 Game Entity 업데이트
   */
  static updateGameEntity(existingGame: Game, newGameData: GameCalendarData): void {
    // 기본 정보 업데이트
    existingGame.name = newGameData.name;
    existingGame.released = new Date(newGameData.released);
    existingGame.platforms = newGameData.platforms;
    existingGame.genres = newGameData.genres;
    existingGame.added = newGameData.added;
    existingGame.image = newGameData.image;
    existingGame.developers = newGameData.developers;
    existingGame.publishers = newGameData.publishers;

    // Steam 통합 필드들 업데이트 (기존값 유지 원칙)
    existingGame.steam_id = newGameData.steam_id || existingGame.steam_id;
    existingGame.korea_name = newGameData.korea_name || existingGame.korea_name;
    existingGame.steam_price = newGameData.price || existingGame.steam_price;
    existingGame.steam_type = newGameData.steam_type || existingGame.steam_type;
    existingGame.dlc_list = newGameData.dlc_list || existingGame.dlc_list;

    // Steam 리뷰 데이터 업데이트
    existingGame.steam_reviews_positive = newGameData.total_positive || existingGame.steam_reviews_positive;
    existingGame.steam_reviews_total = newGameData.total_reviews || existingGame.steam_reviews_total;
    existingGame.steam_review_score = newGameData.review_score_desc || existingGame.steam_review_score;
  }

  /**
   * 🔄 GameDetail Entity 업데이트 매핑
   * 새로운 GameCalendarData로 기존 GameDetail Entity 업데이트
   */
  static updateGameDetailEntity(gameDetail: GameDetail, newGameData: GameCalendarData): void {
    gameDetail.slug_name = newGameData.slug_name || gameDetail.slug_name || '';
    gameDetail.tags = newGameData.tags || gameDetail.tags || [];
    gameDetail.rating = newGameData.rating || gameDetail.rating || 0;
    gameDetail.early_access = newGameData.early_access ?? gameDetail.early_access ?? false;
    gameDetail.ratings_count = newGameData.ratings_count || gameDetail.ratings_count || 0;
    gameDetail.screenshots = this.normalizeScreenshots(newGameData.screenshots) || gameDetail.screenshots || [];
    gameDetail.store_links = newGameData.store_links || gameDetail.store_links || {};
    gameDetail.esrb_rating = newGameData.esrb_rating || gameDetail.esrb_rating;
    gameDetail.description = newGameData.description || gameDetail.description;
    gameDetail.website = newGameData.website || gameDetail.website;
  }

  /**
   * 🎯 RAWG 게임 데이터를 GameCalendarData 베이스로 매핑
   * mergeRawgAndSteamData와 processRawgOnlyData의 중복 제거용
   */
  static mapRawgGameToBaseData(
    rawgGame: any,
    details?: any,
    storeLinks?: any,
    video?: any
  ): GameCalendarData {
    return {
      // === RAWG 기본 정보 ===
      rawg_id: rawgGame.id,
      name: rawgGame.name,
      required_age: '', // Steam에서만 제공
      released: rawgGame.released,
      tba: rawgGame.tba,
      platforms: this.normalizePlatforms(rawgGame.platforms),
      genres: rawgGame.genres?.map((g: any) => g.name) || [],
      tags: this.normalizeRawgTags(rawgGame.tags),
      early_access:
        rawgGame.tags?.some(
          (t: any) => t.name.toLowerCase() === 'early access',
        ) || false,
      image: rawgGame.background_image || '',

      // === 인기도 및 미디어 ===
      added: rawgGame.added,
      added_by_status: rawgGame.added_by_status || {},
      screenshots: this.normalizeScreenshots(
        rawgGame.short_screenshots?.slice(1),
      ),

      // === 평점 및 등급 ===
      esrb_rating: rawgGame.esrb_rating?.name || null,
      rating: rawgGame.rating || 0,
      ratings_count: rawgGame.ratings_count || 0,
      description: rawgGame.description_raw || '',

      // === Steam 전용 데이터 (기본값) ===
      metacritic: undefined,
      categories: [],

      // === 개발사/배급사 정보 ===
      slug_name: details?.slugName || '',
      website: details?.website || '',
      developers: details?.developers || [],
      publishers: details?.publishers || [],

      // === 링크 및 미디어 ===
      store_links: storeLinks || {},
      video: video || undefined,

      // === Steam 리뷰 관련 (기본값) ===
      review_score: undefined,
      review_score_desc: undefined,
      total_positive: undefined,
      total_negative: undefined,
      total_reviews: undefined,

      // === Steam 통합 필드들 (기본값) ===
      steam_id: undefined,
      original_name: undefined,
      korea_name: undefined,
      steam_type: undefined,
      price: undefined,
      is_full_game: undefined,
      dlc_list: undefined,
      is_free: undefined,

      // === DLC 관련 (기본값) ===
      is_dlc: false,
      game_type: 'main_game',
      game_type_confidence: 0.8,
      game_type_reason: 'RAWG 기본 분류',

      // === 메타 정보 ===
      platform_type: this.determinePlatformType(this.normalizePlatforms(rawgGame.platforms)),
      steam_integrated: false,
    };
  }

  /**
   * 🔗 베이스 데이터에 Steam 데이터 병합
   * user_request.md 명세에 따른 Steam 우선순위 적용
   */
  static mergeWithSteamData(
    baseData: GameCalendarData,
    steamData: any,
    steamReviews?: any
  ): GameCalendarData {
    // Steam 리뷰 데이터 계산
    const reviewData = this.calculateReviewData(steamReviews);

    return {
      ...baseData,

      // === Steam 우선 데이터 ===
      required_age: steamData.steam_id?.toString() || baseData.required_age,
      image: steamData.image || baseData.image,
      screenshots:
        steamData.screenshots?.length > 0
          ? this.normalizeScreenshots(steamData.screenshots)
          : baseData.screenshots,
      website: steamData.website || baseData.website,
      developers:
        steamData.developers?.length > 0
          ? steamData.developers
          : baseData.developers,
      publishers:
        steamData.publishers?.length > 0
          ? steamData.publishers
          : baseData.publishers,

      // === Steam 전용 데이터 ===
      metacritic: undefined, // TODO: Steam appDetails에서 추출
      categories: this.normalizeSteamCategories(steamData.categories || []),

      // === Steam 리뷰 데이터 ===
      ...reviewData,

      // === Steam 통합 필드들 ===
      steam_id: steamData.steam_id,
      original_name: steamData.original_name,
      korea_name: steamData.korea_name,
      steam_type: steamData.steam_type,
      price: steamData.price || 'Unknown',
      is_full_game: steamData.is_full_game,
      dlc_list: steamData.dlc_list || [],
      is_free: steamData.is_free,

      // === 메타 정보 ===
      steam_integrated: true,
    };
  }

  /**
   * 🔧 플랫폼 정규화 (UnifiedGameService에서 이관)
   */
  static normalizePlatforms(platforms: any[]): string[] {
    if (!Array.isArray(platforms)) return [];

    return Array.from(
      new Set(
        platforms.map((p) => {
          // RAWG API에서 오는 platform 객체 구조: { platform: { slug: 'pc' } }
          const slug = p.platform?.slug || p;

          if (typeof slug !== 'string') return 'PC'; // 기본값을 PC로 설정
          const lowerSlug = slug.toLowerCase();

          // 플랫폼을 간단한 형태로 정규화
          if (lowerSlug.includes('playstation')) return 'PlayStation';
          if (lowerSlug.includes('xbox')) return 'Xbox';
          if (lowerSlug.includes('nintendo') || lowerSlug.includes('switch')) return 'Nintendo';
          if (['pc', 'macos', 'linux', 'windows'].some((os) => lowerSlug.includes(os)))
            return 'PC';

          // 매핑되지 않은 경우 PC로 기본 처리 (모바일 등은 현재 지원하지 않음)
          return 'PC';
        }).filter(Boolean), // 빈 값 제거
      ),
    );
  }

  /**
   * 🔧 유틸리티: 플랫폼 타입 결정
   * 중복된 플랫폼 타입 결정 로직 통합
   */
  static determinePlatformType(platforms: string[]): 'pc' | 'console' | 'mixed' {
    if (!Array.isArray(platforms)) return 'console';

    const platformSlugs = platforms.map(p => {
      // 안전한 문자열 처리: 객체인 경우 slug 추출, 문자열이 아닌 경우 기본값
      if (typeof p === 'object' && p !== null) {
        return (p as any).platform?.slug || (p as any).slug || 'unknown';
      }
      return typeof p === 'string' ? p.toLowerCase() : 'unknown';
    });

    const hasPc = platformSlugs.some(slug =>
      ['pc', 'macos', 'linux'].some(os => slug.includes(os))
    );

    const hasConsole = platformSlugs.some(slug =>
      ['playstation', 'xbox', 'nintendo', 'switch'].some(console =>
        slug.includes(console)
      )
    );

    if (hasPc && hasConsole) return 'mixed';
    if (hasPc) return 'pc';
    return 'console';
  }
}