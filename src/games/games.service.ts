import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Game,
  GameRelease,
  ReleaseStatus,
  Platform,
  Store,
  Company,
  GameCompanyRole,
  GameType,
} from '../entities';
import {
  CalendarResponseDto,
  CalendarReleaseDto,
  StoreLinkDto,
} from './dto/calendar.dto';
import { GameDetailResponseDto, ReleaseInfo, DlcInfo } from './dto/detail.dto';
import { HighlightGameDto, HighlightsResponseDto } from './dto/highlights.dto';
import {
  GameFilterDto,
  FilteredGamesResponseDto,
  PaginationMeta,
  GameTypeFilter,
  SortBy,
  SortOrder,
} from './dto/filter.dto';

import {
  expandGenreSearchTerms,
  expandTagSearchTerms,
} from '../common/utils/genre-tag-normalizer.util';

interface ReleaseAggregationSummary {
  releaseIds: number[];
  platforms: Platform[];
  stores: Store[];
  storeLinks: StoreLinkDto[];
  comingSoon: boolean;
  currentPrice: number | null; // ✅ 추가: 페이지 내 대표 가격(스팀 우선)
  isFree: boolean; // ✅ 추가: 페이지 내 무료 여부(스팀 우선)
  hasPcPriority: boolean;
}

type AggregateWorkingState = CalendarReleaseDto & {
  hasPcPriority: boolean;
};

/**
 * 프론트엔드에서 사용하는 게임 조회 로직을 담당한다.
 * 복잡한 조인과 후처리를 여기서 캡슐화하여 컨트롤러를 단순하게 유지한다.
 */
@Injectable()
export class GamesService {
  constructor(
    @InjectRepository(Game)
    private readonly gameRepository: Repository<Game>,
    @InjectRepository(GameRelease)
    private readonly gameReleaseRepository: Repository<GameRelease>,

    @InjectRepository(GameCompanyRole)
    private readonly gcrRepository: Repository<GameCompanyRole>,
    @InjectRepository(Company)
    private readonly companyRepository: Repository<Company>,
  ) {}

  // async getCalendarByMonth(month: string): Promise<CalendarResponseDto> {
  //   const { start, end } = this.resolveMonthRange(month);

  //   const rows = await this.gameReleaseRepository
  //     .createQueryBuilder('release')
  //     .innerJoin('release.game', 'game')
  //     .leftJoin('game.details', 'detail')
  //     .select([
  //       'release.id AS release_id',
  //       'release.platform AS release_platform',
  //       'release.store AS release_store',
  //       'release.store_url AS release_store_url',
  //       'release.coming_soon AS release_coming_soon',
  //       'release.release_status AS release_status',
  //       'release.release_date_date AS release_date',
  //       'release.current_price_cents AS release_current_price_cents',
  //       'game.id AS game_id',
  //       'game.name AS game_name',
  //       'game.slug AS game_slug',
  //       'game.og_name as game_og_name',
  //       'game.popularity_score AS game_popularity_score',
  //       'detail.screenshots AS detail_screenshots',
  //       'detail.genres AS detail_genres',
  //       'detail.header_image as header_image',
  //     ])
  //     .where('release.release_date_date IS NOT NULL')
  //     .andWhere('release.release_date_date BETWEEN :start AND :end', {
  //       start,
  //       end,
  //     })
  //     .andWhere("game.game_type <> 'dlc'")
  //     .andWhere('game.popularity_score >= :minScore', { minScore: 40 })
  //     .orderBy('release.release_date_date', 'ASC')
  //     .addOrderBy('game.popularity_score', 'DESC')
  //     .getRawMany();

  //   const uniqueGameIds = new Set<number>();
  //   const uniqueDates = new Set<Date>();
  //   const aggregateMap = new Map<string, CalendarReleaseDto>();

  //   rows.forEach((row) => {
  //     const releaseDate = this.toDate(row.release_date);
  //     if (!releaseDate) {
  //       return;
  //     }

  //     const releaseDateKey = releaseDate;
  //     const gameId = Number(row.game_id);
  //     // ✅ 수정: 같은 게임은 출시일이 달라도 하나로 통합 (gameId만 사용)
  //     const aggregateKey = `${gameId}`;

  //     uniqueGameIds.add(gameId);
  //     uniqueDates.add(releaseDateKey);

  //     const genres = this.normalizeStringArray(row.detail_genres);
  //     const screenshots = this.normalizeStringArray(row.detail_screenshots);

  //     const platform = row.release_platform as Platform;
  //     const store = row.release_store as Store;
  //     const storeUrl = row.release_store_url ?? null;
  //     const popularityScore = this.toNumber(row.game_popularity_score);
  //     const comingSoon = Boolean(row.release_coming_soon);
  //     const releaseStatus = (row.release_status as ReleaseStatus) ?? null;
  //     const priceCents = row.release_current_price_cents
  //       ? Number(row.release_current_price_cents)
  //       : null;
  //     const currentPrice = priceCents ? priceCents / 100 : null;

  //     const existing = aggregateMap.get(aggregateKey);
  //     if (existing) {
  //       this.pushUnique(existing.releaseIds, Number(row.release_id));
  //       this.pushUnique(existing.platforms, platform);
  //       this.pushStoreLink(
  //         existing.stores,
  //         existing.storeLinks,
  //         store,
  //         storeUrl,
  //       );
  //       existing.comingSoon = existing.comingSoon || comingSoon;
  //       existing.releaseStatus = this.mergeReleaseStatus(
  //         existing.releaseStatus,
  //         releaseStatus,
  //       );
  //       existing.popularityScore = Math.max(
  //         existing.popularityScore,
  //         popularityScore,
  //       );
  //       existing.genres = this.mergeStringArrays(existing.genres, genres);
  //       // ✅ 수정: 가장 빠른 출시일 선택 (기존 날짜와 비교)
  //       if (
  //         existing.releaseDate === null ||
  //         releaseDate < existing.releaseDate
  //       ) {
  //         existing.releaseDate = releaseDate;
  //       }
  //       // 가격은 null이 아닌 값 우선, steam 스토어 우선
  //       if (existing.currentPrice === null && currentPrice !== null) {
  //         existing.currentPrice = currentPrice;
  //       } else if (
  //         currentPrice !== null &&
  //         store === 'steam' &&
  //         existing.currentPrice !== null
  //       ) {
  //         existing.currentPrice = currentPrice;
  //       }

  //       return;
  //     }

  //     const aggregate: CalendarReleaseDto = {
  //       releaseIds: [Number(row.release_id)],
  //       gameId,
  //       name: row.game_name,
  //       ogName: row.game_og_name,
  //       slug: row.game_slug,
  //       headerImage: row.header_image,
  //       platforms: [platform],
  //       stores: [store],
  //       storeLinks: [{ store, url: storeUrl }],
  //       releaseDate: releaseDateKey,
  //       comingSoon,
  //       releaseStatus,
  //       popularityScore,
  //       genres,
  //       developers: [],
  //       publishers: [],
  //       currentPrice,
  //     };

  //     aggregateMap.set(aggregateKey, aggregate);
  //   });

  //   // ✅ 개발사/퍼블리셔 정보 로드
  //   const gameIds = Array.from(uniqueGameIds);
  //   const companiesMap = await this.loadCompaniesBulk(gameIds);

  //   // ✅ aggregate에 회사 정보 추가
  //   aggregateMap.forEach((aggregate) => {
  //     const companies = companiesMap.get(aggregate.gameId);
  //     if (companies) {
  //       aggregate.developers = companies.developers;
  //       aggregate.publishers = companies.publishers;
  //     }
  //   });

  //   const data = Array.from(aggregateMap.values());

  //   return {
  //     month,
  //     range: {
  //       start: start,
  //       end: end,
  //     },
  //     count: {
  //       total: data.length,
  //       games: uniqueGameIds.size,
  //       days: uniqueDates.size,
  //     },
  //     data,
  //   };
  // }

  async getGameDetail(gameId: number): Promise<GameDetailResponseDto> {
    const game = await this.gameRepository.findOne({
      where: { id: gameId },
      relations: ['details', 'releases'],
    });

    if (!game) {
      throw new NotFoundException('요청한 게임을 찾을 수 없습니다.');
    }
    if (game.details && game.details.sexual) {
      throw new NotFoundException('요청한 게임을 찾을 수 없습니다.');
    }
    const { developers, publishers } = await this.loadCompaniesByRole(game.id);

    const releases: ReleaseInfo[] = (game.releases ?? []).map((release) => ({
      platform: release.platform,
      store: release.store,
      url: release.store_url,
      releaseDate: release.release_date_date,
      releaseDateRaw: release.release_date_raw,
    }));

    // 플랫폼 정보 추출 (중복 제거)
    const platforms: Platform[] = [];
    (game.releases ?? []).forEach((release) => {
      if (!platforms.includes(release.platform)) {
        platforms.push(release.platform);
      }
    });

    // 가격 정보 추출 (Steam 우선, 없으면 첫 번째 release, 없으면 null)
    const steamRelease = game.releases?.find((r) => r.store === 'steam');
    const priceRelease = steamRelease ?? game.releases?.[0];
    const currentPrice = priceRelease?.current_price_cents
      ? priceRelease.current_price_cents / 100
      : null;
    const isFree = steamRelease?.is_free ?? game.releases?.[0].is_free;
    // DLC 리스트 조회 (현재 게임이 부모인 DLC들)
    const dlcs: DlcInfo[] = await this.loadDlcList(game.steam_id, game.rawg_id);

    const detail = game.details;

    return {
      id: game.id,
      name: game.name,
      slug: game.slug,
      ogName: game.og_name,
      steamId: game.steam_id ?? null,
      rawgId: game.rawg_id ?? null,
      gameType: game.game_type,
      comingSoon: game.coming_soon,
      popularityScore: game.popularity_score,
      releaseDate: game.release_date_date,
      releaseStatus: game.release_status,
      followersCache: game.followers_cache,

      headerImage: detail ? detail.header_image : '',
      description: detail?.description ?? null,
      website: detail?.website ?? null,
      genres: detail?.genres ?? [],
      tags: detail?.tags ?? [],
      supportLanguages: detail?.support_languages ?? [],

      screenshots: detail?.screenshots ?? [],
      videoUrl: detail?.video_url ?? null,
      metacriticScore: detail?.metacritic_score ?? null,
      opencriticScore: detail?.opencritic_score ?? null,
      rawgAdded: detail?.rawg_added ?? null,
      totalReviews: detail?.total_reviews ?? null,
      reviewScoreDesc: detail?.review_score_desc ?? null,

      currentPrice,
      isFree,
      platforms,
      releases,
      dlcs,
      developers,
      publishers,
    };
  }

  async getHighlights(
    upcomingLimit: number,
    popularLimit: number,
  ): Promise<HighlightsResponseDto> {
    const now = new Date();
    const today = this.startOfDayUtc(now);
    const upperBound = this.addDays(today, 120);
    const shuffleSalt = now.toISOString().slice(0, 16); // 'YYYY-MM-DDTHH:MM'

    /**
     * UPCOMING
     * - 기간 내(오늘~+60일) 최소 출시일(min_release_date) 있는 게임만 선별
     * - details가 반드시 있는 게임만 (INNER JOIN)
     * - 완전 랜덤 ORDER BY RANDOM()
     */
    // 1) 기간 내 최소 출시일을 뽑는 서브쿼리
    const upcomingMinDateRows = await this.gameReleaseRepository
      .createQueryBuilder('release')
      .innerJoin('release.game', 'game')
      .select([
        'release.game_id AS game_id',
        'MIN(release.release_date_date) AS min_release_date',
      ])
      .where('release.release_date_date IS NOT NULL')
      .andWhere('release.release_date_date >= :today', { today })
      .andWhere('release.release_date_date <= :upper', { upper: upperBound })
      .andWhere("game.game_type <> 'dlc'")
      .groupBy('release.game_id')
      .getRawMany();

    const upcomingMinDateMap = new Map<number, Date>();
    upcomingMinDateRows.forEach((row) => {
      const gid = Number(row.game_id);
      const d = this.toDate(row.min_release_date);
      if (d) upcomingMinDateMap.set(gid, d);
    });

    const upcomingIds = Array.from(upcomingMinDateMap.keys());
    const upcomingDetailsRows = upcomingIds.length
      ? await this.gameRepository
          .createQueryBuilder('game')
          .innerJoin('game.details', 'detail', 'detail.sexual = false') // 디테일 있는 게임만!
          .select([
            'game.id AS game_id',
            'game.name AS game_name',
            'game.slug AS game_slug',
            'game.popularity_score AS game_popularity_score',
            'detail.header_image AS header_image',
            'detail.screenshots AS detail_screenshots',
          ])
          .where('game.id IN (:...ids)', { ids: upcomingIds })
          .orderBy('md5( (game.id)::text || :salt )', 'ASC')
          .setParameters({ salt: shuffleSalt })
          .limit(upcomingLimit)
          .getRawMany()
      : [];

    // upcoming + releaseSummary 합치기
    const upcomingPickedIds = upcomingDetailsRows.map((r) => Number(r.game_id));
    const upcomingReleaseSummary =
      await this.loadReleaseSummary(upcomingPickedIds);

    const upcoming: HighlightGameDto[] = upcomingDetailsRows.map((row) => {
      const gameId = Number(row.game_id);
      const releaseDate = upcomingMinDateMap.get(gameId) ?? null;
      const popularityScore = this.toNumber(row.game_popularity_score);
      const screenshots = this.normalizeStringArray(row.detail_screenshots);
      const summary = upcomingReleaseSummary.get(gameId);

      return {
        gameId,
        name: String(row.game_name ?? ''),
        slug: String(row.game_slug ?? ''),
        releaseDate: releaseDate,
        popularityScore,
        headerImage: row.header_image, // INNER JOIN으로 보장됨
        // posterImage: this.extractFirst(screenshots),
        daysUntilRelease: releaseDate
          ? this.calculateDaysBetween(releaseDate, today)
          : null,
        platforms: summary?.platforms ?? [],
        stores: summary?.stores ?? [],
        storeLinks: summary?.storeLinks ?? [],
        releaseIds: summary?.releaseIds ?? [],
        comingSoon: summary?.comingSoon ?? false,
        currentPrice: summary?.currentPrice ?? null, // ✅ 추가
        isFree: summary?.isFree ?? false, // ✅ 추가
      };
    });

    /**
     * POPULAR
     * - 인기도 > 0, DLC 제외
     * - details가 반드시 있는 게임만 (INNER JOIN)
     * - 완전 랜덤 ORDER BY RANDOM()
     */
    const popularRows = await this.gameRepository
      .createQueryBuilder('game')
      .innerJoin('game.details', 'detail', 'detail.sexual = false') // 디테일 있는 게임만!
      .select([
        'game.id AS game_id',
        'game.name AS game_name',
        'game.slug AS game_slug',
        'game.popularity_score AS game_popularity_score',
        'game.release_date_date AS game_release_date',
        'detail.header_image AS header_image',
        'detail.screenshots AS detail_screenshots',
      ])
      .where('game.popularity_score > 70')
      .andWhere("game.game_type <> 'dlc'")
      .orderBy('md5( (game.id)::text || :salt )', 'ASC')
      .setParameters({ salt: shuffleSalt })
      .limit(popularLimit)
      .getRawMany();

    const popularIds = popularRows.map((row) => Number(row.game_id));
    const popularReleaseSummary = await this.loadReleaseSummary(popularIds);

    const popular: HighlightGameDto[] = popularRows.map((row) => {
      const gameId = Number(row.game_id);
      const releaseDate = this.toDate(row.game_release_date);
      const screenshots = this.normalizeStringArray(row.detail_screenshots);
      const summary = popularReleaseSummary.get(gameId);

      return {
        gameId,
        name: String(row.game_name ?? ''),
        slug: String(row.game_slug ?? ''),
        releaseDate: releaseDate,
        popularityScore: this.toNumber(row.game_popularity_score),
        headerImage: row.header_image, // INNER JOIN으로 보장됨
        // posterImage: this.extractFirst(screenshots),
        daysUntilRelease: releaseDate
          ? this.calculateDaysBetween(releaseDate, today)
          : null,
        platforms: summary?.platforms ?? [],
        stores: summary?.stores ?? [],
        storeLinks: summary?.storeLinks ?? [],
        releaseIds: summary?.releaseIds ?? [],
        comingSoon: summary?.comingSoon ?? false,
        currentPrice: summary?.currentPrice ?? null, // ✅ 추가
        isFree: summary?.isFree ?? false, // ✅ 추가
      };
    });

    return {
      generatedAt: now.toISOString(),
      upcoming,
      popular,
    };
  }

  private async loadReleaseSummary(
    gameIds: number[],
  ): Promise<Map<number, ReleaseAggregationSummary>> {
    if (!gameIds.length) {
      return new Map();
    }

    const rows = await this.gameReleaseRepository
      .createQueryBuilder('release')
      .select([
        'release.game_id AS game_id',
        'release.id AS release_id',
        'release.platform AS release_platform',
        'release.store AS release_store',
        'release.store_url AS release_store_url',
        'release.coming_soon AS release_coming_soon',
        'release.is_free AS release_is_free', // ✅ 추가
        'release.current_price_cents AS release_current_price_cents', // ✅ 추가
      ])
      .where('release.game_id IN (:...ids)', { ids: gameIds })
      .getRawMany();

    const map = new Map<number, ReleaseAggregationSummary>();

    rows.forEach((row) => {
      const gameId = Number(row.game_id);
      const platform = row.release_platform as Platform;
      const store = row.release_store as Store;
      const storeUrl = row.release_store_url ?? null;
      const comingSoon = Boolean(row.release_coming_soon);

      const summary = map.get(gameId) ?? {
        releaseIds: [],
        platforms: [],
        stores: [],
        storeLinks: [],
        comingSoon: false,
        currentPrice: null, // ✅ 초기값
        isFree: false, // ✅ 초기값
        hasPcPriority: false,
      };

      this.pushUnique(summary.releaseIds, Number(row.release_id));
      this.pushUnique(summary.platforms, platform);
      this.pushStoreLink(summary.stores, summary.storeLinks, store, storeUrl);
      summary.comingSoon = summary.comingSoon || comingSoon;
      const priceCents =
        row.release_current_price_cents != null
          ? Number(row.release_current_price_cents)
          : null;
      const currentPrice = priceCents != null ? priceCents / 100 : null; // ✅ cents → 원화/달러 등
      const isPcPlatform = platform === Platform.PC;
      const freeFlag = row.release_is_free === true;

      if (isPcPlatform) {
        summary.hasPcPriority = true;
        summary.currentPrice = currentPrice;
        if (row.release_is_free !== null && row.release_is_free !== undefined) {
          summary.isFree = freeFlag;
        }
      } else if (!summary.hasPcPriority) {
        if (currentPrice !== null) {
          summary.currentPrice = currentPrice;
        }
        if (freeFlag) {
          summary.isFree = true;
        }
      } else if (summary.hasPcPriority && freeFlag) {
        summary.isFree = true;
      }

      map.set(gameId, summary);
    });

    return map;
  }

  private async loadDlcList(
    steamId: number | null,
    rawgId: number | null,
  ): Promise<DlcInfo[]> {
    if (!steamId && !rawgId) {
      return [];
    }

    const query = this.gameRepository.createQueryBuilder('game');

    query.where("game.game_type = 'dlc'");

    const conditions: string[] = [];
    const parameters: Record<string, number> = {};

    if (steamId) {
      conditions.push('game.parent_steam_id = :steamId');
      parameters.steamId = steamId;
    }

    if (rawgId) {
      conditions.push('game.parent_rawg_id = :rawgId');
      parameters.rawgId = rawgId;
    }

    if (conditions.length > 0) {
      query.andWhere(`(${conditions.join(' OR ')})`, parameters);
    }

    query
      .select(['game.name AS name', 'game.release_date_date AS release_date'])
      .orderBy('game.release_date_date', 'ASC');

    const rows = await query.getRawMany();

    return rows.map((row) => ({
      name: String(row.name ?? ''),
      releaseDate: this.toDate(row.release_date),
    }));
  }
  private async loadCompaniesByRole(gameId: number): Promise<{
    developers: { id: number; name: string }[];
    publishers: { id: number; name: string }[];
  }> {
    const rows = await this.gcrRepository
      .createQueryBuilder('gcr')
      .innerJoin('gcr.company', 'c')
      .select([
        'c.id AS company_id',
        'c.name AS company_name',
        'gcr.role AS role',
      ])
      .where('gcr.game_id = :gameId', { gameId })
      .getRawMany();

    const seenDev = new Set<number>();
    const seenPub = new Set<number>();
    const developers: { id: number; name: string }[] = [];
    const publishers: { id: number; name: string }[] = [];

    for (const r of rows) {
      const id = Number(r.company_id);
      const name = String(r.company_name ?? '');

      if (r.role === 'developer') {
        if (!seenDev.has(id)) {
          seenDev.add(id);
          developers.push({ id, name });
        }
      } else if (r.role === 'publisher') {
        if (!seenPub.has(id)) {
          seenPub.add(id);
          publishers.push({ id, name });
        }
      }
    }

    return { developers, publishers };
  }

  /**
   * 여러 게임의 개발사/퍼블리셔 정보를 한 번에 로드
   * @param gameIds 게임 ID 배열
   * @returns Map<gameId, { developers: string[], publishers: string[] }>
   */
  private async loadCompaniesBulk(
    gameIds: number[],
  ): Promise<Map<number, { developers: string[]; publishers: string[] }>> {
    if (!gameIds.length) {
      return new Map();
    }

    // ✅ 성능 최적화: 대량 ID 조회 시 IN 절 최적화를 위해 배치 처리
    const maxBatchSize = 500; // PostgreSQL IN 절 최적 크기
    const batches: number[][] = [];
    for (let i = 0; i < gameIds.length; i += maxBatchSize) {
      batches.push(gameIds.slice(i, i + maxBatchSize));
    }

    const allRows = await Promise.all(
      batches.map((batch) =>
        this.gcrRepository
          .createQueryBuilder('gcr')
          .innerJoin('gcr.company', 'c')
          .select([
            'gcr.game_id AS game_id',
            'c.name AS company_name',
            'gcr.role AS role',
          ])
          .where('gcr.game_id IN (:...ids)', { ids: batch })
          .getRawMany(),
      ),
    );

    const rows = allRows.flat();

    const map = new Map<
      number,
      { developers: string[]; publishers: string[] }
    >();

    rows.forEach((r) => {
      const gameId = Number(r.game_id);
      const name = String(r.company_name ?? '');

      let entry = map.get(gameId);
      if (!entry) {
        entry = { developers: [], publishers: [] };
        map.set(gameId, entry);
      }

      if (r.role === 'developer') {
        if (!entry.developers.includes(name)) {
          entry.developers.push(name);
        }
      } else if (r.role === 'publisher') {
        if (!entry.publishers.includes(name)) {
          entry.publishers.push(name);
        }
      }
    });

    return map;
  }

  private resolveMonthRange(month: string): { start: Date; end: Date } {
    const matched = month.match(/^(\d{4})-(0[1-9]|1[0-2])$/);
    if (!matched) {
      throw new BadRequestException(
        'month 파라미터는 YYYY-MM 형식이어야 합니다.',
      );
    }

    const year = Number(matched[1]);
    const monthIndex = Number(matched[2]) - 1;

    const start = new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0));
    const end = new Date(Date.UTC(year, monthIndex + 1, 0, 23, 59, 59, 999));

    return { start, end };
  }

  private startOfDayUtc(date: Date): Date {
    return new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
  }

  private addDays(date: Date, days: number): Date {
    const result = new Date(date.getTime());
    result.setUTCDate(result.getUTCDate() + days);
    return result;
  }

  private calculateDaysBetween(target: Date, base: Date): number {
    const targetStart = this.startOfDayUtc(target);
    const baseStart = this.startOfDayUtc(base);
    const diff = targetStart.getTime() - baseStart.getTime();
    return Math.max(Math.floor(diff / (1000 * 60 * 60 * 24)), 0);
  }

  private pickPrimaryRelease(
    releaseDate: Date | null,
    releaseStatus: ReleaseStatus | null,
    comingSoon: boolean,
  ): {
    date: Date | null;
    status: ReleaseStatus | null;
    comingSoon: boolean;
  } {
    return {
      date: releaseDate,
      status: releaseStatus,
      comingSoon,
    };
  }

  private pushUnique<T>(array: T[], value: T): void {
    if (!array.includes(value)) {
      array.push(value);
    }
  }

  private pushStoreLink(
    stores: Store[],
    storeLinks: StoreLinkDto[],
    store: Store,
    url: string | null,
  ): void {
    const existingIndex = stores.indexOf(store);
    if (existingIndex >= 0) {
      const link = storeLinks[existingIndex];
      if (link && !link.url && url) {
        storeLinks[existingIndex] = { store, url };
      }
      return;
    }

    stores.push(store);
    storeLinks.push({ store, url });
  }

  private mergeStringArrays(target: string[], source: string[]): string[] {
    if (!source.length) {
      return target;
    }
    const seen = new Set(target);
    source.forEach((item) => {
      if (!seen.has(item)) {
        seen.add(item);
        target.push(item);
      }
    });
    return target;
  }

  private mergeReleaseStatus(
    current: ReleaseStatus | null,
    incoming: ReleaseStatus | null,
  ): ReleaseStatus | null {
    if (!incoming) {
      return current;
    }
    if (!current) {
      return incoming;
    }
    const priority: Record<ReleaseStatus, number> = {
      [ReleaseStatus.CANCELLED]: -1,
      [ReleaseStatus.TBA]: 0,
      [ReleaseStatus.COMING_SOON]: 1,
      [ReleaseStatus.EARLY_ACCESS]: 2,
      [ReleaseStatus.RELEASED]: 3,
    };

    return priority[incoming] > priority[current] ? incoming : current;
  }

  private toDate(value: unknown): Date | null {
    if (!value) {
      return null;
    }
    if (value instanceof Date) {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    return null;
  }

  private toNumber(value: unknown, fallback = 0): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private normalizeStringArray(value: unknown): string[] {
    if (value === null || value === undefined) {
      return [];
    }
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === 'string');
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        const content = trimmed.slice(1, -1);
        if (!content) {
          return [];
        }
        return content
          .split(',')
          .map((item) => item.trim())
          .map((item) => item.replace(/^"|"$/g, '').replace(/\\"/g, '"'))
          .filter((item) => item.length > 0);
      }
      return trimmed.length > 0 ? [trimmed] : [];
    }
    return [];
  }

  private extractFirst(values: string[]): string | null {
    for (const value of values) {
      if (typeof value === 'string' && value.trim().length > 0) {
        return value;
      }
    }
    return null;
  }

  /**
   * 모든 게임 조회 (필터 + 페이지네이션)
   */
  async getAllGames(filters: GameFilterDto): Promise<FilteredGamesResponseDto> {
    // --------------------------
    // 0) 페이지네이션 파라미터
    // --------------------------
    const page = filters.page ?? 1;
    const pageSize = filters.pageSize ?? 20;
    const skip = (page - 1) * pageSize;

    // ---------------------------------
    // 1) 공통 베이스 쿼리(필터만 적용)
    //    - 여기서는 SELECT를 최소화하고,
    //      모든 필터와 JOIN 조건만 걸어줍니다.
    // ---------------------------------
    const base = this.gameReleaseRepository
      .createQueryBuilder('release')
      .innerJoin('release.game', 'game')
      .leftJoin('game.details', 'detail');
    base.andWhere('(detail.id IS NULL OR detail.sexual = false)');

    // ✅ 타입 안전성 강화: GameTypeFilter 사용
    const gameTypeFilter: GameTypeFilter = filters.gameType ?? 'game';
    if (gameTypeFilter === 'game') {
      base.andWhere("game.game_type <> 'dlc'");
    } else if (gameTypeFilter === 'dlc') {
      base.andWhere("game.game_type = 'dlc'");
    }

    // 인기도 필터 (기본: 40 ~ 100)
    const popularityScore = filters.popularityScore ?? 40;
    base.andWhere('game.popularity_score >= :popularityScore', {
      popularityScore,
    });

    // 날짜 범위 필터 (release.release_date_date)
    if (filters.startDate || filters.endDate) {
      const start = this.parseDateLoose(filters.startDate ?? null);
      const endRaw = this.parseDateLoose(filters.endDate ?? null);
      const end = endRaw ? this.endOfDayUtc(endRaw) : null;

      if (start && end) {
        base.andWhere('release.release_date_date BETWEEN :start AND :end', {
          start,
          end,
        });
      } else if (start) {
        base.andWhere('release.release_date_date >= :start', { start });
      } else if (end) {
        base.andWhere('release.release_date_date <= :end', { end });
      }
    }

    // 미출시만
    if (filters.onlyUpcoming) {
      base.andWhere('(release.coming_soon = true OR game.coming_soon = true)');
    }

    // 장르 OR (한글 입력 시 한글+영문 모두 검색)
    if (filters.genres && filters.genres.length > 0) {
      // 한글 → 한글+영문 검색어 확장
      const expandedGenres = expandGenreSearchTerms(filters.genres);

      const genreConds = expandedGenres
        .map((_, i) => `:genre${i} = ANY(detail.genres)`)
        .join(' OR ');
      const genreParams = expandedGenres.reduce(
        (acc, g, i) => {
          acc[`genre${i}`] = g;
          return acc;
        },
        {} as Record<string, string>,
      );
      base.andWhere(`(${genreConds})`, genreParams);
    }

    // 태그 OR (한글 입력 시 한글+영문 모두 검색)
    if (filters.tags && filters.tags.length > 0) {
      // 한글 → 한글+영문 검색어 확장
      const expandedTags = expandTagSearchTerms(filters.tags);

      const tagConds = expandedTags
        .map((_, i) => `:tag${i} = ANY(detail.tags)`)
        .join(' OR ');
      const tagParams = expandedTags.reduce(
        (acc, t, i) => {
          acc[`tag${i}`] = t;
          return acc;
        },
        {} as Record<string, string>,
      );
      base.andWhere(`(${tagConds})`, tagParams);
    }

    // 개발사 OR (JOIN)
    if (filters.developers && filters.developers.length > 0) {
      base
        .innerJoin(
          'game.company_roles',
          'dev_gcr',
          "dev_gcr.role = 'developer'",
        )
        .innerJoin('dev_gcr.company', 'dev_company');

      const devConds = filters.developers
        .map((_, i) => `dev_company.name ILIKE :dev${i}`)
        .join(' OR ');
      const devParams = filters.developers.reduce(
        (acc, d, i) => {
          acc[`dev${i}`] = `%${d}%`;
          return acc;
        },
        {} as Record<string, string>,
      );
      base.andWhere(`(${devConds})`, devParams);
    }

    // 퍼블리셔 OR (JOIN)
    if (filters.publishers && filters.publishers.length > 0) {
      base
        .innerJoin(
          'game.company_roles',
          'pub_gcr',
          "pub_gcr.role = 'publisher'",
        )
        .innerJoin('pub_gcr.company', 'pub_company');

      const pubConds = filters.publishers
        .map((_, i) => `pub_company.name ILIKE :pub${i}`)
        .join(' OR ');
      const pubParams = filters.publishers.reduce(
        (acc, p, i) => {
          acc[`pub${i}`] = `%${p}%`;
          return acc;
        },
        {} as Record<string, string>,
      );
      base.andWhere(`(${pubConds})`, pubParams);
    }

    // ---------------------------------------------------------
    // ⚠️ Platform 필터 적용 전 베이스 쿼리 저장
    //    - pageGameIds 추출에는 platform 필터 사용
    //    - 하지만 실제 데이터 조회 시에는 해당 게임의 모든 플랫폼 정보 가져오기
    // ---------------------------------------------------------
    // 플랫폼 OR (release.platform)
    if (filters.platforms && filters.platforms.length > 0) {
      base.andWhere('release.platform IN (:...platforms)', {
        platforms: filters.platforms,
      });
    }

    // 리뷰 점수(desc) 필터
    if (filters.reviewScoreDesc && filters.reviewScoreDesc.length > 0) {
      const normalized = Array.from(
        new Set(
          filters.reviewScoreDesc
            .map((v) => (typeof v === 'string' ? v.trim() : ''))
            .filter((v) => v.length > 0),
        ),
      );

      if (normalized.length > 0) {
        const values: string[] = [];
        let includeNone = false;

        normalized.forEach((value) => {
          if (value.toLowerCase() === 'all') {
            return;
          }
          if (value.toLowerCase() === 'none') {
            includeNone = true;
            return;
          }
          values.push(value);
        });

        const conditions: string[] = [];
        const params: Record<string, unknown> = {};

        if (values.length > 0) {
          conditions.push(
            '(detail.review_score_desc IN (:...reviewScoreValues) OR release.review_score_desc IN (:...reviewScoreValues))',
          );
          params.reviewScoreValues = values;
        }

        if (includeNone) {
          conditions.push(
            "((detail.review_score_desc IS NULL OR detail.review_score_desc = '') AND NOT EXISTS (SELECT 1 FROM game_releases gr WHERE gr.game_id = game.id AND gr.review_score_desc IS NOT NULL AND gr.review_score_desc <> ''))",
          );
        }

        if (conditions.length > 0) {
          const whereClause =
            conditions.length === 1
              ? conditions[0]
              : `(${conditions.join(' OR ')})`;
          base.andWhere(whereClause, params);
        }
      }
    }

    // ---------------------------------------------------------
    // 2) "게임 단위로" 그룹핑하여 페이징 기준(키셋) 만들기
    //    - sortBy 에 따라 대표 컬럼을 선택
    //    - releaseDate 정렬 시 MIN(release_date_date) 사용 + NULLS LAST
    //    - popularity 정렬 시 MAX(game.popularity_score)
    //    - name 정렬 시 game.name
    //    - 항상 안정적인 tie-breaker (game.id ASC) 추가
    // ---------------------------------------------------------
    // ✅ 타입 안전성 강화: SortBy, SortOrder 사용
    const sortBy: SortBy = filters.sortBy ?? 'releaseDate';
    const sortOrder: SortOrder = (
      filters.sortOrder ?? 'ASC'
    ).toUpperCase() as SortOrder;

    const grouped = base
      .clone()
      .select('game.id', 'game_id')
      .addSelect('MIN(release.release_date_date)', 'first_release_date')
      .addSelect('MAX(game.popularity_score)', 'max_popularity') // ✅ 집계 함수로 명시화
      .addSelect('MAX(game.name)', 'game_name') // ✅ 집계 함수로 명시화
      .groupBy('game.id'); // ✅ PK만 GROUP BY (PostgreSQL 최적화)

    // 정렬
    if (sortBy === 'releaseDate') {
      // 날짜 정렬(오름/내림) + NULLS LAST + 보조 정렬(popularity desc) + 최종 tie-breaker
      grouped
        .orderBy('MIN(release.release_date_date)', sortOrder, 'NULLS LAST')
        .addOrderBy('MAX(game.popularity_score)', 'DESC') // ✅ 집계 함수 사용
        .addOrderBy('game.id', 'ASC');
    } else if (sortBy === 'popularity') {
      grouped
        .orderBy('MAX(game.popularity_score)', sortOrder) // ✅ 집계 함수 사용
        .addOrderBy('MIN(release.release_date_date)', 'ASC', 'NULLS LAST')
        .addOrderBy('game.id', 'ASC');
    } else {
      // name
      grouped
        .orderBy('MAX(game.name)', sortOrder) // ✅ 집계 함수 사용
        .addOrderBy('MIN(release.release_date_date)', 'ASC', 'NULLS LAST')
        .addOrderBy('game.id', 'ASC');
    }

    // 총 개수(고유 게임 수) — DISTINCT count가 가장 정확/저렴
    const countQuery = base.clone().select('COUNT(DISTINCT game.id)', 'cnt');
    const countRow = await countQuery.getRawOne<{ cnt: string }>();
    const total = Number(countRow?.cnt ?? 0);

    // 페이지 대상 game_id 추출
    const pageGameRows = await grouped
      .clone()
      .offset(skip)
      .limit(pageSize)
      .getRawMany();
    const pageGameIds = pageGameRows.map((r) => Number(r.game_id));

    // 아무것도 없으면 빠르게 리턴
    if (pageGameIds.length === 0) {
      const pagination: PaginationMeta = {
        currentPage: page,
        pageSize,
        totalItems: total,
        totalPages: Math.ceil(total / pageSize),
        hasNextPage: page < Math.ceil(total / pageSize),
        hasPreviousPage: page > 1,
      };
      return {
        filters: {
          month: filters.month,
          dateRange:
            filters.startDate && filters.endDate
              ? { start: filters.startDate, end: filters.endDate }
              : undefined,
          genres: filters.genres,
          tags: filters.tags,
          developers: filters.developers,
          publishers: filters.publishers,
          platforms: filters.platforms,
          gameType: gameTypeFilter,
          reviewScoreDesc: filters.reviewScoreDesc,
        },
        pagination,
        count: { total, filtered: 0 },
        data: [],
      };
    }

    // ---------------------------------------------------------
    // 3) 이 페이지의 게임들에 대한 "모든 릴리스 행"을 다시 로드
    //    ⚠️ pageGameIds의 순서를 유지해야 함 - 정렬 순서가 유지되어야 함
    //    ✅ 성능 최적화: 최대 릴리스 개수 제한 (pageSize * 10)
    // ---------------------------------------------------------
    const maxReleases = Math.min(pageSize * 10, 2000); // 페이지당 최대 2000개 릴리스
    const rows = await this.gameReleaseRepository
      .createQueryBuilder('release')
      .innerJoin('release.game', 'game')
      .leftJoin('game.details', 'detail')
      .select([
        'release.id AS release_id',
        'release.platform AS release_platform',
        'release.store AS release_store',
        'release.store_url AS release_store_url',
        'release.is_free AS release_is_free',
        'release.coming_soon AS release_coming_soon',
        'release.release_status AS release_status',
        'release.release_date_date AS release_date',
        'release.release_date_raw AS release_date_raw',
        'release.current_price_cents AS release_current_price_cents',

        'game.id AS game_id',
        'game.name AS game_name',
        'game.slug AS game_slug',
        'game.og_name as game_og_name',
        'game.popularity_score AS game_popularity_score',
        'game.coming_soon AS game_coming_soon',
        'game.game_type AS game_type',

        'detail.screenshots AS detail_screenshots',
        'detail.genres AS detail_genres',
        'detail.review_score_desc AS detail_review_score_desc',
        'detail.header_image as header_image',
        'release.review_score_desc AS release_review_score_desc',
      ])
      .where('game.id IN (:...ids)', { ids: pageGameIds })
      .andWhere('(detail.id IS NULL OR detail.sexual = false)')
      .limit(maxReleases) // ✅ 대량 데이터 방어: 최대 릴리스 개수 제한
      .getRawMany();

    // ---------------------------------------------------------
    // 4) 집계 (기존 로직 유지)
    // ---------------------------------------------------------
    const gameIdsSet = new Set<number>();
    const aggregateMap = new Map<string, AggregateWorkingState>();

    for (const row of rows) {
      const gameId = Number(row.game_id);
      const aggregateKey = `${gameId}`;

      const releaseDate = this.toDate(row.release_date);
      const comingSoon =
        row.release_coming_soon === true
          ? true
          : row.game_coming_soon === true
            ? true
            : false;

      const releaseDateRaw = row.release_date_raw ?? null;

      gameIdsSet.add(gameId);

      const genres = this.normalizeStringArray(row.detail_genres);
      // const screenshots = this.normalizeStringArray(row.detail_screenshots); // 필요 시 사용
      const platform = row.release_platform as Platform;
      const store = row.release_store as Store;
      const storeUrl = row.release_store_url ?? null;
      const popularityScore = this.toNumber(row.game_popularity_score);
      const releaseStatus = (row.release_status as ReleaseStatus) ?? null;
      const priceCents = row.release_current_price_cents
        ? Number(row.release_current_price_cents)
        : null;
      const currentPrice = priceCents ? priceCents / 100 : null;
      const isFreeFlag = row.release_is_free === true;
      const isPcPlatform = platform === Platform.PC;
      const detailReview = this.sanitizeReviewScoreDesc(
        row.detail_review_score_desc,
      );
      const releaseReview = this.sanitizeReviewScoreDesc(
        row.release_review_score_desc,
      );
      const existing = aggregateMap.get(aggregateKey);
      if (existing) {
        this.pushUnique(existing.releaseIds, Number(row.release_id));
        this.pushUnique(existing.platforms, platform);
        this.pushStoreLink(
          existing.stores,
          existing.storeLinks,
          store,
          storeUrl,
        );

        existing.comingSoon = existing.comingSoon || comingSoon;
        existing.releaseStatus = this.mergeReleaseStatus(
          existing.releaseStatus,
          releaseStatus,
        );
        existing.popularityScore = Math.max(
          existing.popularityScore,
          popularityScore,
        );
        existing.genres = this.mergeStringArrays(existing.genres, genres);

        // releaseDate: 가장 이른 정상 날짜를 유지 (기존 정책과 동일)
        if (!existing.releaseDate && releaseDate) {
          existing.releaseDate = releaseDate;
        }

        // raw 보완(정상 날짜 없을 때 우선 채움)
        if ((existing as any).releaseDateRaw == null && releaseDateRaw) {
          (existing as any).releaseDateRaw = releaseDateRaw;
        }

        if (isFreeFlag) {
          existing.isFree = true;
        }

        if (isPcPlatform) {
          existing.hasPcPriority = true;
          existing.currentPrice = currentPrice;
        } else if (!existing.hasPcPriority) {
          if (existing.currentPrice === null && currentPrice !== null) {
            existing.currentPrice = currentPrice;
          } else if (
            currentPrice !== null &&
            store === Store.STEAM &&
            existing.currentPrice !== null
          ) {
            existing.currentPrice = currentPrice;
          }
        }
        if (detailReview) {
          existing.reviewScoreDesc = detailReview;
        } else if (!existing.reviewScoreDesc && releaseReview) {
          existing.reviewScoreDesc = releaseReview;
        }
        continue;
      }

      const aggregate: AggregateWorkingState = {
        releaseIds: [Number(row.release_id)],
        gameId,
        name: row.game_name,
        ogName: row.game_og_name,
        slug: row.game_slug,
        headerImage: row.header_image,
        platforms: [platform],
        stores: [store],
        storeLinks: [{ store, url: storeUrl }],
        releaseDate, // (null 가능)
        releaseDateRaw, // ✅ 추가됨
        comingSoon,
        releaseStatus,
        popularityScore,
        genres,
        developers: [],
        publishers: [],
        currentPrice,
        isFree: isFreeFlag,
        gameType: (row.game_type as GameType) ?? GameType.GAME,
        reviewScoreDesc: detailReview ?? releaseReview ?? null,
        hasPcPriority: isPcPlatform,
      };

      if (
        !aggregate.hasPcPriority &&
        store === Store.STEAM &&
        currentPrice !== null
      ) {
        aggregate.currentPrice = currentPrice;
      }

      aggregateMap.set(aggregateKey, aggregate);
    }

    // ---------------------------------------------------------
    // 5) 개발사/퍼블리셔 일괄 로드 + 주입
    // ---------------------------------------------------------
    const gameIds = Array.from(gameIdsSet);
    const companiesMap = await this.loadCompaniesBulk(gameIds);
    aggregateMap.forEach((agg) => {
      const companies = companiesMap.get(agg.gameId);
      if (companies) {
        agg.developers = companies.developers;
        agg.publishers = companies.publishers;
      }
    });

    // ---------------------------------------------------------
    // 6) pageGameIds 순서대로 데이터 정렬 (정렬 순서 유지)
    // ---------------------------------------------------------
    const gameIdOrderMap = new Map<number, number>();
    pageGameIds.forEach((id, index) => {
      gameIdOrderMap.set(id, index);
    });

    const orderedAggregates = Array.from(aggregateMap.values()).sort((a, b) => {
      const orderA = gameIdOrderMap.get(a.gameId) ?? Number.MAX_SAFE_INTEGER;
      const orderB = gameIdOrderMap.get(b.gameId) ?? Number.MAX_SAFE_INTEGER;
      return orderA - orderB;
    });
    const data = orderedAggregates.map(({ hasPcPriority, ...rest }) => rest);

    // ---------------------------------------------------------
    // 7) 페이지네이션 메타 (고유 게임 수 기준)
    // ---------------------------------------------------------
    const totalPages = Math.ceil(total / pageSize);
    const pagination: PaginationMeta = {
      currentPage: page,
      pageSize,
      totalItems: total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPreviousPage: page > 1,
    };

    return {
      filters: {
        month: filters.month,
        dateRange:
          filters.startDate && filters.endDate
            ? { start: filters.startDate, end: filters.endDate }
            : undefined,
        genres: filters.genres,
        tags: filters.tags,
        developers: filters.developers,
        publishers: filters.publishers,
        platforms: filters.platforms,
        gameType: gameTypeFilter,
        reviewScoreDesc: filters.reviewScoreDesc,
      },
      pagination,
      count: {
        total, // 전체 고유 게임 수
        filtered: data.length, // 이 페이지에서 반환된 개수
      },
      data,
    };
  }

  private sanitizeReviewScoreDesc(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private parseDateLoose(value?: string | Date | null): Date | null {
    if (!value) return null;

    if (value instanceof Date) {
      return isNaN(value.getTime()) ? null : value;
    }

    // 문자열인 경우
    const s = String(value).trim();
    // 1) 정규 패턴 우선: YYYY-MM-DD
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) {
      const year = Number(m[1]);
      const month = Number(m[2]); // 1~12
      const day = Number(m[3]); // 1~31 (이 값이 과할 수 있음)
      if (month < 1 || month > 12) return null;

      // 그 달의 마지막 날 계산
      const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate(); // month는 1-12, 0일 = 지난달 마지막날
      const safeDay = Math.min(Math.max(day, 1), daysInMonth);

      // 끝값은 보통 inclusive로 쓰니 '해당 일자의 끝'으로 맞춰주는 게 편함
      return new Date(Date.UTC(year, month - 1, safeDay, 0, 0, 0, 0));
    }

    // 2) 기타 포맷은 Date로 시도
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  // inclusive 끝일자를 '그 날의 끝(23:59:59.999)'으로 확장
  private endOfDayUtc(d: Date): Date {
    return new Date(
      Date.UTC(
        d.getUTCFullYear(),
        d.getUTCMonth(),
        d.getUTCDate(),
        23,
        59,
        59,
        999,
      ),
    );
  }
}
