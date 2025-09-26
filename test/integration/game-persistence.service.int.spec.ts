import { join } from 'path';
import { readFileSync } from 'fs';

import { GamePersistenceService } from '../../src/unified-game/services/game-persistence.service';
import { GameUpdateEvaluator } from '../../src/unified-game/persistence/game-update.evaluator';
import { Game } from '../../src/entities/game.entity';
import { GameDetail } from '../../src/entities/game-detail.entity';
import { IngestLog } from '../../src/entities/ingest-log.entity';
import { GameCalendarData, MonthlyUnifiedGameResult } from '../../src/types/game-calendar-unified.types';
import { UnifiedGameOptions } from '../../src/types/game-calendar-unified.types';

interface PersistenceStore {
  games: Array<Game & { game_detail?: GameDetail | null }>;
  details: GameDetail[];
  gameId: number;
  detailId: number;
}

class FakeQueryRunner {
  manager: any;

  constructor(private readonly store: PersistenceStore) {
    this.manager = {
      findOne: jest.fn(async (Entity: any, options: any) => {
        if (Entity === Game) {
          if (options?.where?.rawg_id) {
            return (
              this.store.games.find(
                (game) => game.rawg_id === options.where.rawg_id,
              ) || null
            );
          }
          if (options?.where?.steam_id) {
            return (
              this.store.games.find(
                (game) => game.steam_id === options.where.steam_id,
              ) || null
            );
          }
        }
        if (Entity === GameDetail) {
          if (options?.where?.game_id) {
            return (
              this.store.details.find(
                (detail) => detail.game_id === options.where.game_id,
              ) || null
            );
          }
        }
        return null;
      }),
      create: jest.fn((Entity: any, payload: any) => {
        if (Entity === Game) {
          return Object.assign(new Game(), payload);
        }
        if (Entity === GameDetail) {
          return Object.assign(new GameDetail(), payload);
        }
        return { ...payload };
      }),
      save: jest.fn(async (entity: any) => {
        if (entity instanceof Game) {
          if (!entity.id) {
            this.store.gameId += 1;
            entity.id = this.store.gameId;
            this.store.games.push(entity);
          }
          return entity;
        }
        if (entity instanceof GameDetail) {
          if (!entity.id) {
            this.store.detailId += 1;
            entity.id = this.store.detailId;
            this.store.details.push(entity);
          } else {
            const index = this.store.details.findIndex(
              (detail) => detail.id === entity.id,
            );
            if (index >= 0) {
              this.store.details[index] = entity;
            }
          }

          const parentGame = this.store.games.find(
            (game) => game.id === entity.game_id,
          );
          if (parentGame) {
            parentGame.game_detail = entity;
          }

          return entity;
        }
        return entity;
      }),
    };
  }

  async connect(): Promise<void> {}
  async startTransaction(): Promise<void> {}
  async commitTransaction(): Promise<void> {}
  async rollbackTransaction(): Promise<void> {}
  async release(): Promise<void> {}
}

class FakeDataSource {
  constructor(private readonly store: PersistenceStore) {}

  createQueryRunner(): FakeQueryRunner {
    return new FakeQueryRunner(this.store);
  }
}

describe('GamePersistenceService.integrated', () => {
  const fixturePath = join(
    __dirname,
    '../fixtures/mapping/steam-merged.sample.json',
  );
  const fixture = JSON.parse(
    readFileSync(fixturePath, 'utf-8'),
  ) as GameCalendarData;

  const createService = (
    initialStore?: Partial<PersistenceStore>,
  ): {
    service: GamePersistenceService;
    store: PersistenceStore;
    ingestLogs: IngestLog[];
    ingestLogRepository: { save: jest.Mock };
  } => {
    const store: PersistenceStore = {
      games: initialStore?.games ?? [],
      details: initialStore?.details ?? [],
      gameId: initialStore?.gameId ?? 0,
      detailId: initialStore?.detailId ?? 0,
    };

    const dataSource = new FakeDataSource(store) as any;
    const ingestLogs: IngestLog[] = [];
    const ingestLogRepository = {
      save: jest.fn(async (payload) => {
        ingestLogs.push(payload as IngestLog);
        return payload;
      }),
    };

    const evaluator = new GameUpdateEvaluator();

    const service = GamePersistenceService.create({
      dataSource,
      ingestLogRepository: ingestLogRepository as any,
      updateEvaluator: evaluator,
    });

    return { service, store, ingestLogs, ingestLogRepository };
  };

  const buildOptions = (): Required<UnifiedGameOptions> => ({
    max_games: 1,
    enable_steam_integration: true,
    min_popularity: 0,
    include_early_access: true,
    steam_timeout: 5000,
  });

  const buildProcessingResult = (
    games: GameCalendarData[],
  ): MonthlyUnifiedGameResult => ({
    month: '2025-10',
    total_games: games.length,
    pc_games: 1,
    console_games: 0,
    steam_integrated_games: games.filter((g) => g.steam_integrated).length,
    games,
    collection_stats: {
      rawg_api_calls: 3,
      steam_api_calls: 2,
      steam_success_rate: 100,
      processing_time_ms: 1200,
      dlc_filtered: games.filter((g) => g.is_dlc).length,
    },
  });

  it('신규 저장, 업데이트, 스킵 경로를 모두 처리한다', async () => {
    const { service, store, ingestLogs, ingestLogRepository } = createService();
    const options = buildOptions();

    const firstResult = await service.persistBatch(
      [fixture],
      '2025-10',
      options,
      buildProcessingResult([fixture]),
    );

    expect(firstResult).toEqual({ saved: 1, skipped: 0, errors: 0 });
    expect(store.games).toHaveLength(1);
    expect(store.details).toHaveLength(1);

    const updatedFixture: GameCalendarData = {
      ...fixture,
      price: '₩25,000',
      review_summary: {
        review_score: 9,
        review_score_desc: '압도적으로 긍정적',
        total_positive: 2000,
        total_negative: 100,
        total_reviews: 2100,
      },
      last_verified_month: '2025-11',
      last_synced_source: 'steam',
    };

    const secondResult = await service.persistBatch(
      [updatedFixture],
      '2025-11',
      options,
      buildProcessingResult([updatedFixture]),
    );

    expect(secondResult.saved).toBe(1);
    expect(store.games[0].steam_price).toBe('₩25,000');
    expect(store.games[0].last_verified_month).toBe('2025-11');

    const thirdResult = await service.persistBatch(
      [updatedFixture],
      '2025-12',
      options,
      buildProcessingResult([updatedFixture]),
    );

    expect(thirdResult.skipped).toBe(1);
    expect(ingestLogRepository.save).toHaveBeenCalledTimes(3);
    expect(ingestLogs[ingestLogs.length - 1]).toEqual(
      expect.objectContaining({ status: 'success' }),
    );
  });

  it('DLC 저장 시 parent_game_id와 parent_steam_game_id를 연결한다', async () => {
    const parentGame = Object.assign(new Game(), {
      id: 10,
      rawg_id: 12345,
      steam_id: 7777,
      name: 'Parent Base Game',
      released: new Date('2024-08-10'),
      platforms: ['pc'],
      genres: ['Action'],
      added: 100,
      image: 'https://example.com/base.png',
      developers: ['Parent Studio'],
      publishers: ['Parent Publisher'],
      release_status: 'released',
      platform_type: 'pc',
    });

    const { service, store } = createService({
      games: [parentGame],
      details: [],
      gameId: 10,
      detailId: 0,
    });

    const dlc: GameCalendarData = {
      ...fixture,
      rawg_id: 54321,
      name: 'Parent Base Game DLC',
      is_dlc: true,
      parent_rawg_id: 12345,
      parent_steam_id: 7777,
      steam_integrated: true,
      dlc_context: {
        rawg_parent_ids: [12345],
        steam_fullgame_info: { appid: '7777', name: 'Parent Base Game' },
      },
    };

    const result = await service.persistBatch(
      [dlc],
      '2025-12',
      buildOptions(),
      buildProcessingResult([dlc]),
    );

    expect(result.saved).toBe(1);
    const savedDlc = store.games.find((game) => game.rawg_id === dlc.rawg_id);
    expect(savedDlc).toBeDefined();
    expect(savedDlc?.parent_game_id).toBe(parentGame.id);
    expect(savedDlc?.parent_steam_game_id).toBe(7777);
    expect(savedDlc?.rawg_parent_ids).toEqual([12345]);
  });
});
