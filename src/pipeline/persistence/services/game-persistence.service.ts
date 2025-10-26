import { Inject, Injectable, Logger } from '@nestjs/common';
import { EntityManager, FindOptionsWhere, ILike } from 'typeorm';

import {
  CompanyData,
  GameDetailsData,
  GameReleaseData,
  ProcessedGameData,
} from '@pipeline/contracts';

import { Game } from '../../../entities/game.entity';
import { GameDetail } from '../../../entities/game-detail.entity';
import { GameType } from '../../../entities/enums';
import { ReleasePersistenceService } from './release-persistence.service';
import { CompanyRegistryService } from './company-registry.service';
import { SLUG_POLICY } from '../slug/slug-policy.interface';
import type { SlugPolicyPort } from '../slug/slug-policy.interface';
import { MultiPlatformMatchingService } from './multi-platform-matching.service';

export type GamePersistenceOperation = 'created' | 'updated';

export interface GamePersistenceResult {
  operation: GamePersistenceOperation;
  gameId: number;
  matchedBy?: 'steam_id' | 'rawg_id' | 'slug' | 'og_slug' | 'unknown';
}

/**
 * GamePersistenceService
 * - 게임 본문 및 연관 엔티티 upsert 책임
 */
@Injectable()
export class GamePersistenceService {
  private readonly logger = new Logger(GamePersistenceService.name);

  constructor(
    private readonly releasePersistence: ReleasePersistenceService,
    private readonly companyRegistry: CompanyRegistryService,
    private readonly multiPlatformMatching: MultiPlatformMatchingService,
    @Inject(SLUG_POLICY)
    private readonly slugPolicy: SlugPolicyPort,
  ) {}

  async upsertProcessedGame(
    data: ProcessedGameData,
    manager: EntityManager,
    options?: { allowCreate?: boolean },
  ): Promise<GamePersistenceResult> {
    const allowCreate = options?.allowCreate !== false;
    const existing = await this.findExistingGame(data, manager);

    if (existing) {
      const matchedBy = this.inferMatchKey(data, existing);
      await this.updateGame(existing, data, manager);
      return { operation: 'updated', gameId: existing.id, matchedBy };
    }

    if (!allowCreate) {
      throw new Error(
        `CREATE_NOT_ALLOWED: existing game not found (steamId=${data.steamId ?? 'null'}, rawgId=${data.rawgId ?? 'null'}, slug=${data.slug ?? data.name})`,
      );
    }

    const created = await this.createGame(data, manager);
    return { operation: 'created', gameId: created.id, matchedBy: 'unknown' };
  }

  async upsertWithExistingGame(
    existing: Game,
    data: ProcessedGameData,
    manager: EntityManager,
  ): Promise<GamePersistenceResult> {
    const matchedBy = this.inferMatchKey(data, existing);
    await this.updateGame(existing, data, manager);
    return { operation: 'updated', gameId: existing.id, matchedBy };
  }

  private async findExistingGame(
    data: ProcessedGameData,
    manager: EntityManager,
  ): Promise<Game | null> {
    // 1. steam_id로 조회 (Steam 게임 우선)
    if (data.steamId) {
      const bySteam = await manager.findOne(Game, {
        where: { steam_id: data.steamId },
      });
      if (bySteam) return bySteam;
    }

    // 2. rawg_id로 조회 (RAWG 게임)
    if (data.rawgId) {
      const byRawg = await manager.findOne(Game, {
        where: { rawg_id: data.rawgId },
      });
      if (byRawg) return byRawg;
    }

    // 3. slug로 조회 (Steam/RAWG 공통)
    if (data.slug) {
      const bySlug = await manager.findOne(Game, {
        where: { slug: ILike(data.slug) },
      });
      if (bySlug) {
        if (this.isSteamIdConflict(bySlug, data)) {
          this.logger.warn(
            `⚠️ [GamePersistence] slug 충돌 감지 – existingSteam=${bySlug.steam_id ?? 'null'} vs incomingSteam=${data.steamId ?? 'null'} slug=${data.slug}`,
          );
        } else {
          return bySlug;
        }
      }
    }

    // 4. og_slug로 조회 (Steam/RAWG 공통)
    if (data.ogSlug) {
      const byOgSlug = await manager.findOne(Game, {
        where: { og_slug: ILike(data.ogSlug) },
      });
      if (byOgSlug) {
        if (this.isSteamIdConflict(byOgSlug, data)) {
          this.logger.warn(
            `⚠️ [GamePersistence] og_slug 충돌 감지 – existingSteam=${byOgSlug.steam_id ?? 'null'} vs incomingSteam=${data.steamId ?? 'null'} ogSlug=${data.ogSlug}`,
          );
        } else {
          return byOgSlug;
        }
      }
    }

    // 4-1. 매칭 컨텍스트 기반 슬러그 후보 조회
    const candidateSlugs = data.matchingContext?.candidateSlugs ?? [];
    for (const candidate of candidateSlugs) {
      const byCandidateSlug = await manager.findOne(Game, {
        where: { slug: ILike(candidate) },
      });
      if (byCandidateSlug && !this.isSteamIdConflict(byCandidateSlug, data)) {
        this.logger.verbose(
          `🔁 [GamePersistence] 후보 슬러그 매칭 성공 slug=${candidate} → gameId=${byCandidateSlug.id}`,
        );
        return byCandidateSlug;
      }

      const byCandidateOgSlug = await manager.findOne(Game, {
        where: { og_slug: ILike(candidate) },
      });
      if (
        byCandidateOgSlug &&
        !this.isSteamIdConflict(byCandidateOgSlug, data)
      ) {
        this.logger.verbose(
          `🔁 [GamePersistence] 후보 OG 슬러그 매칭 성공 og_slug=${candidate} → gameId=${byCandidateOgSlug.id}`,
        );
        return byCandidateOgSlug;
      }
    }

    // 5. 멀티 플랫폼 매칭 (Steam/RAWG 모두 적용)
    const decision = await this.multiPlatformMatching.evaluate(data, manager);
    if (decision.outcome === 'matched' && decision.game) {
      const scoreText = decision.score
        ? decision.score.totalScore.toFixed(3)
        : 'unknown';
      const sourceLabel = data.steamId
        ? `Steam ${data.steamId}`
        : `RAWG ${data.rawgId ?? '-'}`;
      this.logger.log(
        `🤝 [멀티 매칭] ${sourceLabel} → gameId=${decision.game.id} (score=${scoreText}) 자동 병합`,
      );
      return decision.game;
    }
    if (decision.outcome === 'pending') {
      const sourceLabel = data.steamId
        ? `Steam ${data.steamId}`
        : `RAWG ${data.rawgId ?? '-'}`;
      this.logger.warn(
        `⏸️ [멀티 매칭] ${sourceLabel} 점수 보류 (score=${decision.score?.totalScore.toFixed(3) ?? '0'}, reason=${decision.reason ?? 'SCORE_THRESHOLD_PENDING'}, log=${decision.logPath ?? 'n/a'})`,
      );
    } else if (decision.outcome === 'rejected') {
      const sourceLabel = data.steamId
        ? `Steam ${data.steamId}`
        : `RAWG ${data.rawgId ?? '-'}`;
      this.logger.debug(
        `🚫 [멀티 매칭] ${sourceLabel} 자동 병합 실패 (score=${decision.score?.totalScore.toFixed(3) ?? '0'}, reason=${decision.reason ?? 'NO_MATCH'}, log=${decision.logPath ?? 'n/a'})`,
      );
    }

    return null;
  }

  private async createGame(
    data: ProcessedGameData,
    manager: EntityManager,
  ): Promise<Game> {
    const whereClauses: FindOptionsWhere<Game>[] = [];
    if (data.slug) whereClauses.push({ slug: data.slug });
    if (data.ogSlug) whereClauses.push({ og_slug: data.ogSlug });
    if (data.steamId) whereClauses.push({ steam_id: data.steamId });
    if (data.rawgId) whereClauses.push({ rawg_id: data.rawgId });

    if (whereClauses.length > 0) {
      const existing = await manager.findOne(Game, { where: whereClauses });
      if (existing && !this.isSteamIdConflict(existing, data)) {
        await this.updateGame(existing, data, manager);
        return existing;
      }
      if (existing && this.isSteamIdConflict(existing, data)) {
        this.logger.warn(
          `⚠️ [GamePersistence] createGame 충돌 – existingSteam=${existing.steam_id ?? 'null'} vs incomingSteam=${data.steamId ?? 'null'} name="${existing.name}"`,
        );
      }
    }

    const resolved = await this.slugPolicy.resolve(manager, {
      selfId: null,
      name: data.name,
      ogName: data.ogName,
      preferredSlug: data.slug,
      preferredOgSlug: data.ogSlug,
      fallbackSteamId: data.steamId,
      fallbackRawgId: data.rawgId,
    });

    const gameType = data.gameType ?? GameType.GAME;
    const isDlc = gameType === GameType.DLC;
    const gamePayload: Partial<Game> = {
      name: data.name,
      slug: resolved.slug,
      og_name: data.ogName ?? data.name,
      og_slug: resolved.ogSlug,
      steam_id: data.steamId ?? null,
      rawg_id: data.rawgId ?? null,
      game_type: gameType,
      parent_steam_id: data.parentSteamId ?? null,
      parent_rawg_id: data.parentRawgId ?? null,
      release_date_date: data.releaseDate,
      release_date_raw: data.releaseDateRaw,
      release_status: data.releaseStatus,
      coming_soon: data.comingSoon,
      popularity_score: data.popularityScore,
      followers_cache: data.followersCache ?? null,
    };
    const game = manager.create(Game, gamePayload);

    const parentGame = isDlc ? await this.findParentGame(data, manager) : null;
    const parentPopularity = parentGame?.popularity_score ?? null;
    const allowDlcContent =
      !isDlc || this.shouldAllowDlcContent(parentPopularity);

    const savedGame = await manager.save(Game, game);

    await this.syncDetails(savedGame.id, data.details, data, manager, {
      isDlc,
      allowDlc: allowDlcContent,
      parentPopularity,
    });
    await this.syncReleases(savedGame.id, data.releases, manager, {
      isDlc,
      allowDlc: allowDlcContent,
      parentPopularity,
    });
    await this.syncCompanies(savedGame.id, data.companies, manager, {
      isDlc,
      allowDlc: allowDlcContent,
      parentPopularity,
    });

    return savedGame;
  }

  private async updateGame(
    existing: Game,
    data: ProcessedGameData,
    manager: EntityManager,
  ): Promise<void> {
    if (this.isSteamIdConflict(existing, data)) {
      this.logger.warn(
        `⚠️ [GamePersistence] updateGame 충돌 – existingSteam=${existing.steam_id ?? 'null'} vs incomingSteam=${data.steamId ?? 'null'} name="${existing.name}"`,
      );
      return;
    }
    const isSteamGame = existing.steam_id !== null && existing.steam_id > 0;
    const isRawgPayload =
      data.matchingContext?.source === 'rawg' ||
      (!data.steamId && data.rawgId !== null && data.rawgId !== undefined);
    const resolved = await this.slugPolicy.resolve(manager, {
      selfId: existing.id,
      name: data.name,
      ogName: data.ogName ?? existing.og_name,
      preferredSlug: data.slug ?? existing.slug ?? undefined,
      preferredOgSlug: data.ogSlug ?? existing.og_slug ?? undefined,
      fallbackSteamId: data.steamId ?? existing.steam_id,
      fallbackRawgId: data.rawgId ?? existing.rawg_id,
    });

    const gameType = data.gameType ?? existing.game_type ?? GameType.GAME;
    const isDlc = gameType === GameType.DLC;
    const parentGame = isDlc
      ? await this.findParentGame(data, manager, existing)
      : null;
    const parentPopularity = parentGame?.popularity_score ?? null;
    const allowDlcContent =
      !isDlc || this.shouldAllowDlcContent(parentPopularity);

    if (isSteamGame && isRawgPayload) {
      await this.applyRawgProtectionForSteamGame(existing, data, manager);
      return;
    }
    await manager.update(Game, existing.id, {
      name: data.name,
      slug: resolved.slug,
      og_name: data.ogName ?? existing.og_name ?? data.name,
      og_slug: resolved.ogSlug,
      release_date_date: data.releaseDate,
      release_date_raw: data.releaseDateRaw,
      release_status: data.releaseStatus,
      coming_soon: data.comingSoon,
      popularity_score: data.popularityScore,
      followers_cache: data.followersCache ?? null,
      updated_at: new Date(),
      steam_id: existing.steam_id ?? data.steamId,
      rawg_id: existing.rawg_id ?? data.rawgId,
      game_type: gameType,
      parent_steam_id: data.parentSteamId ?? existing.parent_steam_id,
      parent_rawg_id: data.parentRawgId ?? existing.parent_rawg_id,
    });

    await this.syncDetails(existing.id, data.details, data, manager, {
      isSteamGame,
      isDlc,
      allowDlc: allowDlcContent,
      parentPopularity,
    });
    await this.syncReleases(existing.id, data.releases, manager, {
      isDlc,
      allowDlc: allowDlcContent,
      parentPopularity,
    });
    await this.syncCompanies(existing.id, data.companies, manager, {
      isDlc,
      allowDlc: allowDlcContent,
      parentPopularity,
    });
  }

  private async applyRawgProtectionForSteamGame(
    existing: Game,
    data: ProcessedGameData,
    manager: EntityManager,
  ): Promise<void> {
    const ignored: string[] = [];

    if (
      data.popularityScore !== undefined &&
      data.popularityScore !== existing.popularity_score
    ) {
      ignored.push('popularity_score');
    }
    if (
      data.releaseStatus !== undefined &&
      data.releaseStatus !== existing.release_status
    ) {
      ignored.push('release_status');
    }
    if (data.comingSoon !== existing.coming_soon) {
      ignored.push('coming_soon');
    }
    const dateKey = (v: unknown): string | null => {
      if (v == null) return null; // null | undefined
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      if (typeof v === 'string') {
        const s = v.trim();
        if (!s) return null; // 빈 문자열 방어
        return s.slice(0, 10); // 'YYYY-MM-DD...' 대응
      }
      return null;
    };

    if (data.releaseDate || existing.release_date_date) {
      const incomingKey = dateKey(data.releaseDate);
      const currentKey = dateKey(existing?.release_date_date);

      // 둘 중 하나라도 있으면 비교 수행
      if (incomingKey !== currentKey) {
        ignored.push('release_date');
      }
    }

    if (data.followersCache !== undefined) {
      const incomingFollowers = data.followersCache ?? null;
      if (incomingFollowers !== existing.followers_cache) {
        ignored.push('followers_cache');
      }
    }
    if (data.slug && existing.slug && data.slug !== existing.slug) {
      ignored.push('slug');
    }
    if (data.releases?.length) {
      ignored.push('releases');
    }
    if (data.details) {
      ignored.push('details');
    }
    if (data.companies?.length) {
      ignored.push('companies');
    }

    if (ignored.length > 0) {
      this.logger.warn(
        `⚠️ [GamePersistence] RAWG 보호 정책 적용 – Steam 게임 필드 무시 gameId=${existing.id}, rawgId=${data.rawgId ?? 'null'}, fields=${ignored.join(',')}`,
      );
    }

    const updatePayload: Partial<Game> & { updated_at?: Date } = {};
    let hasUpdate = false;

    if (
      data.rawgId !== undefined &&
      data.rawgId !== null &&
      existing.rawg_id !== data.rawgId
    ) {
      updatePayload.rawg_id = data.rawgId;
      hasUpdate = true;
    }

    if (
      data.parentRawgId !== undefined &&
      data.parentRawgId !== existing.parent_rawg_id
    ) {
      updatePayload.parent_rawg_id = data.parentRawgId ?? null;
      hasUpdate = true;
    }

    if (hasUpdate) {
      updatePayload.updated_at = new Date();
      await manager.update(Game, existing.id, updatePayload);
      this.logger.log(
        `🛡️ [GamePersistence] RAWG 식별자만 갱신 gameId=${existing.id} rawgId=${data.rawgId ?? 'null'} parentRawgId=${data.parentRawgId ?? 'null'}`,
      );
    } else {
      this.logger.debug(
        `🛡️ [GamePersistence] RAWG 식별자 변경 없음 – Steam 게임 보호 gameId=${existing.id}`,
      );
    }
  }

  private async syncDetails(
    gameId: number,
    details: GameDetailsData | undefined,
    data: ProcessedGameData,
    manager: EntityManager,
    options?: {
      isSteamGame?: boolean;
      isDlc?: boolean;
      allowDlc?: boolean;
      parentPopularity?: number | null;
    },
  ): Promise<void> {
    if (!details) return;

    const isDlc = options?.isDlc ?? false;
    const allowDlc = options?.allowDlc ?? true;
    const isSteamGame = options?.isSteamGame ?? false;

    if (isDlc && !allowDlc) {
      this.logger.debug(
        `DLC detail 저장 스킵 – gameId=${gameId} (parent popularity=${options?.parentPopularity ?? 'unknown'})`,
      );
      return;
    }

    if (!isDlc && (data.popularityScore ?? 0) < 40) return;
    if (isSteamGame && data.rawgId && !data.steamId) {
      this.logger.debug(
        `Steam 게임 보호를 위해 RAWG detail 업데이트를 스킵합니다: gameId=${gameId}`,
      );
      return;
    }

    const existingDetails = await manager.findOne(GameDetail, {
      where: { game_id: gameId },
    });

    if (existingDetails) {
      await manager.update(
        GameDetail,
        { game_id: gameId },
        {
          screenshots: details.screenshots,
          video_url: details.videoUrl,
          description: details.description,
          website: details.website,
          genres: details.genres,
          header_image: details.headerImage,
          tags: details.tags,
          sexual: details.sexual,
          support_languages: details.supportLanguages,
          metacritic_score: details.metacriticScore ?? null,
          opencritic_score: details.opencriticScore ?? null,
          rawg_added: details.rawgAdded ?? null,
          total_reviews: details.totalReviews ?? null,
          review_score_desc: details.reviewScoreDesc,
          updated_at: new Date(),
        },
      );
    } else {
      const entity = manager.create(GameDetail, {
        game_id: gameId,
        screenshots: details.screenshots,
        video_url: details.videoUrl,
        description: details.description,
        header_image: details.headerImage,
        website: details.website,
        genres: details.genres,
        tags: details.tags,
        sexual: details.sexual,
        support_languages: details.supportLanguages,
        metacritic_score: details.metacriticScore ?? null,
        opencritic_score: details.opencriticScore ?? null,
        rawg_added: details.rawgAdded ?? null,
        total_reviews: details.totalReviews ?? null,
        review_score_desc: details.reviewScoreDesc,
      });
      await manager.save(GameDetail, entity);
    }
  }

  private inferMatchKey(
    input: ProcessedGameData,
    existing: Game,
  ): 'steam_id' | 'rawg_id' | 'slug' | 'og_slug' | 'unknown' {
    if (input.steamId && existing.steam_id === input.steamId) return 'steam_id';
    if (input.rawgId && existing.rawg_id === input.rawgId) return 'rawg_id';
    if (
      input.slug &&
      typeof existing.slug === 'string' &&
      existing.slug.toLowerCase() === input.slug.toLowerCase()
    ) {
      return 'slug';
    }
    if (
      input.ogSlug &&
      typeof existing.og_slug === 'string' &&
      existing.og_slug.toLowerCase() === input.ogSlug.toLowerCase()
    ) {
      return 'og_slug';
    }
    return 'unknown';
  }

  private isSteamIdConflict(existing: Game, data: ProcessedGameData): boolean {
    if (!data.steamId) return false;
    if (!existing.steam_id) return false;
    return Number(existing.steam_id) !== Number(data.steamId);
  }

  private async syncReleases(
    gameId: number,
    releases: GameReleaseData[] | undefined,
    manager: EntityManager,
    options?: {
      isDlc?: boolean;
      allowDlc?: boolean;
      parentPopularity?: number | null;
    },
  ): Promise<void> {
    const isDlc = options?.isDlc ?? false;
    const allowDlc = options?.allowDlc ?? true;

    if (isDlc && !allowDlc) {
      this.logger.debug(
        `DLC release 저장 스킵 – gameId=${gameId} (parent popularity=${options?.parentPopularity ?? 'unknown'})`,
      );
      return;
    }

    if (!releases?.length) return;
    await this.releasePersistence.syncGameReleases(gameId, releases, manager);
  }

  private async syncCompanies(
    gameId: number,
    companies: CompanyData[] | undefined,
    manager: EntityManager,
    options?: {
      isDlc?: boolean;
      allowDlc?: boolean;
      parentPopularity?: number | null;
    },
  ): Promise<void> {
    const isDlc = options?.isDlc ?? false;
    const allowDlc = options?.allowDlc ?? true;

    if (isDlc && !allowDlc) {
      this.logger.debug(
        `DLC company 저장 스킵 – gameId=${gameId} (parent popularity=${options?.parentPopularity ?? 'unknown'})`,
      );
      return;
    }

    if (!companies?.length) return;
    await this.companyRegistry.syncCompanies(gameId, companies, manager);
  }

  private async findParentGame(
    data: ProcessedGameData,
    manager: EntityManager,
    existing?: Game,
  ): Promise<Game | null> {
    if (data.parentSteamId) {
      const bySteam = await manager.findOne(Game, {
        where: { steam_id: data.parentSteamId },
      });
      if (bySteam) return bySteam;
    }
    if (data.parentRawgId) {
      const byRawg = await manager.findOne(Game, {
        where: { rawg_id: data.parentRawgId },
      });
      if (byRawg) return byRawg;
    }
    if (existing?.parent_steam_id) {
      const bySteam = await manager.findOne(Game, {
        where: { steam_id: existing.parent_steam_id },
      });
      if (bySteam) return bySteam;
    }
    if (existing?.parent_rawg_id) {
      const byRawg = await manager.findOne(Game, {
        where: { rawg_id: existing.parent_rawg_id },
      });
      if (byRawg) return byRawg;
    }
    return null;
  }

  private shouldAllowDlcContent(parentPopularity: number | null): boolean {
    if (parentPopularity == null) return false;
    return parentPopularity >= 40;
  }
}
