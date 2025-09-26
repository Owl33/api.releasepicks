import { GameUpdateEvaluator } from '../../../src/unified-game/persistence/game-update.evaluator';
import { Game } from '../../../src/entities/game.entity';
import { GameDetail } from '../../../src/entities/game-detail.entity';
import { GameCalendarData } from '../../../src/types/game-calendar-unified.types';
import { DataMapper } from '../../../src/unified-game/persistence/mappers/data.mapper';

describe('GameUpdateEvaluator', () => {
  const evaluator = new GameUpdateEvaluator();

  const createGameEntity = (): Game => {
    return Object.assign(new Game(), {
      id: 1,
      rawg_id: 123,
      name: 'Astral Frontier',
      released: new Date('2025-08-15'),
      platforms: ['pc'],
      genres: ['Action'],
      added: 100,
      image: 'https://cdn.example.com/astral.jpg',
      developers: ['Nebula Works'],
      publishers: ['Lionheart Games'],
      release_status: 'upcoming',
      platform_type: 'pc',
      last_verified_month: '2025-08',
      last_synced_source: 'rawg',
      steam_id: 555,
      korea_name: null,
      steam_price: 'N/A',
      steam_type: 'game',
      dlc_list: [111, 112],
      steam_reviews_positive: 10,
      steam_reviews_total: 12,
      steam_review_score: 'Very Positive',
    });
  };

  const createDetailEntity = (): GameDetail => {
    return Object.assign(new GameDetail(), {
      id: 1,
      game_id: 1,
      slug_name: 'astral-frontier',
      tags: ['Spaceship'],
      rating: 4.1,
      early_access: false,
      ratings_count: 86,
      screenshots: ['https://cdn.example.com/screens/1.jpg'],
      store_links: { steam: 'https://store.steampowered.com/app/555' },
      esrb_rating: 'Teen',
      description: null,
      website: 'https://astral-frontier.example.com',
      korean_description: null,
      steam_categories: ['Single-player'],
    });
  };

  const createIncomingData = (overrides: Partial<GameCalendarData> = {}): GameCalendarData => ({
    rawg_id: 123,
    name: overrides.name ?? 'Astral Frontier',
    original_name: 'Astral Frontier',
    slug_name: 'astral-frontier',
    release_date: overrides.release_date ?? '2025-08-15',
    release_status: overrides.release_status ?? 'upcoming',
    tba: false,
    platform_type: overrides.platform_type ?? 'pc',
    platforms: overrides.platforms ?? ['pc', 'playstation5'],
    genres: overrides.genres ?? ['Action'],
    tags: overrides.tags ?? ['Spaceship'],
    developers: overrides.developers ?? ['Nebula Works'],
    publishers: overrides.publishers ?? ['Lionheart Games'],
    rating: overrides.rating ?? 4.2,
    ratings_count: overrides.ratings_count ?? 100,
    esrb_rating: overrides.esrb_rating ?? 'Teen',
    required_age: null,
    early_access: false,
    description: overrides.description ?? 'Fresh space adventure',
    korean_description: overrides.korean_description ?? 'Korean support planned',
    website: overrides.website ?? 'https://astral-frontier.example.com',
    image: overrides.image ?? 'https://cdn.example.com/astral-updated.jpg',
    screenshots: overrides.screenshots ?? [
      'https://cdn.example.com/screens/1.jpg',
      'https://cdn.example.com/screens/2.jpg',
    ],
    trailer_url: null,
    store_links: overrides.store_links ?? {
      steam: 'https://store.steampowered.com/app/555',
      playstation: 'https://store.playstation.com/astral-frontier',
    },
    price: overrides.price ?? 'KRW 29,000',
    currency: 'KRW',
    steam_integrated: overrides.steam_integrated ?? true,
    steam_type: overrides.steam_type ?? 'game',
    korea_name: overrides.korea_name ?? 'Astral Frontier',
    is_full_game: true,
    dlc_list: overrides.dlc_list ?? [111, 112],
    is_free: false,
    review_summary: overrides.review_summary ?? {
      review_score: 8,
      review_score_desc: 'Very Positive',
      total_positive: 1200,
      total_negative: 100,
      total_reviews: 1300,
    },
    metacritic: overrides.metacritic ?? { score: 83, url: 'https://m.example.com' },
    is_dlc: overrides.is_dlc ?? false,
    parent_rawg_id: overrides.parent_rawg_id ?? null,
    parent_steam_id: overrides.parent_steam_id ?? null,
    game_type: overrides.game_type ?? 'main_game',
    game_type_confidence: overrides.game_type_confidence ?? 0.95,
    game_type_reason: overrides.game_type_reason ?? 'Steam base game',
    last_verified_month: overrides.last_verified_month ?? '2025-09',
    last_synced_source: overrides.last_synced_source ?? 'steam',
    added: overrides.added ?? 234,
    added_by_status: overrides.added_by_status ?? { wishlist: 134 },
    dlc_context: overrides.dlc_context ?? {
      classification: {
        type: 'main_game',
        confidence: 0.95,
        reason: 'Steam base game',
        strategies: ['Astral Frontier'],
      },
    },
    categories: overrides.categories ?? ['Single-player'],
  });

  it('변경된 필드를 정확히 감지한다', () => {
    const existingGame = createGameEntity();
    const existingDetail = createDetailEntity();
    const incoming = createIncomingData();

    const evaluation = evaluator.evaluate(existingGame, existingDetail, incoming);

    expect(evaluation.shouldUpdateGame).toBe(true);
    expect(evaluation.gameDiff.changedPaths).toEqual(
      expect.arrayContaining(['game.platforms', 'game.price', 'game.last_verified_month']),
    );
    expect(evaluation.shouldUpdateDetail).toBe(true);
    expect(evaluation.detailDiff.changedPaths).toEqual(
      expect.arrayContaining(['detail.store_links', 'detail.korean_description']),
    );
  });

  it('동일한 데이터는 변경으로 처리하지 않는다', () => {
    const existingGame = createGameEntity();
    const existingDetail = createDetailEntity();
    const baseline = DataMapper.mapFromGameEntity(existingGame, existingDetail);
    const incoming = { ...baseline };

    const evaluation = evaluator.evaluate(existingGame, existingDetail, incoming);

    expect(evaluation.shouldUpdateGame).toBe(false);
    expect(evaluation.shouldUpdateDetail).toBe(false);
    expect(evaluation.gameDiff.changedPaths).toHaveLength(0);
    expect(evaluation.detailDiff.changedPaths).toHaveLength(0);
  });

  it('기존 상세가 없고 새 페이로드가 있으면 상세 생성이 필요하다', () => {
    const existingGame = createGameEntity();
    const incoming = createIncomingData({
      store_links: { steam: 'https://store.steampowered.com/app/555' },
      korean_description: 'Localized description',
    });

    const evaluation = evaluator.evaluate(existingGame, null, incoming);

    expect(evaluation.shouldUpdateDetail).toBe(true);
    expect(evaluation.detailDiff.created).toContain('detail');
  });
});
