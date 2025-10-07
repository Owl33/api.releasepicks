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
} from '../entities';
import {
  CalendarResponseDto,
  CalendarReleaseDto,
  StoreLinkDto,
} from './dto/calendar.dto';
import { GameDetailResponseDto, ReleaseInfo, DlcInfo } from './dto/detail.dto';
import { HighlightGameDto, HighlightsResponseDto } from './dto/highlights.dto';

interface ReleaseAggregationSummary {
  releaseIds: number[];
  platforms: Platform[];
  stores: Store[];
  storeLinks: StoreLinkDto[];
  comingSoon: boolean;
}

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

  async getCalendarByMonth(month: string): Promise<CalendarResponseDto> {
    const { start, end } = this.resolveMonthRange(month);

    const rows = await this.gameReleaseRepository
      .createQueryBuilder('release')
      .innerJoin('release.game', 'game')
      .leftJoin('game.details', 'detail')
      .select([
        'release.id AS release_id',
        'release.platform AS release_platform',
        'release.store AS release_store',
        'release.store_url AS release_store_url',
        'release.coming_soon AS release_coming_soon',
        'release.release_status AS release_status',
        'release.release_date_date AS release_date',
        'release.current_price_cents AS release_current_price_cents',
        'game.id AS game_id',
        'game.name AS game_name',
        'game.slug AS game_slug',
        'game.popularity_score AS game_popularity_score',
        'detail.screenshots AS detail_screenshots',
        'detail.genres AS detail_genres',
        'detail.header_image as header_image',
      ])
      .where('release.release_date_date IS NOT NULL')
      .andWhere('release.release_date_date BETWEEN :start AND :end', {
        start,
        end,
      })
      .andWhere('game.is_dlc = false')
      .andWhere('game.popularity_score >= :minScore', { minScore: 40 })
      .orderBy('release.release_date_date', 'ASC')
      .addOrderBy('game.popularity_score', 'DESC')
      .getRawMany();

    const uniqueGameIds = new Set<number>();
    const uniqueDates = new Set<Date>();
    const aggregateMap = new Map<string, CalendarReleaseDto>();

    rows.forEach((row) => {
      const releaseDate = this.toDate(row.release_date);
      if (!releaseDate) {
        return;
      }

      const releaseDateKey = releaseDate;
      const gameId = Number(row.game_id);
      const aggregateKey = `${gameId}:${releaseDateKey}`;

      uniqueGameIds.add(gameId);
      uniqueDates.add(releaseDateKey);

      const genres = this.normalizeStringArray(row.detail_genres);
      const screenshots = this.normalizeStringArray(row.detail_screenshots);

      const platform = row.release_platform as Platform;
      const store = row.release_store as Store;
      const storeUrl = row.release_store_url ?? null;
      const popularityScore = this.toNumber(row.game_popularity_score);
      const comingSoon = Boolean(row.release_coming_soon);
      const releaseStatus = (row.release_status as ReleaseStatus) ?? null;
      const priceCents = row.release_current_price_cents
        ? Number(row.release_current_price_cents)
        : null;
      const currentPrice = priceCents ? priceCents / 100 : null;

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
        // 가격은 null이 아닌 값 우선, steam 스토어 우선
        if (existing.currentPrice === null && currentPrice !== null) {
          existing.currentPrice = currentPrice;
        } else if (
          currentPrice !== null &&
          store === 'steam' &&
          existing.currentPrice !== null
        ) {
          existing.currentPrice = currentPrice;
        }

        return;
      }

      const aggregate: CalendarReleaseDto = {
        releaseIds: [Number(row.release_id)],
        gameId,
        name: String(row.game_name ?? ''),
        slug: String(row.game_slug ?? ''),
        headerImage: row.header_image,
        platforms: [platform],
        stores: [store],
        storeLinks: [{ store, url: storeUrl }],
        releaseDate: releaseDateKey,
        comingSoon,
        releaseStatus,
        popularityScore,
        genres,
        developers: [],
        publishers: [],
        currentPrice,
      };

      aggregateMap.set(aggregateKey, aggregate);
    });

    // ✅ 개발사/퍼블리셔 정보 로드
    const gameIds = Array.from(uniqueGameIds);
    const companiesMap = await this.loadCompaniesBulk(gameIds);

    // ✅ aggregate에 회사 정보 추가
    aggregateMap.forEach((aggregate) => {
      const companies = companiesMap.get(aggregate.gameId);
      if (companies) {
        aggregate.developers = companies.developers;
        aggregate.publishers = companies.publishers;
      }
    });

    const data = Array.from(aggregateMap.values());

    return {
      month,
      range: {
        start: start,
        end: end,
      },
      count: {
        total: data.length,
        games: uniqueGameIds.size,
        days: uniqueDates.size,
      },
      data,
    };
  }

  async getGameDetail(gameId: number): Promise<GameDetailResponseDto> {
    const game = await this.gameRepository.findOne({
      where: { id: gameId },
      relations: ['details', 'releases'],
    });

    if (!game) {
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

    // DLC 리스트 조회 (현재 게임이 부모인 DLC들)
    const dlcs: DlcInfo[] = await this.loadDlcList(game.steam_id, game.rawg_id);

    const detail = game.details;

    return {
      id: game.id,
      name: game.name,
      slug: game.slug,
      steamId: game.steam_id ?? null,
      rawgId: game.rawg_id ?? null,
      gameType: game.game_type,
      isDlc: game.is_dlc,
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
    const upperBound = this.addDays(today, 60);

    const upcomingRows = await this.gameReleaseRepository
      .createQueryBuilder('release')
      .innerJoin('release.game', 'game')
      .select([
        'release.game_id AS game_id',
        'MIN(release.release_date_date) AS min_release_date',
        'MAX(game.popularity_score) AS max_popularity_score',
      ])
      .where('release.release_date_date IS NOT NULL')
      .andWhere('release.release_date_date >= :today', { today })
      .andWhere('release.release_date_date <= :upper', { upper: upperBound })
      .andWhere('game.is_dlc = false')
      .groupBy('release.game_id')
      .orderBy('min_release_date', 'ASC')
      .addOrderBy('MAX(game.popularity_score)', 'DESC')
      .limit(upcomingLimit)
      .getRawMany();

    const upcomingIds = upcomingRows.map((row) => Number(row.game_id));
    const upcomingDetailsRows = upcomingIds.length
      ? await this.gameRepository
          .createQueryBuilder('game')
          .leftJoin('game.details', 'detail')
          .select([
            'game.id AS game_id',
            'game.name AS game_name',
            'game.slug AS game_slug',
            'game.popularity_score AS game_popularity_score',
            'detail.screenshots AS detail_screenshots',
          ])
          .where('game.id IN (:...ids)', { ids: upcomingIds })
          .getRawMany()
      : [];
    const upcomingMap = new Map(
      upcomingDetailsRows.map((row) => [Number(row.game_id), row]),
    );

    const popularRows = await this.gameRepository
      .createQueryBuilder('game')
      .leftJoin('game.details', 'detail')
      .select([
        'game.id AS game_id',
        'game.name AS game_name',
        'game.slug AS game_slug',
        'game.popularity_score AS game_popularity_score',
        'game.release_date_date AS game_release_date',
        'detail.screenshots AS detail_screenshots',
      ])
      .where('game.popularity_score > 0')
      .andWhere('game.is_dlc = false')
      .orderBy('game.popularity_score', 'DESC')
      .addOrderBy('game.release_date_date', 'DESC')
      .limit(popularLimit)
      .getRawMany();

    const popularIds = popularRows.map((row) => Number(row.game_id));
    const releaseSummaryMap = await this.loadReleaseSummary(
      Array.from(new Set([...upcomingIds, ...popularIds])),
    );

    const upcoming: HighlightGameDto[] = upcomingRows
      .map((row) => {
        const details = upcomingMap.get(Number(row.game_id));
        if (!details) {
          return null;
        }

        const summary = releaseSummaryMap.get(Number(row.game_id));
        const releaseDate = this.toDate(row.min_release_date);
        const popularityScore = this.toNumber(
          row.max_popularity_score ?? details.game_popularity_score,
        );
        const screenshots = this.normalizeStringArray(
          details.detail_screenshots,
        );

        return {
          gameId: Number(row.game_id),
          name: String(details.game_name ?? ''),
          slug: String(details.game_slug ?? ''),
          releaseDate: releaseDate as Date | string | number | null,
          popularityScore,
          headerImage: details.header_image,
          // posterImage: this.extractFirst(screenshots),
          daysUntilRelease: releaseDate
            ? this.calculateDaysBetween(releaseDate, today)
            : null,
          platforms: summary?.platforms ?? [],
          stores: summary?.stores ?? [],
          storeLinks: summary?.storeLinks ?? [],
          releaseIds: summary?.releaseIds ?? [],
          comingSoon: summary?.comingSoon ?? false,
        };
      })
      .filter((item): item is HighlightGameDto => item !== null);

    const popular: HighlightGameDto[] = popularRows.map((row) => {
      const summary = releaseSummaryMap.get(Number(row.game_id));
      const releaseDate = this.toDate(row.game_release_date);
      const screenshots = this.normalizeStringArray(row.detail_screenshots);

      return {
        gameId: Number(row.game_id),
        name: String(row.game_name ?? ''),
        slug: String(row.game_slug ?? ''),
        releaseDate: releaseDate as Date | string | number | null,
        popularityScore: this.toNumber(row.game_popularity_score),
        headerImage: row.header_image,
        // posterImage: this.extractFirst(screenshots),
        daysUntilRelease: releaseDate
          ? this.calculateDaysBetween(releaseDate, today)
          : null,
        platforms: summary?.platforms ?? [],
        stores: summary?.stores ?? [],
        storeLinks: summary?.storeLinks ?? [],
        releaseIds: summary?.releaseIds ?? [],
        comingSoon: summary?.comingSoon ?? false,
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
      };

      this.pushUnique(summary.releaseIds, Number(row.release_id));
      this.pushUnique(summary.platforms, platform);
      this.pushStoreLink(summary.stores, summary.storeLinks, store, storeUrl);
      summary.comingSoon = summary.comingSoon || comingSoon;

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

    query.where('game.is_dlc = true');

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

    const rows = await this.gcrRepository
      .createQueryBuilder('gcr')
      .innerJoin('gcr.company', 'c')
      .select([
        'gcr.game_id AS game_id',
        'c.name AS company_name',
        'gcr.role AS role',
      ])
      .where('gcr.game_id IN (:...ids)', { ids: gameIds })
      .getRawMany();

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
}
