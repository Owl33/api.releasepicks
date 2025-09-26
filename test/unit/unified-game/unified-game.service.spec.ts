import { UnifiedGameService } from '../../../src/unified-game/unified-game.service';
import { RawgCollector } from '../../../src/rawg/rawg.collector';
import { SteamBridge } from '../../../src/steam/steam-bridge.service';
import { GamePersistenceService } from '../../../src/unified-game/services/game-persistence.service';
import { GameClassificationService } from '../../../src/unified-game/services/game-classification.service';
import { GameMappingService } from '../../../src/unified-game/services/game-mapping.service';
import {
  GameCalendarData,
  RawgCollectedGame,
  RawgCollectorResult,
} from '../../../src/types/game-calendar-unified.types';
import { UpdateGameDto } from '../../../src/unified-game/dto/update-game.dto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CalendarUpdateGateway } from '../../../src/unified-game/gateway/calendar-update.gateway';

const createBaseGame = (): GameCalendarData => ({
  rawg_id: 2000,
  name: 'Galactic War: Expansion Pack',
  original_name: 'Galactic War: Expansion Pack',
  slug_name: 'galactic-war-expansion-pack',
  release_date: '2025-10-10',
  release_status: 'upcoming',
  tba: false,
  platform_type: 'pc',
  platforms: ['pc'],
  genres: ['Action'],
  tags: [],
  developers: ['Studio'],
  publishers: ['Publisher'],
  rating: undefined,
  ratings_count: undefined,
  esrb_rating: null,
  required_age: null,
  early_access: false,
  description: undefined,
  korean_description: undefined,
  website: null,
  image: 'https://example.com/dlc.png',
  screenshots: [],
  trailer_url: null,
  store_links: { steam: 'https://store.steampowered.com/app/900' },
  price: null,
  currency: null,
  steam_integrated: false,
  steam_type: null,
  korea_name: null,
  is_full_game: null,
  dlc_list: [],
  is_free: false,
  review_summary: undefined,
  metacritic: null,
  is_dlc: false,
  parent_rawg_id: null,
  parent_steam_id: null,
  game_type: 'standalone',
  game_type_confidence: null,
  game_type_reason: null,
  last_verified_month: null,
  last_synced_source: null,
  added: 0,
  added_by_status: {},
  dlc_context: {
    rawg_parent_ids: [1500],
  },
  categories: [],
});

describe('UnifiedGameService', () => {
  let rawgCollector: jest.Mocked<Partial<RawgCollector>>;
  let steamBridge: jest.Mocked<Partial<SteamBridge>>;
  let persistenceService: jest.Mocked<Partial<GamePersistenceService>>;
  let classificationService: jest.Mocked<Partial<GameClassificationService>>;
  let mappingService: jest.Mocked<Partial<GameMappingService>>;
  let calendarUpdateGateway: jest.Mocked<CalendarUpdateGateway>;
  let service: UnifiedGameService;

  beforeEach(() => {
    rawgCollector = {
      collectMonthlyGames: jest.fn(),
    };

    steamBridge = {
      clearCaches: jest.fn(),
      enhance: jest.fn(),
    };

    persistenceService = {
      fetchGameSnapshot: jest.fn(),
      persistBatch: jest.fn(),
    };

    classificationService = {
      analyzeName: jest.fn(),
      classify: jest.fn(),
      generateSearchStrategies: jest.fn(),
      applyClassification: jest.fn(),
    };

    mappingService = {
      createFromRawg: jest.fn(),
      mergeWithSteam: jest.fn(),
    };

    calendarUpdateGateway = {
      publishGameUpdate: jest.fn(),
      publishMonthUpdate: jest.fn(),
    } as unknown as jest.Mocked<CalendarUpdateGateway>;

    service = new UnifiedGameService(
      rawgCollector as RawgCollector,
      steamBridge as SteamBridge,
      persistenceService as unknown as GamePersistenceService,
      classificationService as unknown as GameClassificationService,
      mappingService as unknown as GameMappingService,
      calendarUpdateGateway,
    );
  });

  it('Steam 보강과 DLC 부모 병합 흐름을 조합한다', async () => {
    const baseGame = createBaseGame();
    const collected: RawgCollectedGame = {
      base: {
        id: 2000,
        slug: 'galactic-war-expansion-pack',
        name: 'Galactic War: Expansion Pack',
        released: '2025-10-10',
        tba: false,
        background_image: null,
        parent_platforms: [],
        platforms: [],
        genres: [],
        tags: [],
        added: 0,
        added_by_status: {},
        rating: 0,
        ratings_count: 0,
        esrb_rating: null,
        description_raw: null,
        short_screenshots: [],
        is_free: false,
      },
      detail: {
        slugName: 'galactic-war-expansion-pack',
        website: null,
        developers: ['Studio'],
        publishers: ['Publisher'],
        parents_count: 1,
        additions_count: 0,
      },
      stores: [],
      media: null,
      parentHints: [
        {
          id: 1500,
          name: 'Galactic War',
          slug: 'galactic-war',
          platforms: ['pc'],
          background_image: 'https://example.com/base.png',
        },
      ],
      steamStoreId: null,
      steamStoreUrl: null,
      failures: undefined,
    };

    const rawgResult: RawgCollectorResult = {
      month: '2025-10',
      totalCandidates: 1,
      deliveredGames: [collected],
      apiCallStats: {
        list: 1,
        details: 1,
        stores: 0,
        parents: 1,
        trailers: 0,
        retries: 0,
        failures: 0,
      },
    };

    rawgCollector.collectMonthlyGames!.mockResolvedValue(rawgResult);
    mappingService.createFromRawg!.mockReturnValue({ ...baseGame });

    steamBridge.enhance!.mockResolvedValue({
      integrated: true,
      steam_id: 9900,
      data: {
        steam_id: 9900,
        original_name: 'Galactic War: Expansion Pack',
        price: 'USD 19.99',
        steam_type: 'dlc',
        description: 'Expansion DLC',
        korean_description: undefined,
        developers: ['Studio'],
        publishers: ['Publisher'],
        release_date: '2025-10-10',
        required_age: 0,
        categories: [],
        image: 'https://example.com/dlc.png',
        is_full_game: false,
        fullgame_info: { appid: '1500', name: 'Galactic War' },
        dlc_list: [],
        parent_appid: 1500,
        review_summary: {
          review_score: 7,
          review_score_desc: 'Positive',
          total_positive: 120,
          total_negative: 20,
          total_reviews: 140,
        },
        screenshots: [],
        website: undefined,
        is_free: false,
        store_url: 'https://store.steampowered.com/app/9900',
        metacritic: null,
      },
      stats: {
        resolver_calls: 0,
        appdetails_calls: 1,
        review_calls: 1,
        cache_hits: { appdetails: 0, reviews: 0 },
        failures: [],
      },
    });

    mappingService.mergeWithSteam!.mockReturnValue({
      ...baseGame,
      steam_integrated: true,
      steam_type: 'dlc',
      steam_id: 9900,
      parent_steam_id: 1500,
      dlc_context: {
        ...(baseGame.dlc_context ?? {}),
        steam_fullgame_info: { appid: '1500', name: 'Galactic War' },
      },
      review_summary: {
        review_score: 7,
        review_score_desc: 'Positive',
        total_positive: 120,
        total_negative: 20,
        total_reviews: 140,
      },
    });

    classificationService.analyzeName!.mockReturnValue({});
    classificationService.classify!.mockReturnValue({
      gameType: 'dlc',
      confidence: 0.98,
      reason: 'mock reason',
      isMainGame: false,
      priority: 50,
    });
    classificationService.generateSearchStrategies!.mockReturnValue([
      'Galactic War',
    ]);
    classificationService.applyClassification!.mockImplementation((game) => ({
      ...game,
      is_dlc: true,
      game_type: 'dlc',
      game_type_confidence: 0.98,
      game_type_reason: 'mock reason',
      parent_rawg_id: 1500,
      dlc_context: {
        ...(game.dlc_context ?? {}),
        classification: {
          type: 'dlc',
          confidence: 0.98,
          reason: 'mock reason',
          strategies: ['Galactic War'],
        },
      },
    }));

    persistenceService.fetchGameSnapshot!.mockResolvedValue({
      ...baseGame,
      rawg_id: 1500,
      name: 'Galactic War',
      steam_integrated: true,
      steam_id: 1500,
      is_dlc: false,
      store_links: { steam: 'https://store.steampowered.com/app/1500' },
    });

    const result = await service.processGamesForMonth('2025-10', { max_games: 1 });

    expect(steamBridge.clearCaches).toHaveBeenCalled();
    expect(mappingService.mergeWithSteam).toHaveBeenCalled();
    expect(classificationService.applyClassification).toHaveBeenCalled();

    expect(result.games).toHaveLength(2);
    const dlcGame = result.games.find((game) => game.rawg_id === 2000);
    expect(dlcGame?.game_type).toBe('dlc');

    expect(persistenceService.fetchGameSnapshot).toHaveBeenCalledWith({
      rawgId: 1500,
      steamId: 1500,
    });

    expect(result.collection_stats.dlc_filtered).toBe(1);
    expect(result.collection_stats.steam_api_calls).toBe(2);
  });

  it('같은 부모를 참조하는 DLC가 부모 스냅샷 캐시를 재사용한다', async () => {
    const dlcCollectorResult: RawgCollectorResult = {
      month: '2025-11',
      totalCandidates: 2,
      deliveredGames: [
        {
          base: {
            id: 4000,
            slug: 'dlc-one',
            name: 'DLC One',
            released: '2025-11-10',
            tba: false,
            background_image: null,
            parent_platforms: [],
            platforms: [],
            genres: [],
            tags: [],
            added: 0,
            added_by_status: {},
            rating: 0,
            ratings_count: 0,
            esrb_rating: null,
            description_raw: null,
            short_screenshots: [],
            is_free: false,
          },
          detail: {
            slugName: 'dlc-one',
            website: null,
            developers: ['Studio'],
            publishers: ['Publisher'],
            parents_count: 1,
            additions_count: 0,
          },
          stores: [],
          media: null,
          parentHints: [
            {
              id: 1500,
              name: 'Galactic War',
              slug: 'galactic-war',
              platforms: ['pc'],
              background_image: 'https://example.com/base.png',
            },
          ],
          steamStoreId: null,
          steamStoreUrl: null,
          failures: undefined,
        },
        {
          base: {
            id: 4001,
            slug: 'dlc-two',
            name: 'DLC Two',
            released: '2025-11-15',
            tba: false,
            background_image: null,
            parent_platforms: [],
            platforms: [],
            genres: [],
            tags: [],
            added: 0,
            added_by_status: {},
            rating: 0,
            ratings_count: 0,
            esrb_rating: null,
            description_raw: null,
            short_screenshots: [],
            is_free: false,
          },
          detail: {
            slugName: 'dlc-two',
            website: null,
            developers: ['Studio'],
            publishers: ['Publisher'],
            parents_count: 0,
            additions_count: 0,
          },
          stores: [],
          media: null,
          parentHints: [],
          steamStoreId: null,
          steamStoreUrl: null,
          failures: undefined,
        },
      ],
      apiCallStats: {
        list: 1,
        details: 2,
        stores: 0,
        parents: 1,
        trailers: 0,
        retries: 0,
        failures: 0,
      },
    };

    rawgCollector.collectMonthlyGames!.mockResolvedValue(dlcCollectorResult);

    const baseGameTemplate = createBaseGame();
    const dlcGameOne: GameCalendarData = {
      ...baseGameTemplate,
      rawg_id: 4000,
      name: 'DLC One',
      is_dlc: true,
      parent_rawg_id: 1500,
      parent_steam_id: 3000,
      dlc_context: {
        rawg_parent_ids: [1500],
        steam_fullgame_info: { appid: '3000', name: 'Galactic War' },
      },
      steam_integrated: false,
      store_links: {},
    };

    const dlcGameTwo: GameCalendarData = {
      ...baseGameTemplate,
      rawg_id: 4001,
      name: 'DLC Two',
      is_dlc: true,
      parent_rawg_id: null,
      parent_steam_id: 3000,
      dlc_context: {
        steam_fullgame_info: { appid: '3000', name: 'Galactic War' },
      },
      steam_integrated: false,
      store_links: {},
    };

    mappingService.createFromRawg!
      .mockReturnValueOnce(dlcGameOne)
      .mockReturnValueOnce(dlcGameTwo);

    steamBridge.enhance!.mockResolvedValue({
      integrated: false,
      steam_id: null,
      data: undefined,
      stats: {
        resolver_calls: 0,
        appdetails_calls: 0,
        review_calls: 0,
        cache_hits: { appdetails: 0, reviews: 0 },
        failures: [],
      },
    });

    classificationService.analyzeName!.mockReturnValue({});
    classificationService.classify!.mockReturnValue({
      gameType: 'dlc',
      confidence: 0.99,
      reason: 'mock',
      isMainGame: false,
      priority: 10,
    });
    classificationService.generateSearchStrategies!.mockReturnValue([]);
    classificationService.applyClassification!.mockImplementation((game) => ({
      ...game,
      is_dlc: true,
      game_type: 'dlc',
      game_type_confidence: 0.99,
      game_type_reason: 'mock',
      dlc_context: {
        ...(game.dlc_context ?? {}),
        classification: {
          type: 'dlc',
          confidence: 0.99,
          reason: 'mock',
          strategies: [],
        },
      },
    }));

    const buildParentSpy = jest.spyOn<any, any>(
      service as any,
      'buildParentFromRawgHint',
    );

    persistenceService.fetchGameSnapshot!.mockResolvedValue(null);

    const result = await service.processGamesForMonth('2025-11', {
      max_games: 2,
      enable_steam_integration: false,
    });

    expect(persistenceService.fetchGameSnapshot).toHaveBeenCalledTimes(1);
    expect(buildParentSpy).toHaveBeenCalledTimes(1);

    const parentEntries = result.games.filter((game) => game.rawg_id === 1500);
    expect(parentEntries).toHaveLength(1);
    expect(result.games).toHaveLength(3);

    buildParentSpy.mockRestore();
  });

  describe('updateGame', () => {
    const baseSnapshot: GameCalendarData = {
      rawg_id: 9999,
      name: 'Example Game',
      original_name: 'Example Game',
      slug_name: 'example-game',
      release_date: '2025-05-10',
      release_status: 'upcoming',
      tba: false,
      platform_type: 'pc',
      platforms: ['pc'],
      genres: ['Action'],
      tags: ['Action'],
      developers: ['Studio'],
      publishers: ['Publisher'],
      rating: 4,
      ratings_count: 10,
      esrb_rating: null,
      required_age: null,
      early_access: false,
      description: 'desc',
      korean_description: null,
      website: null,
      image: null,
      screenshots: [],
      trailer_url: null,
      store_links: { steam: 'https://store.steampowered.com/app/9999' },
      price: '₩10,000',
      currency: 'KRW',
      steam_integrated: true,
      steam_type: 'game',
      korea_name: null,
      is_full_game: true,
      dlc_list: [],
      is_free: false,
      review_summary: {
        review_score: 8,
        review_score_desc: '긍정적',
        total_positive: 100,
        total_negative: 20,
        total_reviews: 120,
      },
      metacritic: null,
      is_dlc: false,
      parent_rawg_id: null,
      parent_steam_id: null,
      game_type: 'main_game',
      game_type_confidence: 0.9,
      game_type_reason: 'base',
      last_verified_month: '2025-05',
      last_synced_source: 'steam',
      added: 0,
      added_by_status: {},
      dlc_context: undefined,
      categories: [],
    };

    beforeEach(() => {
      jest.useFakeTimers().setSystemTime(new Date('2025-09-26T09:00:00Z'));
      jest.clearAllMocks();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('부분 필드를 병합하고 persistBatch를 호출한다', async () => {
      persistenceService.fetchGameSnapshot!.mockResolvedValue(baseSnapshot);
      persistenceService.persistBatch!.mockResolvedValue({
        saved: 1,
        skipped: 0,
        errors: 0,
        summaries: [
          { rawgId: baseSnapshot.rawg_id, action: 'updated', updatedFields: ['price'] },
        ],
        ingestLogId: 'ingest-log-1',
      } as any);

      const dto: UpdateGameDto = {
        price: '₩15,000',
        steam_review_score: '매우 긍정적',
      };

      const result = await service.updateGame(baseSnapshot.rawg_id, dto);

      expect(result.success).toBe(true);
      expect(result.updated_fields).toContain('price');

      expect(persistenceService.persistBatch).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            price: '₩15,000',
            review_summary: expect.objectContaining({
              review_score_desc: '매우 긍정적',
            }),
            last_synced_source: 'manual',
            last_verified_month: '2025-09',
          }),
        ],
        '2025-09',
        expect.any(Object),
        expect.objectContaining({ total_games: 1 }),
        { captureDiff: true },
      );

      expect(calendarUpdateGateway.publishGameUpdate).toHaveBeenCalledWith(
        baseSnapshot.rawg_id,
        ['price'],
        'ingest-log-1',
      );
    });

    it('변경 필드가 없으면 BadRequestException을 던진다', async () => {
      persistenceService.fetchGameSnapshot!.mockResolvedValue(baseSnapshot);
      await expect(
        service.updateGame(baseSnapshot.rawg_id, {} as UpdateGameDto),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(calendarUpdateGateway.publishGameUpdate).not.toHaveBeenCalled();
    });

    it('대상 게임이 없으면 NotFoundException을 던진다', async () => {
      persistenceService.fetchGameSnapshot!.mockResolvedValue(null);

      await expect(
        service.updateGame(12345, { price: '₩20,000' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
