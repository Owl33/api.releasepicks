import { UnifiedGameService } from '../../src/unified-game/unified-game.service';
import { RawgCollector } from '../../src/rawg/rawg.collector';
import { SteamBridge } from '../../src/steam/steam-bridge.service';
import { GamePersistenceService } from '../../src/unified-game/services/game-persistence.service';
import { GameClassificationService } from '../../src/unified-game/services/game-classification.service';
import { GameMappingService } from '../../src/unified-game/services/game-mapping.service';
import { CalendarUpdateGateway } from '../../src/unified-game/gateway/calendar-update.gateway';
import {
  RawgCollectedGame,
  RawgCollectorResult,
} from '../../src/types/game-calendar-unified.types';
import { GameCalendarSteamData } from '../../src/types/steam.types';

const buildRawgResult = (): RawgCollectorResult => {
  const collected: RawgCollectedGame = {
    base: {
      id: 3100,
      slug: 'galactic-war-expansion-pack',
      name: 'Galactic War: Expansion Pack',
      released: '2025-10-10',
      tba: false,
      background_image: 'https://example.com/dlc.png',
      parent_platforms: [],
      platforms: [
        {
          platform: {
            id: 4,
            slug: 'pc',
            name: 'PC',
          },
        },
      ],
      genres: [
        {
          id: 51,
          name: 'Indie',
        },
      ],
      tags: [
        {
          id: 100,
          name: 'Expansion',
          language: 'eng',
        },
      ],
      added: 40,
      added_by_status: { wishlist: 40 },
      rating: 4.2,
      ratings_count: 12,
      esrb_rating: { name: 'Teen' },
      description_raw: 'DLC content',
      short_screenshots: [
        { id: 1, image: 'https://example.com/screens/0.png' },
        { id: 2, image: 'https://example.com/screens/1.png' },
      ],
      is_free: false,
    },
    detail: {
      slugName: 'galactic-war-expansion-pack',
      website: null,
      developers: ['Nebula Works'],
      publishers: ['Lionheart Games'],
      parents_count: 1,
      additions_count: 0,
    },
    stores: [
      {
        id: 1,
        store: { id: 1, slug: 'steam', name: 'Steam' },
        url: 'https://store.steampowered.com/app/9900',
      },
    ],
    media: null,
    parentHints: [
      {
        id: 3000,
        name: 'Galactic War',
        slug: 'galactic-war',
        platforms: ['pc'],
        background_image: 'https://example.com/base.png',
      },
    ],
    steamStoreId: 9900,
    steamStoreUrl: 'https://store.steampowered.com/app/9900',
    failures: undefined,
  };

  return {
    month: '2025-10',
    totalCandidates: 1,
    deliveredGames: [collected],
    apiCallStats: {
      list: 1,
      details: 1,
      stores: 1,
      parents: 1,
      trailers: 0,
      retries: 0,
      failures: 0,
    },
  };
};

describe('UnifiedGameService (integration)', () => {
  let classificationService: GameClassificationService;
  let mappingService: GameMappingService;
  let rawgCollector: jest.Mocked<Partial<RawgCollector>>;
  let steamBridge: jest.Mocked<Partial<SteamBridge>>;
  let persistenceService: jest.Mocked<Partial<GamePersistenceService>>;
  let service: UnifiedGameService;
  let calendarUpdateGateway: jest.Mocked<Partial<CalendarUpdateGateway>>;

  beforeEach(() => {
    classificationService = new GameClassificationService();
    mappingService = new GameMappingService();

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

    calendarUpdateGateway = {
      publishGameUpdate: jest.fn(),
      publishMonthUpdate: jest.fn(),
    };

    service = new UnifiedGameService(
      rawgCollector as RawgCollector,
      steamBridge as SteamBridge,
      persistenceService as unknown as GamePersistenceService,
      classificationService,
      mappingService,
      calendarUpdateGateway as unknown as CalendarUpdateGateway,
    );
  });

  it('DLC 부모 정보를 snapshot에서 보강한다', async () => {
    rawgCollector.collectMonthlyGames!.mockResolvedValue(buildRawgResult());

    const steamData: GameCalendarSteamData = {
      steam_id: 9900,
      original_name: 'Galactic War: Expansion Pack',
      price: '₩19,800',
      steam_type: 'dlc',
      description: 'Expansion DLC',
      korean_description: undefined,
      developers: ['Nebula Works'],
      publishers: ['Lionheart Games'],
      release_date: '2025-10-10',
      required_age: 0,
      categories: ['Single-player'],
      image: 'https://example.com/dlc.png',
      is_full_game: false,
      fullgame_info: { appid: '3000', name: 'Galactic War' },
      dlc_list: [],
      parent_appid: 3000,
      review_summary: {
        review_score: 7,
        review_score_desc: '긍정적',
        total_positive: 420,
        total_negative: 60,
        total_reviews: 480,
      },
      screenshots: [],
      website: undefined,
      is_free: false,
      store_url: 'https://store.steampowered.com/app/9900',
      metacritic: null,
    };

    steamBridge.enhance!.mockResolvedValue({
      integrated: true,
      steam_id: 9900,
      data: steamData,
      stats: {
        resolver_calls: 0,
        appdetails_calls: 1,
        review_calls: 1,
        cache_hits: { appdetails: 0, reviews: 0 },
        failures: [],
      },
    });

    persistenceService.fetchGameSnapshot!.mockResolvedValue({
      rawg_id: 3000,
      name: 'Galactic War',
      original_name: 'Galactic War',
      slug_name: 'galactic-war',
      release_date: '2024-09-15',
      release_status: 'released',
      tba: false,
      platform_type: 'mixed',
      platforms: ['pc', 'playstation5'],
      genres: ['Action'],
      tags: [],
      developers: ['Nebula Works'],
      publishers: ['Lionheart Games'],
      rating: 4.5,
      ratings_count: 500,
      esrb_rating: 'Teen',
      required_age: null,
      early_access: false,
      description: 'Base game',
      korean_description: undefined,
      website: null,
      image: 'https://example.com/base.png',
      screenshots: [],
      trailer_url: null,
      store_links: {
        steam: 'https://store.steampowered.com/app/3000',
      },
      price: '₩44,000',
      currency: 'KRW',
      steam_integrated: true,
      steam_type: 'game',
      korea_name: null,
      is_full_game: true,
      dlc_list: [9900],
      is_free: false,
      review_summary: {
        review_score: 8,
        review_score_desc: '매우 긍정적',
        total_positive: 1200,
        total_negative: 200,
        total_reviews: 1400,
      },
      metacritic: null,
      is_dlc: false,
      parent_rawg_id: null,
      parent_steam_id: null,
      game_type: 'main_game',
      game_type_confidence: 0.95,
      game_type_reason: 'Steam 본편',
      last_verified_month: '2025-06',
      last_synced_source: 'steam',
      added: 500,
      added_by_status: { owned: 400 },
      dlc_context: undefined,
      categories: ['Single-player'],
    });

    const result = await service.processGamesForMonth('2025-10', {
      max_games: 1,
      enable_steam_integration: true,
    });

    expect(steamBridge.clearCaches).toHaveBeenCalled();
    expect(result.games.length).toBe(2);

    const dlcGame = result.games.find((game) => game.rawg_id === 3100);
    expect(dlcGame?.is_dlc).toBe(true);
    expect(dlcGame?.parent_rawg_id).toBe(3000);
    expect(dlcGame?.game_type).toBe('dlc');
    expect(dlcGame?.dlc_context?.rawg_parent_ids).toBeDefined();
    expect(dlcGame?.dlc_context?.rawg_parent_ids).toHaveLength(1);
    expect(dlcGame?.dlc_context?.rawg_parent_ids?.[0]).toBe(3000);

    const parent = result.games.find((game) => game.rawg_id === 3000);
    expect(parent).toBeDefined();

    expect(result.collection_stats.rawg_api_calls).toBe(4);
    expect(result.collection_stats.steam_api_calls).toBe(2);
    expect(result.steam_integrated_games).toBeGreaterThanOrEqual(1);

  });

  it('부모 스냅샷이 없을 때 RAWG 힌트로 부모 GameCalendarData를 생성한다', async () => {
    rawgCollector.collectMonthlyGames!.mockResolvedValue(buildRawgResult());

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

    persistenceService.fetchGameSnapshot!.mockResolvedValue(null);

    const result = await service.processGamesForMonth('2025-10', {
      max_games: 1,
      enable_steam_integration: false,
    });

    expect(result.games.length).toBe(2);

    const parent = result.games.find((game) => game.rawg_id === 3000);
    expect(parent).toBeDefined();
    expect(parent?.name).toBe('Galactic War');
    expect(parent?.steam_integrated).toBe(false);
    expect(parent?.platform_type).toBe('pc');
    expect(parent?.release_status).toBe('released');

    const dlc = result.games.find((game) => game.rawg_id === 3100);
    expect(dlc?.is_dlc).toBe(true);

  });
});
