import { SteamBridge } from '../../../src/steam/steam-bridge.service';
import { SteamIdResolver } from '../../../src/steam/steam-id.resolver';
import { SteamDetailLoader } from '../../../src/steam/steam-detail.loader';
import { SteamReviewAggregator } from '../../../src/steam/steam-review.aggregator';
import { GameCalendarSteamData } from '../../../src/types/steam.types';

const createBridge = () => {
  const resolver: Partial<SteamIdResolver> = {
    resolve: jest.fn().mockResolvedValue({
      success: false,
      steam_id: undefined,
      attempts: [],
      original_query: '',
      apiCalls: 0,
    }),
    parseSteamIdFromUrl: jest.fn().mockImplementation((url?: string | null) => {
      if (!url) return null;
      const matched = url.match(/app\/(\d+)/);
      return matched ? Number(matched[1]) : null;
    }),
  };

  const detailLoader: Partial<SteamDetailLoader> = {
    fetchAppDetails: jest.fn(),
    convertToCalendarData: jest.fn(),
  };

  const reviewAggregator: Partial<SteamReviewAggregator> = {
    fetchSummary: jest.fn(),
  };

  const bridge = new SteamBridge(
    resolver as SteamIdResolver,
    detailLoader as SteamDetailLoader,
    reviewAggregator as SteamReviewAggregator,
  );

  return { bridge, resolver, detailLoader, reviewAggregator };
};

describe('SteamBridge', () => {
  it('preset Steam ID가 있으면 resolver를 건너뛰고 캐시를 재사용한다', async () => {
    const { bridge, resolver, detailLoader, reviewAggregator } = createBridge();

    const steamData: GameCalendarSteamData = {
      steam_id: 7777,
      original_name: 'Galactic War',
      price: '무료',
      steam_type: 'game',
      description: 'sample',
      korean_description: undefined,
      developers: ['Studio'],
      publishers: ['Pub'],
      release_date: '2025-01-01',
      required_age: 0,
      categories: ['Single-player'],
      image: 'https://example.com/7777.jpg',
      is_full_game: true,
      fullgame_info: undefined,
      dlc_list: [],
      parent_appid: undefined,
      review_summary: undefined,
      screenshots: [],
      website: undefined,
      is_free: true,
      store_url: 'https://store.steampowered.com/app/7777',
      metacritic: null,
    };

    (detailLoader.fetchAppDetails as jest.Mock).mockResolvedValue({});
    (detailLoader.convertToCalendarData as jest.Mock).mockReturnValue(steamData);
    (reviewAggregator.fetchSummary as jest.Mock).mockResolvedValue({
      success: true,
      num_reviews: 10,
      review_score: 8,
      review_score_desc: '매우 긍정적',
      total_positive: 8,
      total_negative: 2,
      total_reviews: 10,
    });

    const context = {
      gameName: 'Galactic War',
      storeLinks: {},
      presetSteamId: 7777,
      presetSteamUrl: null,
    };

    const options = { timeout: 1000 };

    const first = await bridge.enhance(context, options);

    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(detailLoader.fetchAppDetails).toHaveBeenCalledTimes(1);
    expect(reviewAggregator.fetchSummary).toHaveBeenCalledTimes(1);
    expect(first.integrated).toBe(true);
    expect(first.data?.review_summary?.total_reviews).toBe(10);

    const second = await bridge.enhance(context, options);
    expect(detailLoader.fetchAppDetails).toHaveBeenCalledTimes(1);
    expect(reviewAggregator.fetchSummary).toHaveBeenCalledTimes(1);
    expect(second.stats.cache_hits.appdetails).toBe(1);
    expect(second.stats.cache_hits.reviews).toBe(1);
  });

  it('appDetails가 없으면 실패 단계가 기록되고 통합이 중단된다', async () => {
    const { bridge, detailLoader } = createBridge();

    (detailLoader.fetchAppDetails as jest.Mock).mockResolvedValue(null);

    const result = await bridge.enhance(
      {
        gameName: 'Lost Data',
        storeLinks: {},
        presetSteamId: 5555,
        presetSteamUrl: null,
      },
      { timeout: 1000 },
    );

    expect(result.integrated).toBe(false);
    expect(result.steam_id).toBe(5555);
    expect(result.stats.failures).toEqual([
      { stage: 'appdetails', reason: 'no_data' },
    ]);
  });

  it('리뷰 요약이 실패해도 데이터는 유지하고 실패 로그만 남긴다', async () => {
    const { bridge, detailLoader, reviewAggregator } = createBridge();

    const steamData: GameCalendarSteamData = {
      steam_id: 9999,
      original_name: 'Without Reviews',
      price: 'N/A',
      steam_type: 'dlc',
      description: 'sample',
      korean_description: undefined,
      developers: ['Studio'],
      publishers: ['Pub'],
      release_date: '2025-02-01',
      required_age: 0,
      categories: [],
      image: 'https://example.com/9999.jpg',
      is_full_game: false,
      fullgame_info: { appid: '1000', name: 'Base Game' },
      dlc_list: [],
      parent_appid: 1000,
      review_summary: undefined,
      screenshots: [],
      website: undefined,
      is_free: false,
      store_url: 'https://store.steampowered.com/app/9999',
      metacritic: null,
    };

    (detailLoader.fetchAppDetails as jest.Mock).mockResolvedValue({});
    (detailLoader.convertToCalendarData as jest.Mock).mockReturnValue(steamData);
    (reviewAggregator.fetchSummary as jest.Mock).mockResolvedValue({
      success: false,
      num_reviews: 0,
      review_score: 0,
      review_score_desc: '',
      total_positive: 0,
      total_negative: 0,
      total_reviews: 0,
    });

    const result = await bridge.enhance(
      {
        gameName: 'Without Reviews',
        storeLinks: {},
        presetSteamId: null,
        presetSteamUrl: 'https://store.steampowered.com/app/9999',
      },
      { timeout: 5000 },
    );

    expect(result.integrated).toBe(true);
    expect(result.data?.steam_id).toBe(9999);
    expect(result.data?.review_summary).toBeUndefined();
    expect(result.stats.failures).toEqual([
      { stage: 'reviews', reason: 'not_available' },
    ]);
  });
});
