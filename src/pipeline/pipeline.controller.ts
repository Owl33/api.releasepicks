import {
  Controller,
  Post,
  Query,
  Logger,
  ValidationPipe,
  UsePipes,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager, ILike } from 'typeorm';

import { Game } from '../entities/game.entity';
import { GameDetail } from '../entities/game-detail.entity';
import { GameRelease } from '../entities/game-release.entity';
import { Company } from '../entities/company.entity';
import { GameCompanyRole } from '../entities/game-company-role.entity';
import { PipelineRun } from '../entities/pipeline-run.entity';
import { PipelineItem } from '../entities/pipeline-item.entity';

import { SteamDataPipelineService } from '../steam/services/steam-data-pipeline.service';
import { RawgDataPipelineService } from '../rawg/rawg-data-pipeline.service';
import { SteamBatchStrategyService } from '../steam/services/steam-batch-strategy.service';

import {
  ProcessedGameData,
  GameDetailsData,
  GameReleaseData,
  CompanyData,
  ApiResponse,
  PipelineRunResult,
} from './types/pipeline.types';

import { ManualPipelineDto } from './dto/manual-pipeline.dto';

/**
 * Pipeline Controller
 * 역할: Steam/RAWG 서비스에서 수집한 데이터를 데이터베이스에 저장
 * - Steam/RAWG 서비스는 조회/가공만 담당
 * - Pipeline Controller는 저장 로직만 담당
 * - POST + PATCH 자동 판별
 * - 트랜잭션 보장
 */

@Controller('api/pipeline')
export class PipelineController {
  private readonly logger = new Logger(PipelineController.name);

  constructor(
    private readonly steamDataPipeline: SteamDataPipelineService,
    private readonly rawgDataPipeline: RawgDataPipelineService,
    private readonly steamBatchStrategy: SteamBatchStrategyService,
    @InjectRepository(Game)
    private readonly gamesRepository: Repository<Game>,
    @InjectRepository(GameDetail)
    private readonly gameDetailsRepository: Repository<GameDetail>,
    @InjectRepository(GameRelease)
    private readonly gameReleasesRepository: Repository<GameRelease>,
    @InjectRepository(PipelineRun)
    private readonly pipelineRunsRepository: Repository<PipelineRun>,
    @InjectRepository(PipelineItem)
    private readonly pipelineItemsRepository: Repository<PipelineItem>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * 통합 자동 스케줄링 (매주 화요일 02:00)
   * Steam + RAWG 데이터를 병렬로 수집하고 통합 저장
   */
  @Cron('0 2 * * 2', {
    name: 'automatic-pipeline',
    timeZone: 'Asia/Seoul',
  })
  async executeAutomaticPipeline(): Promise<void> {
    const startTime = Date.now();

    this.logger.log('🚀 [자동 파이프라인] 시작');
    this.logger.log('   - mode: operational');
    this.logger.log('   - Steam limit: 5000 (priority 전략)');
    this.logger.log('   - RAWG: 18개월 월별 수집');

    const pipelineRun = await this.createPipelineRun('automatic', 'full');

    try {
      // Steam + RAWG 병렬 수집
      this.logger.log('📥 [자동 파이프라인] Steam + RAWG 데이터 수집 시작');
      const [steamData, rawgData] = await Promise.all([
        this.steamDataPipeline.collectProcessedData({
          mode: 'operational',
          limit: 5000,
          strategy: 'priority',
        }),
        this.rawgDataPipeline.collectProcessedData(),
      ]);

      this.logger.log(
        `✨ [자동 파이프라인] Steam: ${steamData.length}/5000개, RAWG: ${rawgData.length}개 수집 완료`,
      );

      // 통합 저장 (POST + PATCH 자동 판별)
      this.logger.log(
        `💾 [자동 파이프라인] ${steamData.length + rawgData.length}개 게임 저장 시작`,
      );
      const allData = [...steamData, ...rawgData];
      const saveResult = await this.saveIntegratedData(allData, pipelineRun.id);

      const duration = Date.now() - startTime;
      const durationSeconds = (duration / 1000).toFixed(2);

      await this.completePipelineRun(
        pipelineRun.id,
        'completed',
        undefined,
        allData.length,
        saveResult.created + saveResult.updated,
        saveResult.failed,
      );
      this.logger.log('✅ [자동 파이프라인] 완료');
      this.logger.log(`   - 총 처리 시간: ${durationSeconds}초`);
      this.logger.log(
        `   - 성공: ${saveResult.created + saveResult.updated}개`,
      );
      this.logger.log(`   - 실패: ${saveResult.failed}개`);
    } catch (error) {
      const duration = Date.now() - startTime;
      const durationSeconds = (duration / 1000).toFixed(2);

      this.logger.error(`❌ [자동 파이프라인] 실패 (${durationSeconds}초)`);
      this.logger.error(`   - 오류: ${error.message}`, error.stack);

      await this.completePipelineRun(pipelineRun.id, 'failed', error.message);
      throw error;
    }
  }

  /**
   * 수동 실행 API (관리자 전용)
   * Query Parameters:
   * - phase: 'steam' | 'rawg' | 'full' (기본: 'full')
   * - mode: 'bootstrap' | 'operational' (기본: 'bootstrap')
   * - limit: number (기본: 200, 최소: 1, 최대: 10000)
   * - strategy: 'latest' | 'priority' | 'incremental' |batch (기본: 'latest')
   */
  @Post('manual')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  async executeManualPipeline(
    @Query() params: ManualPipelineDto,
  ): Promise<ApiResponse<PipelineRunResult>> {
    // DTO 기본값 보장 (ValidationPipe transform 후 undefined 방지)
    const phase = params.phase ?? 'full';
    const mode = params.mode ?? 'bootstrap';
    const limit = params.limit ?? 200;
    const strategy = params.strategy ?? 'latest';
    const startTime = Date.now();

    this.logger.log(`🚀 [수동 파이프라인] 시작`);
    this.logger.log(`   - phase: ${phase}`);
    this.logger.log(`   - mode: ${mode}`);
    this.logger.log(`   - limit: ${limit}`);
    this.logger.log(`   - strategy: ${strategy}`);

    const pipelineRun = await this.createPipelineRun('manual', phase);

    try {
      let data: ProcessedGameData[] = [];
      let steamCount = 0;
      let rawgCount = 0;

      // Steam 데이터 수집
      if (phase === 'steam' || phase === 'full') {
        this.logger.log('📥 [수동 파이프라인] Steam 데이터 수집 시작');

        let steamData: any[];

        // ✅ strategy=batch: 점진적 배치 수집 (사용자 지정 limit 또는 자동 커서 전진)
        if (strategy === 'batch') {
          this.logger.log(
            `🔄 [수동 파이프라인] 배치 전략 - 점진적 수집 시작${limit ? ` (limit: ${limit}개)` : ' (자동 배치 크기)'}`,
          );
          steamData = await this.steamDataPipeline.collectBatchData(limit);
          this.logger.log(
            `✨ [수동 파이프라인] Steam 배치: ${steamData.length}개 수집 완료`,
          );
        } else {
          // 기존: latest/priority/incremental 전략
          steamData = await this.steamDataPipeline.collectProcessedData({
            mode,
            limit,
            strategy,
          });
          this.logger.log(
            `✨ [수동 파이프라인] Steam: ${steamData.length}/${limit}개 수집 완료`,
          );
        }

        data = [...data, ...steamData];
        steamCount = steamData.length;
      }

      // RAWG 데이터 수집
      if (phase === 'rawg' || phase === 'full') {
        this.logger.log('📥 [수동 파이프라인] RAWG 데이터 수집 시작');
        const rawgData = await this.rawgDataPipeline.collectProcessedData();
        data = [...data, ...rawgData];
        rawgCount = rawgData.length;
        this.logger.log(`✨ [수동 파이프라인] RAWG: ${rawgCount}개 수집 완료`);
      }

      // 통합 저장
      this.logger.log(`💾 [수동 파이프라인] ${data.length}개 게임 저장 시작`);
      const saveResult = await this.saveIntegratedData(data, pipelineRun.id);

      // saveResult는 최소한 아래 형태라고 가정
      // type SaveResult = { created: number; updated: number; failed: number; failedItems?: any[] };

      if (strategy === 'batch' && (phase === 'steam' || phase === 'full')) {
        const createdCount = saveResult?.created ?? 0;
        const updatedCount = saveResult?.updated ?? 0;
        const failedCount = saveResult?.failed ?? 0;

        // ✅ "시도한 개수"로 커서를 전진: 성공 + 실패 = 이번 라운드에서 소비한 입력 수
        // const attemptedCount = createdCount + updatedCount + failedCount;
        const attemptedCount = limit;

        await this.steamBatchStrategy.updateBatchProgress(limit);

        this.logger.log(
          `📊 [배치 진행 상태] attempted=${attemptedCount} (created:${createdCount}, updated:${updatedCount}, failed:${failedCount}) → 커서 +${attemptedCount}`,
        );
      }
      const duration = Date.now() - startTime;
      const durationSeconds = (duration / 1000).toFixed(2);

      await this.completePipelineRun(
        pipelineRun.id,
        'completed',
        undefined,
        data.length,
        saveResult.created + saveResult.updated,
        saveResult.failed,
      );
      this.logger.log(`✅ [수동 파이프라인] 완료`);
      this.logger.log(`   - 총 처리 시간: ${durationSeconds}초`);
      this.logger.log(
        `   - 성공: ${saveResult.created + saveResult.updated}개`,
      );
      this.logger.log(`   - 실패: ${saveResult.failed}개`);

      return {
        statusCode: 200,
        message: '파이프라인 수동 실행 완료',
        data: {
          pipelineRunId: pipelineRun.id,
          phase,
          totalProcessed: data.length,
          finishedAt: new Date(),
        },
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const durationSeconds = (duration / 1000).toFixed(2);

      this.logger.error(`❌ [수동 파이프라인] 실패 (${durationSeconds}초)`);
      this.logger.error(`   - 오류: ${error.message}`);

      await this.completePipelineRun(pipelineRun.id, 'failed', error.message);
      throw error;
    }
  }

  /**
   * POST + PATCH 자동 판별 저장
   * 각 게임은 독립적인 트랜잭션으로 처리
   */
  private async saveIntegratedData(
    data: ProcessedGameData[],
    pipelineRunId: number,
  ): Promise<{ created: number; updated: number; failed: number }> {
    let createdCount = 0;
    let updatedCount = 0;
    let failedCount = 0;
    const totalCount = data.length;

    // 진행 상황 로그 주기 (매 10개마다 또는 전체의 10%마다)
    const logInterval = Math.max(10, Math.floor(totalCount * 0.1));
    for (let i = 0; i < data.length; i++) {
      const gameData = data[i];
      try {
        // 각 게임은 독립적인 트랜잭션으로 처리
        await this.dataSource.transaction(async (manager) => {
          const existingGame = await this.findExistingGame(gameData, manager);

          if (existingGame) {
            // PATCH: 기존 게임 업데이트
            await this.updateGame(existingGame.id, gameData, manager);
            await this.createPipelineItem(
              pipelineRunId,
              'game',
              existingGame.id,
              'updated',
              manager,
            );
            updatedCount++;
          } else {
            // POST: 신규 게임 생성
            const newGame = await this.createGame(gameData, manager);
            for (const [k, v] of Object.entries(newGame)) {
              if (typeof v === 'number' && Number.isNaN(v)) {
                console.error(
                  `❌ ${k} is NaN`,
                  gameData[k as keyof typeof gameData],
                );
              }
            }
            await this.createPipelineItem(
              pipelineRunId,
              'game',
              newGame.id,
              'created',
              manager,
            );
            createdCount++;
          }
        });
      } catch (error) {
        this.logger.error(
          `❌ [통합 저장] 게임 저장 실패 (${gameData.name}): ${error.message} ${gameData.details}, `,
        );
        failedCount++;
      }

      // 진행 상황 로그 (주기적으로 출력)
      if ((i + 1) % logInterval === 0 || i + 1 === totalCount) {
        const processed = i + 1;
        const percentage = ((processed / totalCount) * 100).toFixed(1);
        this.logger.log(
          `📊 [통합 저장] 진행 중: ${processed}/${totalCount} (${percentage}%) - 생성: ${createdCount}, 업데이트: ${updatedCount}, 실패: ${failedCount}`,
        );
      }
    }

    this.logger.log(
      `✅ [통합 저장] 완료 - 생성: ${createdCount}, 업데이트: ${updatedCount}, 실패: ${failedCount}`,
    );

    return {
      created: createdCount,
      updated: updatedCount,
      failed: failedCount,
    };
  }

  /**
   * 기존 게임 찾기 (Steam ID 또는 RAWG ID 기반)
   */
  private async findExistingGame(
    gameData: ProcessedGameData,
    manager: EntityManager,
  ): Promise<Game | null> {
    if (gameData.steamId) {
      return manager.findOne(Game, {
        where: { steam_id: gameData.steamId },
      });
    }
    if (gameData.rawgId) {
      return manager.findOne(Game, {
        where: { rawg_id: gameData.rawgId },
      });
    }
    return null;
  }

  /**
   * 신규 게임 생성 (POST 로직)
   */
  private async createGame(
    gameData: ProcessedGameData,
    manager: EntityManager,
  ): Promise<Game> {
    // ===== Phase 5.5: DLC 분기 처리 =====
    const isDlc = gameData.isDlc ?? false;
    // 1. games 테이블 저장
    const game = manager.create(Game, {
      name: gameData.name,
      slug: gameData.slug,
      steam_id: gameData.steamId ?? null,
      rawg_id: gameData.rawgId ?? null,
      game_type: gameData.gameType,
      parent_steam_id: gameData.parentSteamId ?? null,
      parent_rawg_id: gameData.parentRawgId ?? null,
      parent_reference_type: gameData.parentReferenceType,
      is_dlc: isDlc, // Phase 5.5
      platform_type: gameData.platformType, // Phase 5.5
      release_date_date: gameData.releaseDate,
      release_date_raw: gameData.releaseDateRaw,
      release_status: gameData.releaseStatus,
      coming_soon: gameData.comingSoon,
      popularity_score: gameData.popularityScore,
      platforms_summary: gameData.platformsSummary,
      followers_cache: gameData.followersCache ?? null,
    });

    const savedGame = await manager.save(Game, game);

    // ===== Phase 5.5: DLC는 details/releases 미생성 =====
    if (isDlc) {
      this.logger.debug(
        `🎯 [DLC 저장] ${gameData.name} (Steam: ${gameData.steamId}, RAWG: ${gameData.rawgId})`,
      );
      return savedGame; // DLC는 여기서 종료
    }

    // 2. game_details 저장 (본편만, 인기도 40점 이상만)
    if (gameData.popularityScore >= 40 && gameData.details) {
      await this.saveGameDetails(savedGame.id, gameData.details, manager);
    }

    // 3. game_releases 저장 (본편만)
    if (gameData.releases && gameData.releases.length > 0) {
      await this.saveGameReleases(savedGame.id, gameData.releases, manager);
    }

    // 4. companies 및 game_company_role 저장
    if (gameData.companies && gameData.companies.length > 0) {
      await this.saveCompanies(savedGame.id, gameData.companies, manager);
    }

    return savedGame;
  }

  /**
   * 기존 게임 업데이트 (PATCH 로직 + Phase 5.5 패치 세맨틱)
   */
  private async updateGame(
    gameId: number,
    gameData: ProcessedGameData,
    manager: EntityManager,
  ): Promise<void> {
    // ===== Phase 5.5: 기존 게임 조회 =====
    const existingGame = await manager.findOne(Game, { where: { id: gameId } });
    if (!existingGame) {
      throw new Error(`게임을 찾을 수 없습니다: ${gameId}`);
    }

    const isDlc = gameData.isDlc ?? existingGame.is_dlc ?? false;

    // ===== Phase 5.5 패치 세맨틱: 필드별 갱신 정책 =====
    const updateData: Partial<Game> = {
      // 변동 가능 필드: 항상 갱신
      name: gameData.name,
      release_date_date: gameData.releaseDate,
      release_date_raw: gameData.releaseDateRaw,
      release_status: gameData.releaseStatus,
      coming_soon: gameData.comingSoon,
      popularity_score: gameData.popularityScore,
      platforms_summary: gameData.platformsSummary,
      followers_cache: gameData.followersCache ?? null,
      updated_at: new Date(),

      // Phase 5.5: 식별/불변 필드 (NULL일 때만 채움)
      steam_id: existingGame.steam_id ?? gameData.steamId,
      rawg_id: existingGame.rawg_id ?? gameData.rawgId,

      // Phase 5.5: 논리 플래그 (단방향, true 유지)
      is_dlc: existingGame.is_dlc || isDlc,

      // Phase 5.5: 부모 외부 ID (합집합, NULL로 덮지 않음)
      parent_steam_id: gameData.parentSteamId ?? existingGame.parent_steam_id,
      parent_rawg_id: gameData.parentRawgId ?? existingGame.parent_rawg_id,

      // Phase 5.5: 플랫폼 타입 (NULL일 때만 채움)
      platform_type: existingGame.platform_type ?? gameData.platformType,
    };

    // 1. games 테이블 업데이트
    await manager.update(Game, gameId, updateData);

    // ===== Phase 5.5: DLC는 details/releases 업데이트 스킵 =====
    if (isDlc) {
      this.logger.debug(
        `🎯 [DLC 업데이트] ${gameData.name} (Steam: ${gameData.steamId}, RAWG: ${gameData.rawgId})`,
      );
      return; // DLC는 여기서 종료
    }

    // 2. game_details 업데이트 (본편만, 인기도 40점 이상만)
    if (gameData.popularityScore >= 40 && gameData.details) {
      const existingDetails = await manager.findOne(GameDetail, {
        where: { game_id: gameId },
      });

      if (existingDetails) {
        // ✅ camelCase → snake_case 매핑
        await manager.update(
          GameDetail,
          { game_id: gameId },
          {
            screenshots: gameData.details.screenshots,
            video_url: gameData.details.videoUrl,
            description: gameData.details.description,
            website: gameData.details.website,
            genres: gameData.details.genres,
            tags: gameData.details.tags,
            support_languages: gameData.details.supportLanguages,
            metacritic_score: gameData.details.metacriticScore ?? null,
            opencritic_score: gameData.details.opencriticScore ?? null,
            rawg_added: gameData.details.rawgAdded ?? null,
            total_reviews: gameData.details.totalReviews ?? null,
            review_score_desc: gameData.details.reviewScoreDesc,
            platform_type: gameData.details.platformType,
            updated_at: new Date(),
          },
        );
      } else {
        await this.saveGameDetails(gameId, gameData.details, manager);
      }
    }

    // 3. game_releases 업데이트 (본편만, 중복 체크 후 추가/업데이트)
    if (gameData.releases && gameData.releases.length > 0) {
      await this.saveGameReleases(gameId, gameData.releases, manager);
    }

    // 4. companies 및 game_company_role 업데이트
    if (gameData.companies && gameData.companies.length > 0) {
      await this.saveCompanies(gameId, gameData.companies, manager);
    }
  }

  /**
   * game_details 저장
   */
  private async saveGameDetails(
    gameId: number,
    detailsData: GameDetailsData,
    manager: EntityManager,
  ): Promise<void> {
    const details = manager.create(GameDetail, {
      game_id: Number(gameId),
      screenshots: detailsData.screenshots,
      video_url: detailsData.videoUrl,
      description: detailsData.description,
      website: detailsData.website,
      genres: detailsData.genres,
      tags: detailsData.tags,
      support_languages: detailsData.supportLanguages,
      metacritic_score: detailsData.metacriticScore ?? null,
      opencritic_score: detailsData.opencriticScore ?? null,
      rawg_added: detailsData.rawgAdded ?? null,
      total_reviews: detailsData.totalReviews ?? null,
      review_score_desc: detailsData.reviewScoreDesc,
      platform_type: detailsData.platformType,
    });

    await manager.save(GameDetail, details);
  }

  /**
   * game_releases 저장 (중복 체크 후 추가/업데이트)
   */
  private async saveGameReleases(
    gameId: number,
    releasesData: GameReleaseData[],
    manager: EntityManager,
  ): Promise<void> {
    for (const releaseData of releasesData) {
      // 중복 체크 (platform + store + region + store_app_id)
      const where: any = {
        game_id: gameId,
        platform: releaseData.platform,
        store: releaseData.store,
      };

      if (releaseData.storeAppId) {
        where.store_app_id = releaseData.storeAppId;
      }

      const existingRelease = await manager.findOne(GameRelease, { where });

      if (existingRelease) {
        // 업데이트
        await manager.update(GameRelease, existingRelease.id, {
          store_url: releaseData.storeUrl,
          release_date_date: releaseData.releaseDateDate,
          release_date_raw: releaseData.releaseDateRaw,
          release_status: releaseData.releaseStatus,
          coming_soon: releaseData.comingSoon,
          current_price_cents: releaseData.currentPriceCents ?? null,
          is_free: releaseData.isFree,
          followers: releaseData.followers ?? null,
          updated_at: new Date(),
        });
      } else {
        // 신규 생성
        const release = manager.create(GameRelease, {
          game_id: gameId,
          platform: releaseData.platform,
          store: releaseData.store,
          store_app_id: releaseData.storeAppId,
          store_url: releaseData.storeUrl,
          release_date_date: releaseData.releaseDateDate,
          release_date_raw: releaseData.releaseDateRaw,
          release_status: releaseData.releaseStatus,
          coming_soon: releaseData.comingSoon,
          current_price_cents: releaseData.currentPriceCents ?? null,
          is_free: releaseData.isFree,
          followers: releaseData.followers ?? null,
          data_source: releaseData.dataSource,
        });

        await manager.save(GameRelease, release);
      }
    }
  }

  /**
   * companies 및 game_company_role 저장 (중복 체크 후 추가)
   */
  // 필요: import { ILike } from 'typeorm';

  private async saveCompanies(
    gameId: number,
    companiesData: CompanyData[],
    manager: EntityManager,
  ): Promise<void> {
    for (const companyData of companiesData) {
      const nameTrimmed = companyData.name.trim();
      const baseSlug = (
        companyData.slug || this.generateCompanySlug(companyData.name)
      )
        .trim()
        .toLowerCase();

      // 1) slug로 먼저 조회
      let company = await manager.findOne(Company, {
        where: { slug: baseSlug },
      });

      // 2) 없으면 name(대소문자 무시)으로 조회
      if (!company) {
        company = await manager.findOne(Company, {
          where: { name: ILike(nameTrimmed) },
        });
      }

      // 3) 둘 다 없으면 새로 생성 (slug 유일화)
      if (!company) {
        // slug 충돌 방지: baseSlug, baseSlug-2, baseSlug-3 ...
        let candidateSlug = baseSlug;
        let suffix = 2;
        while (true) {
          const exists = await manager.findOne(Company, {
            where: { slug: candidateSlug },
          });
          if (!exists) break;
          candidateSlug = `${baseSlug}-${suffix++}`;
        }

        try {
          const created = manager.create(Company, {
            name: nameTrimmed,
            slug: candidateSlug,
          });
          company = await manager.save(Company, created);
        } catch (e: any) {
          // 4) 동시성에 의한 유니크(name) 위반 방어 (Postgres: 23505)
          if (e?.code === '23505') {
            const fallback = await manager.findOne(Company, {
              where: { name: ILike(nameTrimmed) },
            });
            if (fallback) {
              company = fallback;
            } else {
              throw e;
            }
          } else {
            throw e;
          }
        }
      }

      // 5) game_company_role 중복 체크 (game_id + company_id + role)
      const existingRole = await manager.findOne(GameCompanyRole, {
        where: {
          game_id: gameId,
          company_id: company.id,
          role: companyData.role,
        },
      });

      if (!existingRole) {
        const role = manager.create(GameCompanyRole, {
          game_id: gameId,
          company_id: company.id,
          role: companyData.role,
        });
        await manager.save(GameCompanyRole, role);
      }
    }
  }

  /**
   * 회사명 → slug 변환
   * 예: "Bandai Namco Entertainment" → "bandai-namco-entertainment"
   */
  private generateCompanySlug(name: string): string {
    // ✅ 안전성 체크: name이 문자열이 아닐 경우 대응
    if (!name || typeof name !== 'string') {
      this.logger.warn(
        `⚠️ generateCompanySlug: 잘못된 name 타입 - ${typeof name}, 값: ${JSON.stringify(name)}`,
      );
      return 'unknown-company';
    }

    return (
      name
        .toLowerCase()
        .replace(/[^a-z0-9가-힣\s-]/g, '') // 알파벳, 숫자, 한글, 공백, 하이픈만 허용
        .replace(/\s+/g, '-') // 공백 → 하이픈
        .replace(/-+/g, '-') // 연속 하이픈 → 단일 하이픈
        .replace(/^-|-$/g, '') // 앞뒤 하이픈 제거
        .substring(0, 100) || 'unknown-company'
    ); // 최대 100자 (빈 문자열 방지)
  }

  /**
   * 파이프라인 실행 기록 생성
   */
  private async createPipelineRun(
    triggerType: 'automatic' | 'manual',
    phase: 'steam' | 'rawg' | 'full',
  ): Promise<PipelineRun> {
    const run = this.pipelineRunsRepository.create({
      pipeline_type: `${phase}_pipeline_${triggerType}`,
      status: 'running',
      started_at: new Date(),
    });

    return this.pipelineRunsRepository.save(run);
  }

  /**
   * 파이프라인 실행 완료
   */
  private async completePipelineRun(
    runId: number,
    status: 'completed' | 'failed',
    message?: string,
    totalItems?: number,
    completedItems?: number,
    failedItems?: number,
  ): Promise<void> {
    await this.pipelineRunsRepository.update(runId, {
      status,
      summary_message: message,
      total_items: totalItems,
      completed_items: completedItems,
      failed_items: failedItems,
      finished_at: new Date(),
    });
  }

  /**
   * 파이프라인 아이템 기록 생성
   */
  private async createPipelineItem(
    runId: number,
    subjectType: 'game' | 'release',
    subjectId: number,
    action: 'created' | 'updated',
    manager: EntityManager,
  ): Promise<void> {
    const item = manager.create(PipelineItem, {
      pipeline_run_id: runId, // ✅ Entity 필드명과 일치
      target_type: subjectType, // ✅ Entity 필드명과 일치
      target_id: subjectId, // ✅ Entity 필드명과 일치
      action_name: action, // ✅ Entity 필드명과 일치
      status: 'success',
    });

    await manager.save(PipelineItem, item);
  }
}
