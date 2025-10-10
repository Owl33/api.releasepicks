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
    @Inject(SLUG_POLICY)
    private readonly slugPolicy: SlugPolicyPort,
  ) {}

  async upsertProcessedGame(
    data: ProcessedGameData,
    manager: EntityManager,
  ): Promise<GamePersistenceResult> {
    const existing = await this.findExistingGame(data, manager);

    if (existing) {
      const matchedBy = this.inferMatchKey(data, existing);
      await this.updateGame(existing, data, manager);
      return { operation: 'updated', gameId: existing.id, matchedBy };
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
    if (data.steamId) {
      const bySteam = await manager.findOne(Game, {
        where: { steam_id: data.steamId },
      });
      if (bySteam) return bySteam;
    }

    if (data.rawgId) {
      const byRawg = await manager.findOne(Game, {
        where: { rawg_id: data.rawgId },
      });
      if (byRawg) return byRawg;
    }

    if (data.slug) {
      const bySlug = await manager.findOne(Game, {
        where: { slug: ILike(data.slug) },
      });
      if (bySlug) return bySlug;
    }

    if (data.ogSlug) {
      const byOgSlug = await manager.findOne(Game, {
        where: { og_slug: ILike(data.ogSlug) },
      });
      if (byOgSlug) return byOgSlug;
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
      if (existing) {
        await this.updateGame(existing, data, manager);
        return existing;
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
    const allowDlcContent = !isDlc || this.shouldAllowDlcContent(parentPopularity);

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
    const isSteamGame = existing.steam_id !== null && existing.steam_id > 0;
    const isRawgDataSource = data.rawgId !== null && !data.steamId;
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
    const parentGame = isDlc ? await this.findParentGame(data, manager, existing) : null;
    const parentPopularity = parentGame?.popularity_score ?? null;
    const allowDlcContent = !isDlc || this.shouldAllowDlcContent(parentPopularity);

    if (isSteamGame && isRawgDataSource) {
      await manager.update(Game, existing.id, {
        slug: resolved.slug,
        og_slug: resolved.ogSlug,
        release_date_date: data.releaseDate,
        release_status: data.releaseStatus,
        coming_soon: data.comingSoon,
        popularity_score: data.popularityScore,
        followers_cache: data.followersCache ?? null,
        rawg_id: existing.rawg_id ?? data.rawgId,
        updated_at: new Date(),
      });

      if (data.releases?.length) {
        await this.syncReleases(existing.id, data.releases, manager, {
          isDlc,
          allowDlc: allowDlcContent,
          parentPopularity,
        });
      }

      if (data.companies?.length) {
        await this.syncCompanies(existing.id, data.companies, manager, {
          isDlc,
          allowDlc: allowDlcContent,
          parentPopularity,
        });
      }
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
      const bySteam = await manager.findOne(Game, { where: { steam_id: data.parentSteamId } });
      if (bySteam) return bySteam;
    }
    if (data.parentRawgId) {
      const byRawg = await manager.findOne(Game, { where: { rawg_id: data.parentRawgId } });
      if (byRawg) return byRawg;
    }
    if (existing?.parent_steam_id) {
      const bySteam = await manager.findOne(Game, { where: { steam_id: existing.parent_steam_id } });
      if (bySteam) return bySteam;
    }
    if (existing?.parent_rawg_id) {
      const byRawg = await manager.findOne(Game, { where: { rawg_id: existing.parent_rawg_id } });
      if (byRawg) return byRawg;
    }
    return null;
  }

  private shouldAllowDlcContent(parentPopularity: number | null): boolean {
    if (parentPopularity == null) return false;
    return parentPopularity >= 40;
  }
}
