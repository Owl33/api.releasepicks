import { GameClassificationService } from '../../../src/unified-game/services/game-classification.service';
import { GameCalendarData } from '../../../src/types/game-calendar-unified.types';

const createBaseGame = (overrides: Partial<GameCalendarData> = {}): GameCalendarData => ({
  rawg_id: overrides.rawg_id ?? 100,
  name: overrides.name ?? 'Sample Game',
  original_name: overrides.original_name ?? overrides.name ?? 'Sample Game',
  slug_name: overrides.slug_name ?? 'sample-game',
  release_date: overrides.release_date ?? '2025-01-01',
  release_status: overrides.release_status ?? 'upcoming',
  tba: overrides.tba ?? false,
  platform_type: overrides.platform_type ?? 'pc',
  platforms: overrides.platforms ?? ['pc'],
  genres: overrides.genres ?? [],
  tags: overrides.tags ?? [],
  developers: overrides.developers ?? [],
  publishers: overrides.publishers ?? [],
  rating: overrides.rating,
  ratings_count: overrides.ratings_count,
  esrb_rating: overrides.esrb_rating ?? null,
  required_age: overrides.required_age ?? null,
  early_access: overrides.early_access ?? false,
  description: overrides.description,
  korean_description: overrides.korean_description,
  website: overrides.website ?? null,
  image: overrides.image ?? null,
  screenshots: overrides.screenshots ?? [],
  trailer_url: overrides.trailer_url ?? null,
  store_links: overrides.store_links ?? {},
  price: overrides.price ?? null,
  currency: overrides.currency ?? null,
  steam_integrated: overrides.steam_integrated ?? false,
  steam_type: overrides.steam_type ?? null,
  korea_name: overrides.korea_name ?? null,
  is_full_game: overrides.is_full_game ?? null,
  dlc_list: overrides.dlc_list ?? [],
  is_free: overrides.is_free ?? false,
  review_summary: overrides.review_summary,
  metacritic: overrides.metacritic ?? null,
  is_dlc: overrides.is_dlc ?? false,
  parent_rawg_id: overrides.parent_rawg_id ?? null,
  parent_steam_id: overrides.parent_steam_id ?? null,
  game_type: overrides.game_type ?? 'standalone',
  game_type_confidence: overrides.game_type_confidence ?? null,
  game_type_reason: overrides.game_type_reason ?? null,
  last_verified_month: overrides.last_verified_month ?? null,
  last_synced_source: overrides.last_synced_source ?? null,
  added: overrides.added ?? 0,
  added_by_status: overrides.added_by_status ?? {},
  dlc_context: overrides.dlc_context,
  categories: overrides.categories ?? [],
});

describe('GameClassificationService', () => {
  let service: GameClassificationService;

  beforeEach(() => {
    service = new GameClassificationService();
  });

  it('DLC 네이밍과 RAWG/Steam 맥락을 바탕으로 DLC로 분류한다', () => {
    const analysis = service.analyzeName('Galactic War: Expansion Pack');
    const classification = service.classify(analysis, {
      rawgName: 'Galactic War: Expansion Pack',
      parentsCount: 2,
      additionsCount: 0,
      hasStoreLink: true,
      steamType: 'dlc',
      dlcList: [],
      hasFullgameInfo: true,
    });

    const baseGame = createBaseGame({
      name: 'Galactic War: Expansion Pack',
      steam_type: 'dlc',
      dlc_context: {
        rawg_parent_ids: [10],
      },
    });

    const annotated = service.applyClassification(baseGame, classification);

    expect(classification.gameType).toBe('dlc');
    expect(classification.confidence).toBeGreaterThanOrEqual(0.95);
    expect(annotated.is_dlc).toBe(true);
    expect(annotated.game_type_reason).toContain('RAWG');
  });

  it('주요 단서가 없으면 독립 게임으로 분류한다', () => {
    const analysis = service.analyzeName('Azure Frontier');
    const classification = service.classify(analysis, {
      rawgName: 'Azure Frontier',
      parentsCount: 0,
      additionsCount: 0,
      hasStoreLink: true,
      steamType: 'game',
      dlcList: [],
      hasFullgameInfo: false,
    });

    expect(classification.gameType).toBe('main_game');
    expect(classification.confidence).toBeGreaterThan(0.8);
  });

  it('검색 전략을 DLC 규칙에 맞게 생성한다', () => {
    const phrase = "Legends Reborn: Collector's Pack";
    const analysis = service.analyzeName(phrase);
    const strategies = service.generateSearchStrategies(analysis, phrase);

    expect(strategies).toContain('Legends Reborn');
    expect(strategies[0].length).toBeGreaterThanOrEqual(3);
  });
});
