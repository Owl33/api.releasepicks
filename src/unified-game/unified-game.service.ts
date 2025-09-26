import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import {
  CollectionStats,
  GameCalendarData,
  MonthlyUnifiedGameResult,
  RawgCollectedGame,
  RawgCollectorResult,
  RawgCollectorOptions,
  UnifiedGameOptions,
} from '../types/game-calendar-unified.types';
import { PlatformType, ReleaseStatus } from '../types/domain.types';
import { RawgCollector } from '../rawg/rawg.collector';
import { SteamBridge } from '../steam/steam-bridge.service';
import {
  GamePersistenceService,
  PersistenceResult,
  PersistenceSummary,
} from './services/game-persistence.service';
import { GameClassificationService } from './services/game-classification.service';
import { GameMappingService } from './services/game-mapping.service';
import { LoggerHelper } from '../common/utils/logger.helper';
import { UpdateGameDto } from './dto/update-game.dto';
import { CalendarUpdateGateway } from './gateway/calendar-update.gateway';

interface DlcParentCandidate {
  rawgId: number | null;
  steamId: number | null;
}

export interface PatchUpdateResult {
  success: boolean;
  rawg_id: number;
  updated_fields: string[];
  skipped: boolean;
  ingest_log_id?: string;
}

@Injectable()
export class UnifiedGameService {
  private readonly logger = new Logger(UnifiedGameService.name);

  private readonly defaultOptions: Required<UnifiedGameOptions> = {
    max_games: 20,
    enable_steam_integration: true,
    min_popularity: 3,
    include_early_access: true,
    steam_timeout: 10000,
  };

  private readonly parentSnapshotCache = new Map<string, GameCalendarData>();

  constructor(
    private readonly rawgCollector: RawgCollector,
    private readonly steamBridge: SteamBridge,
    private readonly persistenceService: GamePersistenceService,
    private readonly classificationService: GameClassificationService,
    private readonly mappingService: GameMappingService,
    private readonly calendarUpdateGateway: CalendarUpdateGateway,
  ) {}

  async processGamesForMonth(
    month: string,
    options: UnifiedGameOptions = {},
  ): Promise<MonthlyUnifiedGameResult> {
    const resolvedOptions = this.resolveOptions(options);
    const startTime = Date.now();

    LoggerHelper.logStart(this.logger, '월별 게임 처리', {
      month,
      options: resolvedOptions,
    });

    const collectorOptions = this.toCollectorOptions(resolvedOptions);
    this.steamBridge.clearCaches();
    this.parentSnapshotCache.clear();
    const rawgResult = await this.rawgCollector.collectMonthlyGames(
      month,
      collectorOptions,
    );

    const processedGames: GameCalendarData[] = [];
    let steamEligible = 0;
    let steamIntegrated = 0;
    let steamApiCalls = 0;
    const parentCandidates = new Map<string, DlcParentCandidate>();

    for (const collected of rawgResult.deliveredGames) {
      try {
        let baseData = this.mappingService.createFromRawg(collected);

        if (this.shouldIntegrateWithSteam(baseData, resolvedOptions)) {
          steamEligible++;
          const enhancement = await this.enhanceWithSteam(
            baseData,
            collected,
            resolvedOptions,
          );

          baseData = enhancement.game;
          steamApiCalls += enhancement.statsSteamApi;
          if (enhancement.integrated) {
            steamIntegrated++;
          }
        }

        baseData.last_verified_month = month;
        baseData.last_synced_source = baseData.steam_integrated
          ? 'steam'
          : 'rawg';

        const classifiedGame = this.applyClassification(baseData, collected);
        this.registerDlcParentCandidate(
          parentCandidates,
          collected,
          classifiedGame,
        );

        processedGames.push(classifiedGame);
      } catch (error) {
        this.logger.error(
          `게임 처리 실패: ${collected.base?.name || collected.base?.id}`,
          (error as Error)?.stack || String(error),
        );
      }
    }

    const additionalParents = await this.loadDlcParentGames(
      parentCandidates,
      processedGames,
    );
    processedGames.push(...additionalParents);

    const processingTime = Date.now() - startTime;

    const collectionStats = this.buildCollectionStats({
      rawgStats: rawgResult.apiCallStats,
      steamApiCalls,
      steamEligible,
      steamIntegrated,
      processingTime,
      processedGames,
    });

    LoggerHelper.logComplete(this.logger, '월별 게임 처리', collectionStats);

    const statsForLog: Record<string, unknown> = {
      ...collectionStats,
    };

    LoggerHelper.logStats(
      this.logger,
      '수집 통계',
      statsForLog,
      processingTime,
    );

    const counts = this.computeGameCounts(processedGames);

    return {
      month,
      total_games: counts.total,
      pc_games: counts.pc,
      console_games: counts.console,
      steam_integrated_games: counts.steamIntegrated,
      games: processedGames,
      collection_stats: collectionStats,
    };
  }

  async saveUnifiedGamesToDatabase(
    month: string,
    options: UnifiedGameOptions = {},
  ): Promise<PersistenceResult> {
    const resolvedOptions = this.resolveOptions(options);
    const processingResult = await this.processGamesForMonth(month, options);
    return this.persistenceService.persistBatch(
      processingResult.games,
      month,
      resolvedOptions,
      processingResult,
    );
  }

  async updateGame(
    rawgId: number,
    payload: UpdateGameDto,
  ): Promise<PatchUpdateResult> {
    const existing = await this.persistenceService.fetchGameSnapshot({
      rawgId,
    });

    if (!existing) {
      throw new NotFoundException(`게임(rawg_id=${rawgId})을 찾을 수 없습니다.`);
    }

    if (!this.hasPatchPayload(payload)) {
      throw new BadRequestException('최소 한 개 이상의 수정 가능한 필드가 필요합니다.');
    }

    this.validatePatchPayload(payload);

    const patched = this.applyPatchUpdates(existing, payload);
    const now = new Date();
    const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

    const resolvedOptions = this.resolveOptions({
      max_games: 1,
      enable_steam_integration: false,
    });

    const processingResult: MonthlyUnifiedGameResult = {
      month: currentMonth,
      total_games: 1,
      pc_games: this.isPcPlatform(patched.platform_type) ? 1 : 0,
      console_games: this.isConsolePlatform(patched.platform_type) ? 1 : 0,
      steam_integrated_games: patched.steam_integrated ? 1 : 0,
      games: [patched],
      collection_stats: {
        rawg_api_calls: 0,
        steam_api_calls: 0,
        steam_success_rate: 0,
        processing_time_ms: 0,
        dlc_filtered: patched.is_dlc ? 1 : 0,
      },
    };

    const persistenceResult = await this.persistenceService.persistBatch(
      [patched],
      currentMonth,
      resolvedOptions,
      processingResult,
      { captureDiff: true },
    );

    const summary = this.extractPatchSummary(persistenceResult.summaries, rawgId);

    if (summary.action === 'updated' || summary.action === 'inserted') {
      await this.calendarUpdateGateway.publishGameUpdate(
        rawgId,
        summary.updatedFields,
        persistenceResult.ingestLogId,
      );
    }

    return {
      success: summary.action !== 'error',
      rawg_id: rawgId,
      updated_fields: summary.updatedFields,
      skipped: summary.action === 'skipped',
      ingest_log_id: persistenceResult.ingestLogId,
    };
  }

  async clearBatchCache(): Promise<void> {
    // RawgCollector는 요청 단위 캐시를 사용하므로 추가적인 캐시 클리어 작업이 필요하지 않다.
    this.logger.debug(
      '별도 캐시가 없어 clearBatchCache는 noop으로 처리되었습니다.',
    );
  }

  private resolveOptions(
    options: UnifiedGameOptions,
  ): Required<UnifiedGameOptions> {
    return {
      max_games: options.max_games ?? this.defaultOptions.max_games,
      enable_steam_integration:
        options.enable_steam_integration ??
        this.defaultOptions.enable_steam_integration,
      min_popularity:
        options.min_popularity ?? this.defaultOptions.min_popularity,
      include_early_access:
        options.include_early_access ??
        this.defaultOptions.include_early_access,
      steam_timeout: options.steam_timeout ?? this.defaultOptions.steam_timeout,
    };
  }

  private toCollectorOptions(
    options: Required<UnifiedGameOptions>,
  ): RawgCollectorOptions {
    return {
      maxGames: options.max_games,
      minPopularity: options.min_popularity,
      includeEarlyAccess: options.include_early_access,
      enableTrailers: true,
    };
  }

  private shouldIntegrateWithSteam(
    game: GameCalendarData,
    options: Required<UnifiedGameOptions>,
  ): boolean {
    if (!options.enable_steam_integration) {
      return false;
    }

    return this.isPcPlatform(game.platform_type);
  }

  private isPcPlatform(platformType: string): boolean {
    return platformType === 'pc' || platformType === 'mixed';
  }

  private isConsolePlatform(platformType: string): boolean {
    return platformType === 'console';
  }

  private registerDlcParentCandidate(
    candidates: Map<string, DlcParentCandidate>,
    collected: RawgCollectedGame,
    game: GameCalendarData,
  ): void {
    if (!game.is_dlc) {
      return;
    }

    const candidate = this.toParentCandidate(game);
    if (!candidate) {
      return;
    }

    const key = `${candidate.rawgId ?? 'null'}:${candidate.steamId ?? 'null'}`;
    if (!candidates.has(key)) {
      candidates.set(key, candidate);
    }
  }

  private async enhanceWithSteam(
    baseData: GameCalendarData,
    collected: RawgCollectedGame,
    options: Required<UnifiedGameOptions>,
  ): Promise<{
    game: GameCalendarData;
    integrated: boolean;
    statsSteamApi: number;
  }> {
    const integration = await this.steamBridge.enhance(
      {
        gameName: baseData.name,
        storeLinks: baseData.store_links,
        presetSteamId: collected.steamStoreId ?? null,
        presetSteamUrl: collected.steamStoreUrl ?? null,
      },
      {
        timeout: options.steam_timeout,
      },
    );

    const apiCalls =
      integration.stats.appdetails_calls +
      integration.stats.review_calls +
      integration.stats.resolver_calls;

    if (!integration.integrated || !integration.data) {
      return { game: baseData, integrated: false, statsSteamApi: apiCalls };
    }

    const merged = this.mappingService.mergeWithSteam(
      baseData,
      integration.data,
    );

    return { game: merged, integrated: true, statsSteamApi: apiCalls };
  }

  private applyClassification(
    game: GameCalendarData,
    collected: RawgCollectedGame,
  ): GameCalendarData {
    const nameAnalysis = this.classificationService.analyzeName(game.name);
    const classification = this.classificationService.classify(nameAnalysis, {
      rawgName: game.name,
      parentsCount: collected.detail?.parents_count ?? 0,
      additionsCount: collected.detail?.additions_count ?? 0,
      hasStoreLink: !!game.store_links?.steam,
      steamType: game.steam_type,
      dlcList: game.dlc_list || [],
      hasFullgameInfo: !!game.dlc_context?.steam_fullgame_info,
    });
    return this.classificationService.applyClassification(
      game,
      classification,
    );
  }

  private async loadDlcParentGames(
    candidates: Map<string, DlcParentCandidate>,
    existingGames: GameCalendarData[],
  ): Promise<GameCalendarData[]> {
    if (candidates.size === 0) {
      return [];
    }

    // 이미 처리된 게임들의 ID를 수집
    const seenRawgIds = new Set<number>();
    const seenSteamIds = new Set<number>();

    for (const game of existingGames) {
      if (game.rawg_id) {
        seenRawgIds.add(game.rawg_id);
      }
      if (game.steam_id) {
        seenSteamIds.add(game.steam_id);
      }
    }

    // 부모 게임 ID들을 추출하고 중복 제거
    const parentRawgIds = new Set<number>();
    for (const candidate of Array.from(candidates.values())) {
      const rawgId = candidate.rawgId;
      if (rawgId && !seenRawgIds.has(rawgId)) {
        parentRawgIds.add(rawgId);
      }
    }

    if (parentRawgIds.size === 0) {
      return [];
    }

    // RawgCollector를 사용해서 부모 게임들을 수집 (일반 게임과 동일한 데이터 품질)
    const parentGameIds = Array.from(parentRawgIds);
    const collectedParents = await this.rawgCollector.collectSpecificGames(
      parentGameIds,
      { enableTrailers: false }, // 부모 게임은 트레일러 수집 안 함
    );

    const parents: GameCalendarData[] = [];

    // 각 부모 게임을 일반 게임과 동일한 파이프라인으로 처리
    for (const collected of collectedParents) {
      try {
        // 1. 기본 매핑
        let baseData = this.mappingService.createFromRawg(collected);

        // 2. Steam 통합 (일반 게임과 동일한 로직)
        if (this.shouldIntegrateWithSteam(baseData, this.defaultOptions)) {
          const enhancement = await this.enhanceWithSteam(
            baseData,
            collected,
            this.defaultOptions,
          );
          baseData = enhancement.game;
        }

        // 3. 메타데이터 설정
        baseData.last_verified_month = null; // 부모 게임은 별도 검증 없음
        baseData.last_synced_source = baseData.steam_integrated
          ? 'steam'
          : 'rawg';

        // 4. 분류 적용
        const classifiedGame = this.applyClassification(baseData, collected);

        // 5. 캐시에 저장 (기존 캐시 메커니즘 활용)
        this.cacheParentSnapshot(
          classifiedGame,
          classifiedGame.rawg_id ?? null,
          classifiedGame.steam_id ?? null
        );

        parents.push(classifiedGame);

        // 중복 방지를 위해 ID 추가
        if (classifiedGame.rawg_id) {
          seenRawgIds.add(classifiedGame.rawg_id);
        }
        if (classifiedGame.steam_id) {
          seenSteamIds.add(classifiedGame.steam_id);
        }
      } catch (error) {
        this.logger.error(
          `부모 게임 처리 실패: ${collected.base?.name || collected.base?.id}`,
          (error as Error)?.stack || String(error),
        );
      }
    }

    return parents;
  }

  private cloneGameData(game: GameCalendarData): GameCalendarData {
    return JSON.parse(JSON.stringify(game));
  }

  private hasPatchPayload(dto: UpdateGameDto): boolean {
    return (
      dto.release_date !== undefined ||
      dto.release_status !== undefined ||
      dto.price !== undefined ||
      dto.steam_review_score !== undefined ||
      dto.tags !== undefined ||
      dto.store_links !== undefined
    );
  }

  private applyPatchUpdates(
    existing: GameCalendarData,
    dto: UpdateGameDto,
  ): GameCalendarData {
    const patched = this.cloneGameData(existing);

    if (dto.release_date !== undefined) {
      patched.release_date = dto.release_date;
    }
    if (dto.release_status !== undefined) {
      patched.release_status = dto.release_status;
    }
    if (dto.price !== undefined) {
      patched.price = dto.price;
    }
    if (dto.tags !== undefined) {
      patched.tags = [...dto.tags];
    }
    if (dto.store_links) {
      patched.store_links = {
        ...(patched.store_links || {}),
        ...dto.store_links,
      };
    }
    if (dto.steam_review_score !== undefined) {
      patched.review_summary = {
        ...(patched.review_summary || {}),
        review_score_desc: dto.steam_review_score ?? undefined,
      };
    }

    const now = new Date();
    patched.last_synced_source = 'manual';
    patched.last_verified_month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

    return patched;
  }

  private extractPatchSummary(
    summaries: PersistenceSummary[] | undefined,
    rawgId: number,
  ): PersistenceSummary {
    if (!summaries || summaries.length === 0) {
      return { rawgId, action: 'skipped', updatedFields: [] };
    }

    const match = summaries.find((summary) => summary.rawgId === rawgId);
    if (match) {
      return match;
    }

    return summaries[0];
  }

  private validatePatchPayload(dto: UpdateGameDto): void {
    if (dto.release_date !== undefined && dto.release_date !== null) {
      if (!this.isIsoDate(dto.release_date)) {
        throw new BadRequestException('release_date는 YYYY-MM-DD 형식이어야 합니다.');
      }
    }

    if (dto.price !== undefined && dto.price !== null) {
      if (typeof dto.price !== 'string' || dto.price.length === 0 || dto.price.length > 50) {
        throw new BadRequestException('price는 1~50자 문자열이어야 합니다.');
      }
    }

    if (dto.steam_review_score !== undefined && dto.steam_review_score !== null) {
      if (
        typeof dto.steam_review_score !== 'string' ||
        dto.steam_review_score.length === 0 ||
        dto.steam_review_score.length > 100
      ) {
        throw new BadRequestException('steam_review_score는 1~100자 문자열이어야 합니다.');
      }
    }

    if (dto.tags !== undefined) {
      if (!Array.isArray(dto.tags)) {
        throw new BadRequestException('tags는 문자열 배열이어야 합니다.');
      }
      if (dto.tags.length > 50) {
        throw new BadRequestException('tags는 최대 50개까지 입력할 수 있습니다.');
      }
      dto.tags.forEach((tag) => {
        if (typeof tag !== 'string' || tag.length === 0 || tag.length > 30) {
          throw new BadRequestException('각 tag는 1~30자 문자열이어야 합니다.');
        }
      });
    }

    if (dto.store_links) {
      const links = dto.store_links;
      Object.entries(links).forEach(([key, value]) => {
        if (value === undefined || value === null) {
          return;
        }
        if (typeof value !== 'string' || !this.isValidUrl(value)) {
          throw new BadRequestException(`${key} 스토어 링크는 유효한 URL이어야 합니다.`);
        }
      });
    }
  }

  private isIsoDate(value: string): boolean {
    if (value.length !== 10) {
      return false;
    }
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) {
      return false;
    }
    const [year, month, day] = value.split('-');
    return year.length === 4 && month.length === 2 && day.length === 2;
  }

  private isValidUrl(value: string): boolean {
    try {
      new URL(value);
      return true;
    } catch (error) {
      return false;
    }
  }


  private cacheParentSnapshot(
    snapshot: GameCalendarData,
    rawgId: number | null,
    steamId: number | null,
  ): void {
    const keys = this.buildParentCacheKeys(
      rawgId ?? snapshot.rawg_id ?? null,
      steamId ?? snapshot.steam_id ?? null,
    );

    for (const key of keys) {
      this.parentSnapshotCache.set(key, snapshot);
    }
  }

  private buildParentCacheKeys(
    rawgId: number | null,
    steamId: number | null,
  ): string[] {
    const keys = new Set<string>();
    if (rawgId) {
      keys.add(`${rawgId}:null`);
    }
    if (steamId) {
      keys.add(`null:${steamId}`);
    }
    if (rawgId && steamId) {
      keys.add(`${rawgId}:${steamId}`);
    }
    return Array.from(keys);
  }

  private toParentCandidate(
    game: GameCalendarData,
  ): DlcParentCandidate | null {
    let parentSteamId = game.parent_steam_id ?? null;
    const steamContextId = game.dlc_context?.steam_fullgame_info?.appid;
    if (!parentSteamId && steamContextId) {
      const parsed = Number(steamContextId);
      if (!Number.isNaN(parsed)) {
        parentSteamId = parsed;
        game.parent_steam_id = parsed;
      }
    }

    const parentRawgId = game.parent_rawg_id ?? null;

    if (!parentSteamId && !parentRawgId) {
      return null;
    }

    return {
      rawgId: parentRawgId,
      steamId: parentSteamId,
    };
  }

  private computeGameCounts(games: GameCalendarData[]): {
    total: number;
    pc: number;
    console: number;
    steamIntegrated: number;
  } {
    let pcGames = 0;
    let consoleGames = 0;
    let steamIntegrated = 0;

    for (const game of games) {
      if (this.isPcPlatform(game.platform_type)) {
        pcGames++;
      }
      if (this.isConsolePlatform(game.platform_type)) {
        consoleGames++;
      }
      if (game.steam_integrated) {
        steamIntegrated++;
      }
    }

    return {
      total: games.length,
      pc: pcGames,
      console: consoleGames,
      steamIntegrated,
    };
  }

  private buildCollectionStats(params: {
    rawgStats: RawgCollectorResult['apiCallStats'];
    steamApiCalls: number;
    steamEligible: number;
    steamIntegrated: number;
    processingTime: number;
    processedGames: GameCalendarData[];
  }): CollectionStats {
    const {
      rawgStats,
      steamApiCalls,
      steamEligible,
      steamIntegrated,
      processingTime,
      processedGames,
    } = params;

    const rawgApiCalls =
      rawgStats.list +
      rawgStats.details +
      rawgStats.stores +
      rawgStats.parents +
      rawgStats.trailers;

    const steamSuccessRate =
      steamEligible > 0 ? (steamIntegrated / steamEligible) * 100 : 0;

    const dlcFiltered = processedGames.filter((game) => game.is_dlc).length;

    return {
      rawg_api_calls: rawgApiCalls,
      steam_api_calls: steamApiCalls,
      steam_success_rate: Number(steamSuccessRate.toFixed(2)),
      processing_time_ms: processingTime,
      dlc_filtered: dlcFiltered,
    };
  }
}
