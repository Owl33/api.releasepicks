import { RawgCollector } from '../../../src/rawg/rawg.collector';
import { RawgService } from '../../../src/rawg/rawg.service';
import { YouTubeService } from '../../../src/youtube/youtube.service';
import {
  RawgCollectorOptions,
  RawgListGame,
} from '../../../src/types/game-calendar-unified.types';

describe('RawgCollector', () => {
  const baseGame: RawgListGame = {
    id: 100,
    slug: 'sample-dlc',
    name: 'Sample DLC',
    released: '2025-10-10',
    tba: false,
    background_image: null,
    parent_platforms: [],
    platforms: [],
    genres: [],
    tags: [],
    added: 10,
    added_by_status: {},
    rating: 0,
    ratings_count: 0,
    esrb_rating: null,
    description_raw: null,
    short_screenshots: [],
    is_free: false,
  };

  const createCollector = (
    overrides: Partial<{
      games: RawgListGame[];
      parentsCount?: number;
      parentGames?: RawgParentHint[];
      enableTrailers?: boolean;
      trailerId?: string | null;
    }> = {},
  ) => {
    const games = overrides.games ?? [baseGame];
    const parentsCount = overrides.parentsCount ?? 1;
    const parentGames =
      overrides.parentGames ?? [
        {
          id: 10,
          name: 'Sample Base Game',
          slug: 'sample-base',
          platforms: ['pc'],
          background_image: 'https://example.com/base.png',
        },
      ];

    const rawgService: Partial<RawgService> = {
      getMonthlyGames: jest.fn().mockResolvedValue({
        apiCalls: 1,
        games,
      }),
      getDetails: jest.fn().mockResolvedValue({
        slugName: games[0].slug,
        website: null,
        developers: ['Dev Studio'],
        publishers: ['Pub House'],
        parents_count: parentsCount,
        additions_count: 0,
      }),
      getStore: jest.fn().mockResolvedValue({ results: [] }),
      getParentGames: jest.fn().mockResolvedValue(parentGames),
    };

    const youtubeService: Partial<YouTubeService> = {
      getSimpleTrailer: jest.fn().mockResolvedValue(
        overrides.trailerId === undefined ? null : overrides.trailerId,
      ),
    };

    const collector = new RawgCollector(
      rawgService as RawgService,
      youtubeService as YouTubeService,
    );

    const options: RawgCollectorOptions = {
      maxGames: games.length,
      minPopularity: 0,
      includeEarlyAccess: true,
      enableTrailers: overrides.enableTrailers ?? false,
    };

    return { collector, rawgService, youtubeService, options };
  };

  it('부모 게임 조회 시 API와 통계가 한 번만 증가한다', async () => {
    const { collector, rawgService, options } = createCollector({
      parentsCount: 1,
    });

    const result = await collector.collectMonthlyGames('2025-10', options);

    expect(rawgService.getDetails).toHaveBeenCalledTimes(1);
    expect(rawgService.getParentGames).toHaveBeenCalledTimes(1);
    expect(result.apiCallStats.parents).toBe(1);
    expect(result.deliveredGames).toHaveLength(1);
    const collected = result.deliveredGames[0];
    expect(collected.parent_rawg_id).toBeDefined();
    expect(collected.parent_rawg_id).toBe(10);
  });

  it('parents_count가 0이면 부모 API를 호출하지 않는다', async () => {
    const { collector, rawgService, options } = createCollector({
      parentsCount: 0,
    });

    const result = await collector.collectMonthlyGames('2025-11', options);

    expect(rawgService.getParentGames).not.toHaveBeenCalled();
    expect(result.apiCallStats.parents).toBe(0);
    expect(result.deliveredGames[0].parent_rawg_id).toBeUndefined();
  });

  it('부모 API가 빈 배열을 반환해도 빈 배열이 전달된다', async () => {
    const { collector, rawgService, options } = createCollector({
      parentsCount: 1,
      parentGames: [],
    });

    const result = await collector.collectMonthlyGames('2025-12', options);

    expect(rawgService.getParentGames).toHaveBeenCalledTimes(1);
    expect(result.deliveredGames[0].parent_rawg_id).toBeNull();
  });

  it('트레일러 옵션을 활성화하면 YouTube 호출과 Steam 스토어 추출을 수행한다', async () => {
    const gameWithStore: RawgListGame = {
      ...baseGame,
      id: 200,
      slug: 'with-store',
      name: 'With Store',
    };

    const { collector, rawgService, youtubeService, options } = createCollector({
      games: [gameWithStore],
      enableTrailers: true,
      trailerId: 'YOUTUBE123',
    });

    (rawgService.getStore as jest.Mock).mockResolvedValue({
      results: [
        {
          id: 1,
          store: { id: 1, slug: 'steam', name: 'Steam' },
          url: 'https://store.steampowered.com/app/555555',
        },
      ],
    });

    const result = await collector.collectMonthlyGames('2025-12', options);

    expect(youtubeService.getSimpleTrailer).toHaveBeenCalledWith('with-store');
    const collected = result.deliveredGames[0];
    expect(collected.media?.youtubeUrl).toContain('YOUTUBE123');
    expect(collected.steamStoreId).toBe(555555);
    expect(collected.steamStoreUrl).toBe(
      'https://store.steampowered.com/app/555555',
    );
  });
});
