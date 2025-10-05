import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Game, GameRelease, ReleaseStatus, Platform, Store } from '../entities';
import {
  CalendarResponseDto,
  CalendarReleaseDto,
  StoreLinkDto,
} from './dto/calendar.dto';
import { GameDetailResponseDto } from './dto/detail.dto';
import {
  HighlightGameDto,
  HighlightsResponseDto,
} from './dto/highlights.dto';

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
        'game.id AS game_id',
        'game.name AS game_name',
        'game.slug AS game_slug',
        'game.popularity_score AS game_popularity_score',
        'game.platforms_summary AS game_platforms_summary',
        'detail.screenshots AS detail_screenshots',
        'detail.genres AS detail_genres',
      ])
      .where('release.release_date_date IS NOT NULL')
      .andWhere('release.release_date_date BETWEEN :start AND :end', {
        start,
        end,
      })
      .andWhere('game.is_dlc = false')
      .orderBy('release.release_date_date', 'ASC')
      .addOrderBy('game.popularity_score', 'DESC')
      .getRawMany();

    const uniqueGameIds = new Set<number>();
    const uniqueDates = new Set<string>();
    const aggregateMap = new Map<string, CalendarReleaseDto>();

    rows.forEach((row) => {
      const releaseDate = this.toDate(row.release_date);
      if (!releaseDate) {
        return;
      }

      const releaseDateKey = releaseDate.toISOString().split('T')[0];
      const gameId = Number(row.game_id);
      const aggregateKey = `${gameId}:${releaseDateKey}`;

      uniqueGameIds.add(gameId);
      uniqueDates.add(releaseDateKey);

      const platformsSummary = this.normalizeStringArray(
        row.game_platforms_summary,
      );
      const genres = this.normalizeStringArray(row.detail_genres);
      const screenshots = this.normalizeStringArray(row.detail_screenshots);

      const platform = row.release_platform as Platform;
      const store = row.release_store as Store;
      const storeUrl = row.release_store_url ?? null;
      const popularityScore = this.toNumber(row.game_popularity_score);
      const comingSoon = Boolean(row.release_coming_soon);
      const releaseStatus = (row.release_status as ReleaseStatus) ?? null;

      const existing = aggregateMap.get(aggregateKey);
      if (existing) {
        this.pushUnique(existing.releaseIds, Number(row.release_id));
        this.pushUnique(existing.platforms, platform);
        this.pushStoreLink(existing.stores, existing.storeLinks, store, storeUrl);
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
        existing.platformsSummary = this.mergeStringArrays(
          existing.platformsSummary,
          platformsSummary,
        );
        if (!existing.posterImage) {
          existing.posterImage = this.extractFirst(screenshots);
        }
        return;
      }

      const aggregate: CalendarReleaseDto = {
        releaseIds: [Number(row.release_id)],
        gameId,
        name: String(row.game_name ?? ''),
        slug: String(row.game_slug ?? ''),
        platforms: [platform],
        stores: [store],
        storeLinks: [{ store, url: storeUrl }],
        releaseDate: releaseDateKey,
        comingSoon,
        releaseStatus,
        popularityScore,
        posterImage: this.extractFirst(screenshots),
        genres,
        platformsSummary,
      };

      aggregateMap.set(aggregateKey, aggregate);
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

    const sortedReleases = [...(game.releases ?? [])].sort((a, b) => {
      const aDate = a.release_date_date?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const bDate = b.release_date_date?.getTime() ?? Number.MAX_SAFE_INTEGER;

      if (aDate === bDate) {
        return a.platform.localeCompare(b.platform);
      }

      return aDate - bDate;
    });

    const releaseIds: number[] = [];
    const releasePlatforms: Platform[] = [];
    const releaseStores: Store[] = [];
    const releaseStoreLinks: StoreLinkDto[] = [];
    const releaseDates: Array<Date | string | number | null> = [];
    const releaseStatuses: Array<ReleaseStatus | null> = [];
    const releaseComingSoonFlags: boolean[] = [];
    const releasePriceCents: Array<number | null> = [];
    const releaseIsFreeFlags: boolean[] = [];
    const releaseFollowers: Array<number | null> = [];
    const releaseReviewsTotal: Array<number | null> = [];
    const releaseReviewScoreDescs: Array<string | null> = [];

    sortedReleases.forEach((release) => {
      releaseIds.push(release.id);
      releasePlatforms.push(release.platform);
      releaseStores.push(release.store);
      releaseStoreLinks.push({ store: release.store, url: release.store_url });
      releaseDates.push(release.release_date_date);
      releaseStatuses.push(release.release_status);
      releaseComingSoonFlags.push(release.coming_soon);
      releasePriceCents.push(release.current_price_cents);
      releaseIsFreeFlags.push(release.is_free);
      releaseFollowers.push(release.followers);
      releaseReviewsTotal.push(release.reviews_total);
      releaseReviewScoreDescs.push(release.review_score_desc);
    });

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
      platformsSummary: game.platforms_summary ?? [],
      releaseDate: game.release_date_date,
      releaseStatus: game.release_status,
      followersCache: game.followers_cache,

      description: detail?.description ?? null,
      website: detail?.website ?? null,
      genres: detail?.genres ?? [],
      tags: detail?.tags ?? [],
      supportLanguages: detail?.support_languages ?? [],
      screenshots: detail?.screenshots ?? [],
      videoUrl: detail?.video_url ?? null,
      metacriticScore: detail?.metacritic_score ?? null,
      opencriticScore: detail?.opencritic_score ?? null,
      steamReviewDesc: detail?.steam_review_desc ?? null,
      rawgAdded: detail?.rawg_added ?? null,
      totalReviews: detail?.total_reviews ?? null,
      reviewScoreDesc: detail?.review_score_desc ?? null,
      detailPlatformType: detail?.platform_type ?? null,

      releaseIds,
      releasePlatforms,
      releaseStores,
      releaseStoreLinks,
      releaseDates,
      releaseStatuses,
      releaseComingSoonFlags,
      releasePriceCents,
      releaseIsFreeFlags,
      releaseFollowers,
      releaseReviewsTotal,
      releaseReviewScoreDescs,
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
            'game.platforms_summary AS game_platforms_summary',
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
        'game.platforms_summary AS game_platforms_summary',
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
        const platformsSummary = this.normalizeStringArray(
          details.game_platforms_summary,
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
          platformsSummary,
          posterImage: this.extractFirst(screenshots),
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
      const platformsSummary = this.normalizeStringArray(
        row.game_platforms_summary,
      );
      const screenshots = this.normalizeStringArray(row.detail_screenshots);

      return {
        gameId: Number(row.game_id),
        name: String(row.game_name ?? ''),
        slug: String(row.game_slug ?? ''),
        releaseDate: releaseDate as Date | string | number | null,
        popularityScore: this.toNumber(row.game_popularity_score),
        platformsSummary,
        posterImage: this.extractFirst(screenshots),
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
