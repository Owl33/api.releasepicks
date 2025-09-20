import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { YouTubeService } from '../youtube/youtube.service';
import {
  GameCalendarItem,
  MonthlyCalendarResponse,
  GameDetailResponse,
  CalendarFilters,
  StoreLinks,
} from '../types/game-calendar.types';

@Injectable()
export class RawgService {
  private readonly logger = new Logger(RawgService.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(
    private configService: ConfigService,
    private readonly youtubeService: YouTubeService,
  ) {
    this.baseUrl =
      this.configService.get<string>('RAWG_API_BASE_URL') ||
      'https://api.rawg.io/api';
    this.apiKey = this.configService.get<string>('RAWG_API_KEY') || '';
  }

  // 🚀 FIXED: 동적 월별 게임 데이터 조회
  async getMonthlyGames(month: string, pageSize: number = 40) {
    try {
      // 동적 날짜 범위 계산
      const [year, monthNum] = month.split('-');
      const startDate = `${year}-${monthNum.padStart(2, '0')}-01`;

      // 월의 마지막 날 계산
      const lastDay = new Date(parseInt(year), parseInt(monthNum), 0).getDate();
      const endDate = `${year}-${monthNum.padStart(2, '0')}-${lastDay.toString().padStart(2, '0')}`;

      const response = await axios.get(`${this.baseUrl}/games`, {
        params: {
          key: this.apiKey,
          dates: `${startDate},${endDate}`, // 동적 날짜 범위
          page_size: 50,
          ordering: '-added', // 인기도 기준 정렬
        },
        timeout: 10000,
      });
      const { count, results } = response.data;

      this.logger.log(
        `RAWG ${month} 게임 조회 완료: ${results.length}개 (총 ${count}개),
     added filter로 ${results.filter((r) => r.added >= 3).length}개}`,
      );
      return {
        totalCount: count,
        games: results.filter((r) => r.added >= 3),
        page: 1,
        pageSize,
      };
    } catch (error) {
      this.logger.error('RAWG API 호출 실패:', error.message);
      throw new Error(`RAWG API 호출 실패: ${error.message}`);
    }
  }

  async getStore(gameId: number) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/games/${gameId}/stores`,
        {
          params: {
            key: this.apiKey,
          },
        },
      );
      return response.data;
    } catch (error) {
      this.logger.error('RAWG API 호출 실패:', error.message);
      throw new Error(`RAWG API 호출 실패: ${error.message}`);
    }
  }
  async getDevloper(gameId: number) {
    try {
      const response = await axios.get(`${this.baseUrl}/developers/${gameId}`, {
        params: {
          key: this.apiKey,
        },
      });

      return response.data;
    } catch (error) {
      this.logger.error('RAWG API 호출 실패:', error.message);
      throw new Error(`RAWG API 호출 실패: ${error.message}`);
    }
  }
  /**
   * 월별 게임 캘린더 데이터 조회 (완성된 형태)
   * RAWG API + 스토어 링크 통합 (YouTube는 외부에서 추가)
   */
  async getMonthlyCalendarData(
    month: string,
    filters: Partial<CalendarFilters> = {},
  ): Promise<{ games: GameCalendarItem[]; totalCount: number }> {
    try {
      this.logger.log(`${month} 월별 게임 캘린더 데이터 조회 시작`);

      // RAWG API에서 해당 월의 게임 데이터 조회
      const rawgData = await this.getMonthlyGames(month, 40);

      // 각 게임에 대해 스토어 링크와 YouTube 트레일러 정보 추가
      const enhancedGames = await Promise.all(
        rawgData.games.map(async (game) => {
          const calendarItem = this.convertRawgToCalendarItem(game);
          const storeLinks = await this.getStoreLinks(
            game.rawgId,
            game.name,
            game.platforms,
          );
          const details = await this.getDetails(game.rawgId);

          const video = await this.getYouTubeTrailer(game.name);
          return {
            ...calendarItem,
            ...details,
            storeLinks,
            video,
          };
        }),
      );

      // 필터링 및 정렬 적용
      const filteredGames = this.applyFilters(enhancedGames, filters);

      this.logger.log(
        `${month} 월별 게임 캘린더 데이터 조회 완료: ${filteredGames.length}개 게임`,
      );

      return {
        games: filteredGames,
        totalCount: rawgData.totalCount,
      };
    } catch (error) {
      this.logger.error(`월별 게임 캘린더 데이터 조회 실패:`, error.message);
      throw new Error(`월별 게임 캘린더 데이터 조회 실패: ${error.message}`);
    }
  }

  /**
   * RAWG 게임 데이터를 GameCalendarItem으로 변환
   */
  private convertRawgToCalendarItem(game: any): GameCalendarItem {
    return {
      rawgId: game.id,
      name: game.name,
      //To Be Announced true라면 출시일이 미정인 상태
      tba: game.tba,
      released: game.released,
      // 플랫폼 정보
      platforms: this.normalizePlatforms(game.platforms),
      // 스토어 정보
      stores: game.stores?.map((s) => s.store),
      // 장르 정보
      genres: game.genres?.map((g) => g.name),

      // 세부 태그 (더 구체적인 장르 정보)
      tags: (game.tags ?? [])
        .filter((t: any) => t.language === 'eng')
        .map((t: any) => t.name)
        .slice(0, 10),
      early_access: game?.tags?.some(
        (t) => t.name.toLowerCase() === 'early access',
      ),
      // 이미지 정보
      image: game.background_image,
      // add 정보 위시리스트 등
      added: game.added,
      added_by_status: game.added_by_status,
      screenshots: game.short_screenshots?.slice(1).map((item) => item.image), // 첫 번째는 메인 이미지와 동일
      // ESRB 등급
      esrbRating: game.esrb_rating?.name || null,

      // 🆕 평점 정보 활성화
      rating: game.rating,
      ratingsCount: game.ratings_count,
    };
  }

  /**
   * RAWG API를 통한 게임별 스토어 링크 조회
   */
  private async getStoreLinks(
    gameId: number,
    gameName: string,
    platforms: any,
  ): Promise<StoreLinks> {
    const STORE_KEYS = [
      'steam',
      'gog',
      'epic',
      'playstation',
      'xbox',
      'nintendo',
    ] as const;

    // RAWG store_id → StoreLinks 키 매핑
    const STORE_ID_MAP: Record<number, keyof StoreLinks> = {
      1: 'steam',
      5: 'gog',
      11: 'epic',
      // 필요 시 콘솔 스토어도 추가 가능
      // 2: "playstation",
      // 3: "xbox",
      // 4: "nintendo"
    };

    const links: StoreLinks = {};
    const encodedName = encodeURIComponent(gameName);
    const slugs: string[] = (platforms ?? []).map((p: any) =>
      typeof p === 'string' ? p.toLowerCase() : p.platform.slug.toLowerCase(),
    );

    try {
      // 1) RAWG 결과로 먼저 채우기
      const res = await this.getStore(gameId);
      res?.results?.forEach((r: any) => {
        const key = STORE_ID_MAP[r.store_id];
        if (key && !links[key] && r.url) links[key] = r.url;
      });

      // 2) 남은 스토어는 플랫폼 기반 fallback
      for (const s of STORE_KEYS) {
        if (links[s]) continue;

        if (s === 'steam' && slugs.includes('pc'))
          links.steam = `https://store.steampowered.com/search/?term=${encodedName}`;
        if (s === 'gog' && slugs.includes('pc'))
          links.gog = `https://www.gog.com/games?search=${encodedName}`;
        if (s === 'epic' && slugs.includes('pc'))
          links.epic = `https://store.epicgames.com/ko/expanded-search-results?q=${encodedName}`;
        if (s === 'playstation' && slugs.some((x) => x.includes('playstation')))
          links.playstation = `https://store.playstation.com/search/${encodedName}`;
        if (s === 'xbox' && slugs.some((x) => x.includes('xbox')))
          links.xbox = `https://www.xbox.com/ko-kr/Search/Results?q=${encodedName}`;
        if (
          s === 'nintendo' &&
          slugs.some((x) => x.includes('nintendo') || x.includes('switch'))
        )
          links.nintendo = `https://store.nintendo.co.kr/catalogsearch/result/?q=${encodedName}`;
      }

      return links;
    } catch (e: any) {
      this.logger.warn(`스토어 링크 조회 실패: ${gameName}`, e?.message ?? e);
      return {};
    }
  }

  /**
   * 게임명 기반 YouTube 트레일러 조회
   */
  private async getYouTubeTrailer(
    gameName: string,
  ): Promise<string | undefined> {
    try {
      this.logger.debug(`YouTube 트레일러 조회: ${gameName}`);

      // YouTubeService를 사용하여 실제 트레일러 검색
      const trailer = await this.youtubeService.getSimpleTrailer(gameName);
      return trailer;
    } catch (error) {
      this.logger.warn(
        `YouTube 트레일러 조회 실패: ${gameName}`,
        error.message,
      );
      return undefined;
    }
  }
  private async getDetails(gameId: number) {
    try {
      const response = await axios.get(`${this.baseUrl}/games/${gameId}`, {
        params: {
          key: this.apiKey,
        },
      });
      const results = response.data;
      return {
        slugName: results.slug,
        website: results.website,
        developers: results.developers.map((d) => d.name),
        publishers: results.publishers.map((p) => p.name),
      };
    } catch (error) {
      this.logger.error('RAWG API 호출 실패:', error.message);
      throw new Error(`RAWG API 호출 실패: ${error.message}`);
    }
  }

  /**
   * 필터링 및 정렬 적용
   */
  private applyFilters(
    games: GameCalendarItem[],
    filters: Partial<CalendarFilters>,
  ): GameCalendarItem[] {
    let filtered = [...games];

    // 최소 인기도 필터
    if (filters.minPopularity) {
      filtered = filtered.filter(
        (game) => game.added >= filters.minPopularity!,
      );
    }

    // 플랫폼 필터
    if (filters.platforms?.length) {
      filtered = filtered.filter((game) =>
        game.platforms.some((platform) =>
          filters.platforms!.some((filterPlatform) =>
            platform.toLowerCase().includes(filterPlatform.toLowerCase()),
          ),
        ),
      );
    }

    // 장르 필터
    if (filters.genres?.length) {
      filtered = filtered.filter((game) =>
        game.genres.some((genre) =>
          filters.genres!.some((filterGenre) =>
            genre.toLowerCase().includes(filterGenre.toLowerCase()),
          ),
        ),
      );
    }

    // 트레일러 필터
    if (filters.onlyWithTrailers) {
      filtered = filtered.filter((game) => game.video);
    }

    // 정렬
    const sortBy = filters.sortBy || 'popularity';
    const sortOrder = filters.sortOrder || 'desc';

    filtered.sort((a, b) => {
      let comparison = 0;

      switch (sortBy) {
        case 'releaseDate':
          comparison =
            new Date(a.released || '').getTime() -
            new Date(b.released || '').getTime();
          break;
        case 'popularity':
          comparison = a.added - b.added;
          break;
        case 'name':
          comparison = a.name.localeCompare(b.name);
          break;
        default:
          comparison = a.added - b.added;
      }

      return sortOrder === 'desc' ? -comparison : comparison;
    });

    return filtered;
  }

  private normalizePlatforms(platforms: any[]): string[] {
    return Array.from(
      new Set(
        (platforms ?? []).map((p) => {
          const slug = p.platform.slug;

          if (slug.includes('playstation')) return 'PlayStation';
          if (slug.includes('xbox')) return 'Xbox';
          if (slug.includes('nintendo')) return 'Nintendo';
          if (['pc', 'macos', 'linux'].some((os) => slug.includes(os)))
            return 'pc';

          return slug; // 매핑 안 되면 원래 slug 유지
        }),
      ),
    );
  }
}
