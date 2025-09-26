import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, BadRequestException } from '@nestjs/common';
import request from 'supertest';

import { UnifiedGameController } from '../src/unified-game/unified-game.controller';
import { UnifiedGameService } from '../src/unified-game/unified-game.service';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import {
  GameCalendarData,
  MonthlyUnifiedGameResult,
  UnifiedGameOptions,
} from '../src/types/game-calendar-unified.types';

const sampleGame: GameCalendarData = {
  rawg_id: 4000,
  name: 'Azure Frontier',
  original_name: 'Azure Frontier',
  slug_name: 'azure-frontier',
  release_date: '2025-08-01',
  release_status: 'upcoming',
  tba: false,
  platform_type: 'mixed',
  platforms: ['pc', 'playstation5'],
  genres: ['Action'],
  tags: ['Adventure'],
  developers: ['Skyline'],
  publishers: ['Lionheart'],
  rating: 4.2,
  ratings_count: 86,
  esrb_rating: 'Teen',
  required_age: null,
  early_access: false,
  description: 'New space adventure',
  korean_description: 'Korean support planned',
  website: 'https://azure-frontier.example.com',
  image: 'https://cdn.example.com/azure.png',
  screenshots: ['https://cdn.example.com/azure-1.png'],
  trailer_url: 'https://youtube.com/watch?v=azure',
  store_links: {
    steam: 'https://store.steampowered.com/app/4000',
  },
  price: 'KRW 59,000',
  currency: 'KRW',
  steam_integrated: true,
  steam_type: 'game',
  korea_name: 'Azure Frontier',
  is_full_game: true,
  dlc_list: [],
  is_free: false,
  review_summary: {
    review_score: 8,
    review_score_desc: 'Very Positive',
    total_positive: 1200,
    total_negative: 100,
    total_reviews: 1300,
  },
  metacritic: {
    score: 84,
    url: 'https://www.metacritic.com/game/azure-frontier',
  },
  is_dlc: false,
  parent_rawg_id: null,
  parent_steam_id: null,
  game_type: 'main_game',
  game_type_confidence: 0.95,
  game_type_reason: 'Steam base game',
  last_verified_month: '2025-07',
  last_synced_source: 'steam',
  added: 320,
  added_by_status: { wishlist: 180, owned: 140 },
  dlc_context: undefined,
  categories: ['Single-player'],
};

describe('UnifiedGameController (e2e)', () => {
  let app: INestApplication;
const serviceMock: Partial<UnifiedGameService> = {
    processGamesForMonth: jest.fn(async (month: string, options: UnifiedGameOptions) => {
      const result: MonthlyUnifiedGameResult = {
        month,
        total_games: 1,
        pc_games: 1,
        console_games: 1,
        steam_integrated_games: 1,
        games: [sampleGame],
        collection_stats: {
          rawg_api_calls: 3,
          steam_api_calls: 2,
          steam_success_rate: 100,
          processing_time_ms: 1200,
          dlc_filtered: 0,
        },
      };
      return result;
    }),
    saveUnifiedGamesToDatabase: jest.fn(async () => ({
      saved: 1,
      skipped: 0,
      errors: 0,
    })),
    updateGame: jest.fn(async (rawgId: number, payload) => {
      if (!payload || Object.keys(payload).length === 0) {
        throw new BadRequestException('최소 한 개 이상의 수정 가능한 필드가 필요합니다.');
      }

      return {
        success: true,
        rawg_id: rawgId,
        updated_fields: Object.keys(payload),
        skipped: false,
        ingest_log_id: 'ingest-log-1',
      };
    }),
    clearBatchCache: jest.fn(async () => undefined),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [UnifiedGameController],
      providers: [
        {
          provide: UnifiedGameService,
          useValue: serviceMock,
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /unified-games/:month 응답 구조를 반환한다', async () => {
    const response = await request(app.getHttpServer())
      .get('/unified-games/2025-10')
      .query({ maxGames: '5', enableSteamIntegration: 'true', minPopularity: '2' })
      .expect(200);

    expect(serviceMock.processGamesForMonth).toHaveBeenCalledWith('2025-10', {
      max_games: 5,
      enable_steam_integration: true,
      min_popularity: 2,
      steam_timeout: 10000,
      include_early_access: true,
    });

    expect(response.body.success).toBe(true);
    expect(response.body.data.games[0].name).toBe('Azure Frontier');
    expect(response.body.message).toEqual(expect.stringContaining('\uC870\uD68C'));
  });

  it('POST /unified-games/save/:month 저장 결과를 반환한다', async () => {
    const response = await request(app.getHttpServer())
      .post('/unified-games/save/2025-10')
      .query({ maxGames: '3', enableSteamIntegration: 'false' })
      .expect(201);

    expect(serviceMock.saveUnifiedGamesToDatabase).toHaveBeenCalledWith('2025-10', {
      max_games: 3,
      enable_steam_integration: false,
      min_popularity: 3,
      steam_timeout: 10000,
      include_early_access: true,
    });

    expect(response.body.success).toBe(true);
    expect(response.body.data.saved).toBe(1);
    expect(response.body.message).toEqual(expect.stringContaining('\uC800\uC7A5'));
  });

  it('PATCH /unified-games/games/:rawgId 부분 업데이트를 수행한다', async () => {
    const response = await request(app.getHttpServer())
      .patch('/unified-games/games/12345')
      .send({ price: '₩32,000', steam_review_score: 'Very Positive' })
      .expect(200);

    expect(serviceMock.updateGame).toHaveBeenCalledWith(12345, {
      price: '₩32,000',
      steam_review_score: 'Very Positive',
    });

    expect(response.body.success).toBe(true);
    expect(response.body.updated_fields).toContain('price');
    expect(response.body.ingest_log_id).toBe('ingest-log-1');
  });

  it('PATCH /unified-games/games/:rawgId 입력이 없으면 400을 반환한다', async () => {
    await request(app.getHttpServer())
      .patch('/unified-games/games/12345')
      .send({})
      .expect(400);
  });
});
