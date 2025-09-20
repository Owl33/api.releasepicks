import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import axios from 'axios';
import { YouTubeService } from '../youtube/youtube.service';
import { Game } from '../entities/game.entity';
import { GameDetail } from '../entities/game-detail.entity';
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
    @InjectRepository(Game)
    private gameRepository: Repository<Game>,
    private dataSource: DataSource,
    private configService: ConfigService,
    private readonly youtubeService: YouTubeService,
  ) {
    this.baseUrl =
      this.configService.get<string>('RAWG_API_BASE_URL') ||
      'https://api.rawg.io/api';
    this.apiKey = this.configService.get<string>('RAWG_API_KEY') || '';
  }

  // 🚀 다중 페이지 월별 게임 데이터 조회
  async getMonthlyGames(month: string, maxGames: number = 200) {
    try {
      // 동적 날짜 범위 계산
      const [year, monthNum] = month.split('-');
      const startDate = `${year}-${monthNum.padStart(2, '0')}-01`;
      const lastDay = new Date(parseInt(year), parseInt(monthNum), 0).getDate();
      const endDate = `${year}-${monthNum.padStart(2, '0')}-${lastDay.toString().padStart(2, '0')}`;

      const allGames: any[] = [];
      let page = 1;
      let totalCount = 0;
      const pageSize = 40;

      while (allGames.length < maxGames) {
        this.logger.debug(`RAWG ${month} ${page}페이지 조회 중...`);

        const response = await axios.get(`${this.baseUrl}/games`, {
          params: {
            key: this.apiKey,
            dates: `${startDate},${endDate}`,
            page_size: pageSize,
            page: page,
            ordering: '-added',
          },
          timeout: 10000,
        });

        const { count, results, next } = response.data;
        totalCount = count;

        if (!results || results.length === 0) {
          this.logger.debug(`${page}페이지에서 데이터 없음, 종료`);
          break;
        }

        // added >= 3 필터링
        const filteredResults = results.filter((r) => r.added >= 3);
        allGames.push(...filteredResults);

        this.logger.debug(
          `${page}페이지: ${results.length}개 → 필터링 후 ${filteredResults.length}개 (누적: ${allGames.length}개)`
        );

        // 다음 페이지가 없으면 종료
        if (!next || allGames.length >= maxGames) {
          break;
        }

        page++;
      }

      this.logger.log(
        `RAWG ${month} 전체 조회 완료: ${allGames.length}개 수집 (총 ${totalCount}개 중, ${page}페이지)`
      );

      return {
        totalCount,
        games: allGames.slice(0, maxGames), // 최대 개수 제한
        page,
        pageSize: allGames.length,
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
        developers: results.developers?.map((d) => d.name) || [],
        publishers: results.publishers?.map((p) => p.name) || [],
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

  // 🆕 기존 데이터 과정을 활용한 월별 게임 데이터 저장
  async saveMonthlyGamesToDatabase(month: string): Promise<{
    saved: number;
    skipped: number;
    errors: number;
  }> {
    try {
      this.logger.log(`${month} 월별 게임 데이터 저장 시작`);

      // 1. 기존 데이터 처리 로직 활용 (다중 페이지)
      const rawgData = await this.getMonthlyGames(month, 200);
      const results = { saved: 0, skipped: 0, errors: 0 };

      // 2. 각 게임에 대해 가공 + 저장
      for (const game of rawgData.games as any[]) {
        try {
          // 기존 데이터 처리 로직 그대로 사용
          const calendarItem = this.convertRawgToCalendarItem(game);
          const storeLinks = await this.getStoreLinks(
            game.id,
            game.name,
            game.platforms,
          );
          const details = await this.getDetails(game.id);

          // DB에 저장 (분기 추가)
          await this.saveToDatabase(game, calendarItem, details, storeLinks);
          results.saved++;
          this.logger.debug(`게임 저장 완료: ${game.name}`);
        } catch (error) {
          if (error.code === '23505' || error.message?.includes('중복')) {
            results.skipped++;
            this.logger.debug(`게임 중복 건너뜀: ${game.name}`);
          } else {
            this.logger.error(`게임 저장 실패: ${game.name}`, error.message);
            results.errors++;
          }
        }
      }

      this.logger.log(
        `${month} 월별 게임 데이터 저장 완료: 저장 ${results.saved}개, 건너뜀 ${results.skipped}개, 오류 ${results.errors}개`,
      );

      return results;
    } catch (error) {
      this.logger.error(`월별 게임 데이터 저장 실패:`, error.message);
      throw new Error(`월별 게임 데이터 저장 실패: ${error.message}`);
    }
  }

  // 정리된 데이터를 DB에 저장
  private async saveToDatabase(
    rawgGame: any,
    calendarItem: any,
    details: any,
    storeLinks: any
  ) {
    // 중복 체크
    const existing = await this.gameRepository.findOne({
      where: { rawg_id: rawgGame.id }
    });
    if (existing) {
      throw { code: '23505', message: '중복 게임' };
    }

    return await this.dataSource.transaction(async manager => {
      // Game Entity 생성 및 저장
      const game = manager.create(Game, {
        rawg_id: rawgGame.id,
        name: rawgGame.name,
        released: new Date(rawgGame.released),
        platforms: calendarItem.platforms,
        genres: calendarItem.genres,
        added: rawgGame.added,
        image: rawgGame.background_image,
        developers: details.developers || [],
        publishers: details.publishers || [],
      });
      const savedGame = await manager.save(game);

      // GameDetail Entity 생성 및 저장
      const gameDetail = manager.create(GameDetail, {
        game_id: savedGame.id,
        slug_name: details.slugName,
        tags: calendarItem.tags,
        rating: calendarItem.rating,
        early_access: calendarItem.early_access,
        ratings_count: calendarItem.ratingsCount,
        screenshots: calendarItem.screenshots,
        store_links: storeLinks,
        esrb_rating: calendarItem.esrbRating,
        description: rawgGame.description_raw,
        website: details.website,
      });
      await manager.save(gameDetail);

      return savedGame;
    });
  }
}
