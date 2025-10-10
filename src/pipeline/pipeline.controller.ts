import {
  Body,
  Controller,
  Post,
  Query,
  Logger,
  ValidationPipe,
  UsePipes,
  Param,
} from '@nestjs/common';

import { Cron } from '@nestjs/schedule';
import { setTimeout as sleep } from 'timers/promises';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Repository,
  In,
} from 'typeorm';

import { Game } from '../entities/game.entity';
import { PipelineRun } from '../entities/pipeline-run.entity';
import { PipelineItem } from '../entities/pipeline-item.entity';

import { SteamDataPipelineService } from '../steam/services/steam-data-pipeline.service';
import { RawgDataPipelineService } from '../rawg/rawg-data-pipeline.service';
import { SteamBatchStrategyService } from '../steam/services/steam-batch-strategy.service';
import { IntegratedPersistenceService } from './persistence/integrated-persistence.service';

import { ProcessedGameData, ApiResponse, PipelineRunResult } from '@pipeline/contracts';

import { ManualPipelineDto } from './dto/manual-pipeline.dto';
import { SegmentedBatchDto } from './dto/segmented-batch.dto';
import { SteamRefreshDto } from './dto/steam-refresh.dto';
import { RateLimitExceededError } from '../common/concurrency/rate-limit-monitor';
import { SingleGameManualDto } from './dto/single-game-manual-dto';
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
    @InjectRepository(PipelineRun)
    private readonly pipelineRunsRepository: Repository<PipelineRun>,
    @InjectRepository(PipelineItem)
    private readonly pipelineItemsRepository: Repository<PipelineItem>,
    private readonly persistence: IntegratedPersistenceService,
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
      const saveResult = await this.persistence.saveProcessedGames(
        allData,
        pipelineRun.id,
      );

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
      const err = this.normalizeError(error);

      this.logger.error(`❌ [자동 파이프라인] 실패 (${durationSeconds}초)`);
      this.logger.error(`   - 오류: ${err.message}`, err.stack);

      await this.completePipelineRun(pipelineRun.id, 'failed', err.message);
      throw err;
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
      let rawgCount = 0;

      // Steam 데이터 수집
      if (phase === 'steam' || phase === 'full') {
        this.logger.log('📥 [수동 파이프라인] Steam 데이터 수집 시작');

        let steamData: ProcessedGameData[];

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
      const saveResult = await this.persistence.saveProcessedGames(
        data,
        pipelineRun.id,
      );

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

      // manual 실행 진입부에서
      // if (phase === 'steam' && strategy === 'new') { ... }
      if (phase === 'steam' && strategy === 'new') {
        this.logger.log('🆕 [수동 파이프라인] Steam 신규 탐지 전략 시작');

        // 1) DB에 있는 모든 steam_id 집합
        const existingSteamIdsRaw = await this.gamesRepository
          .createQueryBuilder('g')
          .select('g.steam_id', 'steam_id')
          .where('g.steam_id IS NOT NULL')
          .getRawMany<{ steam_id: number }>();
        const existing = new Set(
          existingSteamIdsRaw.map((r) => Number(r.steam_id)),
        );

        // 2) AppList v2 전체
        const allIds = await this.steamDataPipeline.listAllSteamAppIdsV2();

        // 3) 차집합(=진짜 신규)
        const newcomers = allIds.filter((id) => !existing.has(id));
        this.logger.log(
          `🧮 [신규 탐지] AppList=${allIds.length}, DB=${existing.size}, 신규=${newcomers.length}`,
        );

        // 4) limit가 있으면 상한 적용
        const take = limit ?? 200;
        const targets = newcomers.slice(0, take);

        if (targets.length === 0) {
          await this.completePipelineRun(
            pipelineRun.id,
            'completed',
            'no-newcomers',
            0,
            0,
            0,
          );
          return {
            statusCode: 200,
            message: '신규 Steam 게임이 없습니다.',
            data: {
              pipelineRunId: pipelineRun.id,
              phase: 'steam',
              totalProcessed: 0,
              finishedAt: new Date(),
            },
          };
        }

        // 5) 상세 수집 → 저장
        const collected = await this.steamDataPipeline.collectManyBySteamIds(
          targets,
          { mode },
        );
        const saveResult = await this.persistence.saveProcessedGames(
          collected,
          pipelineRun.id,
        );

        await this.completePipelineRun(
          pipelineRun.id,
          'completed',
          undefined,
          collected.length,
          saveResult.created + saveResult.updated,
          saveResult.failed,
        );

        return {
          statusCode: 200,
          message: `Steam 신규 ${collected.length}건 처리 완료`,
          data: {
            pipelineRunId: pipelineRun.id,
            phase: 'steam',
            totalProcessed: collected.length,
            finishedAt: new Date(),
          },
        };
      }

      const duration = Date.now() - startTime;
      const durationSeconds = (duration / 1000).toFixed(2);

      const rawgReport =
        rawgCount > 0 ? this.rawgDataPipeline.getLatestReport() : null;

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
          rawgReport: rawgReport ?? undefined,
        },
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const durationSeconds = (duration / 1000).toFixed(2);
      const err = this.normalizeError(error);

      this.logger.error(`❌ [수동 파이프라인] 실패 (${durationSeconds}초)`);
      this.logger.error(`   - 오류: ${err.message}`);

      await this.completePipelineRun(pipelineRun.id, 'failed', err.message);
      throw err;
    }
  }

  @Post('refresh/steam')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  async executeSteamRefresh(
    @Body() params: SteamRefreshDto,
  ): Promise<ApiResponse<PipelineRunResult>> {
    const limit = params.limit ?? 40;
    const dryRun = params.dryRun ?? false;
    const startedAt = Date.now();

    this.logger.log('🚀 [Steam Refresh] 출시 윈도우 갱신 시작');
    this.logger.log(`   - limit: ${limit}`);
    this.logger.log(`   - dryRun: ${dryRun}`);

    const pipelineRun = await this.createPipelineRun(
      'manual',
      'steam',
      'refresh_steam_pipeline_manual',
    );

    try {
      const { candidates, processed } =
        await this.steamDataPipeline.collectReleaseWindowRefreshData(limit);
      if (dryRun) {
        await this.completePipelineRun(
          pipelineRun.id,
          'completed',
          'dry-run',
          candidates.length,
          0,
          0,
        );

        return {
          statusCode: 200,
          message: 'Steam 출시 윈도우 갱신 드라이런 완료',
          data: {
            pipelineRunId: pipelineRun.id,
            phase: 'steam',
            totalProcessed: 0,
            finishedAt: new Date(),
            refreshSummary: {
              totalCandidates: candidates.length,
              processed: 0,
              saved: 0,
              failed: 0,
              dryRun: true,
              candidates,
            },
          },
        };
      }

      let saveResult = { created: 0, updated: 0, failed: 0 };

      if (processed.length > 0) {
        this.logger.log(
          `💾 [Steam Refresh] ${processed.length}/${candidates.length}건 저장 시작`,
        );
        saveResult = await this.persistence.saveProcessedGames(
          processed,
          pipelineRun.id,
        );

        const items = await this.pipelineItemsRepository.find({
          where: {
            pipeline_run_id: pipelineRun.id,
            target_type: 'game',
            status: 'success',
          },
        });

        const candidateSet = new Set(candidates.map((item) => item.gameId));
        const successGameIds = items
          .map((item) => (item.target_id ? Number(item.target_id) : null))
          .filter((id): id is number => id !== null && candidateSet.has(id));

        if (successGameIds.length > 0) {
          const now = new Date();
          await this.gamesRepository.update(
            { id: In(successGameIds) },
            { steam_last_refresh_at: now },
          );
          this.logger.log(
            `🕒 [Steam Refresh] steam_last_refresh_at 업데이트: ${successGameIds.length}건`,
          );
        }
      } else {
        this.logger.warn('⚠️ [Steam Refresh] 처리된 데이터가 없습니다.');
      }

      await this.completePipelineRun(
        pipelineRun.id,
        'completed',
        undefined,
        candidates.length,
        saveResult.created + saveResult.updated,
        saveResult.failed,
      );

      const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(2);

      return {
        statusCode: 200,
        message: `Steam 출시 윈도우 갱신 완료 (${durationSeconds}s)`,
        data: {
          pipelineRunId: pipelineRun.id,
          phase: 'steam',
          totalProcessed: processed.length,
          finishedAt: new Date(),
          refreshSummary: {
            totalCandidates: candidates.length,
            processed: processed.length,
            saved: saveResult.created + saveResult.updated,
            failed: saveResult.failed,
            dryRun: false,
            candidates,
          },
        },
      };
    } catch (error) {
      const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(2);
      const err = this.normalizeError(error);
      this.logger.error(
        `❌ [Steam Refresh] 실패 (${durationSeconds}s) - ${err.message}`,
      );

      await this.completePipelineRun(pipelineRun.id, 'failed', err.message);
      throw err;
    }
  }

  @Post('batch/segmented')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  async executeSegmentedBatch(
    @Body() params: SegmentedBatchDto,
  ): Promise<ApiResponse<PipelineRunResult>> {
    const totalLimit = Math.min(params.totalLimit ?? 150_000, 150_000);
    const chunkSize = Math.max(1, Math.min(params.chunkSize ?? 3_000, 10_000));
    const pauseMs = (params.pauseSeconds ?? 0) * 1000;

    const pipelineRun = await this.createPipelineRun('manual', 'steam');
    const startedAt = Date.now();

    let attempted = 0;
    let created = 0;
    let updated = 0;
    let failed = 0;

    try {
      while (attempted < totalLimit) {
        const remaining = totalLimit - attempted;
        const requestSize = Math.min(chunkSize, remaining);

        const batchData =
          await this.steamDataPipeline.collectBatchData(requestSize);

        if (!batchData.length) {
          this.logger.log(
            `⏹️ [세그먼트 배치] 추가로 수집할 데이터가 없어 종료합니다. (${attempted}/${totalLimit})`,
          );
          break;
        }

        this.logger.log(
          `📦 [세그먼트 배치] ${batchData.length}건 수집, 저장 시작 (${attempted + batchData.length}/${totalLimit})`,
        );

        const result = await this.persistence.saveProcessedGames(
          batchData,
          pipelineRun.id,
        );

        created += result.created;
        updated += result.updated;
        failed += result.failed;
        attempted += batchData.length;

        await this.steamBatchStrategy.updateBatchProgress(batchData.length);

        if (pauseMs > 0 && attempted < totalLimit) {
          this.logger.log(
            `⏳ [세그먼트 배치] 다음 세그먼트 전 ${pauseMs}ms 대기`,
          );
          await sleep(pauseMs);
        }
      }

      const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(2);

      this.logger.log(
        `✅ [세그먼트 배치] 완료 (${durationSeconds}s) — attempted:${attempted}, created:${created}, updated:${updated}, failed:${failed}`,
      );

      await this.completePipelineRun(
        pipelineRun.id,
        'completed',
        undefined,
        attempted,
        created + updated,
        failed,
      );

      return {
        statusCode: 200,
        message: '세그먼트 배치 실행 완료',
        data: {
          pipelineRunId: pipelineRun.id,
          phase: 'steam',
          totalProcessed: attempted,
          finishedAt: new Date(),
        },
      };
    } catch (error) {
      const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(2);
      const err = this.normalizeError(error);

      if (error instanceof RateLimitExceededError) {
        const message =
          'Steam AppDetails 레이트 리밋에 도달했습니다. 잠시 후 다시 시도해주세요.';
        this.logger.error(
          `❌ [세그먼트 배치] Rate Limit 초과로 중단 (${durationSeconds}초)`,
        );
        await this.completePipelineRun(
          pipelineRun.id,
          'failed',
          message,
          attempted,
          created + updated,
          failed,
        );
        return {
          statusCode: 429,
          message,
          data: {
            pipelineRunId: pipelineRun.id,
            phase: 'steam',
            totalProcessed: attempted,
            finishedAt: new Date(),
          },
        };
      }

      this.logger.error(`❌ [세그먼트 배치] 실패: ${err.message}`);

      await this.completePipelineRun(
        pipelineRun.id,
        'failed',
        err.message,
        attempted,
        created + updated,
        failed,
      );
      throw err;
    }
  }
  @Post('manual/game/:id')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  async executeManualSingleGame(
    @Param('id') idParam: string,
    @Query() params: SingleGameManualDto,
  ): Promise<ApiResponse<PipelineRunResult>> {
    const startedAt = Date.now();
    const idKind = params.idKind ?? 'game';
    const sources = params.sources ?? (idKind === 'game' ? 'both' : idKind); // game→both, steam→steam, rawg→rawg
    const mode = params.mode ?? 'operational';
    const dryRun = params.dryRun ?? false;

    this.logger.log('🚀 [단일 파이프라인] 시작');
    this.logger.log(`   - id: ${idParam} (${idKind})`);
    this.logger.log(`   - sources: ${sources}`);
    this.logger.log(`   - mode: ${mode}`);
    this.logger.log(`   - dryRun: ${dryRun}`);

    const pipelineRun = await this.createPipelineRun(
      'manual',
      'full',
      'single_game_pipeline_manual',
    );

    // 0) 식별 → DB 조회
    let game: Game | null = null;
    if (idKind === 'game') {
      const gameId = Number(idParam);
      if (!Number.isFinite(gameId)) {
        return {
          statusCode: 400,
          message: '잘못된 game_id 입니다.',
          data: undefined,
        };
      }
      game = await this.gamesRepository.findOne({ where: { id: gameId } });
      if (!game) {
        return {
          statusCode: 404,
          message: `게임을 찾을 수 없습니다: ${gameId}`,
          data: undefined,
        };
      }
    } else if (idKind === 'steam') {
      const steamId = Number(idParam);
      if (!Number.isFinite(steamId)) {
        return {
          statusCode: 400,
          message: '잘못된 steam_id 입니다.',
          data: undefined,
        };
      }
      game = await this.gamesRepository.findOne({
        where: { steam_id: steamId },
      });
    } else if (idKind === 'rawg') {
      const rawgId = Number(idParam);
      if (!Number.isFinite(rawgId)) {
        return {
          statusCode: 400,
          message: '잘못된 rawg_id 입니다.',
          data: undefined,
        };
      }
      game = await this.gamesRepository.findOne({ where: { rawg_id: rawgId } });
    }

    try {
      const tasks: Promise<ProcessedGameData | null>[] = [];

      // 1) 수집 소스 결정
      if (sources === 'steam' || sources === 'both') {
        // game이 있으면 그 steam_id, 없으면 idParam(steam 케이스)
        const steamId =
          game?.steam_id ?? (idKind === 'steam' ? Number(idParam) : null);
        if (steamId)
          tasks.push(
            this.steamDataPipeline.collectOneBySteamId(steamId, { mode }),
          );
      }
      if (sources === 'rawg' || sources === 'both') {
        const rawgId =
          game?.rawg_id ?? (idKind === 'rawg' ? Number(idParam) : null);
        if (rawgId)
          tasks.push(this.rawgDataPipeline.collectOneByRawgId(rawgId));
      }

      if (tasks.length === 0) {
        // 자동 추론 실패 시 안내
        return {
          statusCode: 400,
          message: '수집할 소스/식별자가 없습니다.',
          data: undefined,
        };
      }

      const raws = await Promise.all(tasks);
      const collected = raws.filter((x): x is ProcessedGameData => !!x);

      if (collected.length === 0) {
        await this.completePipelineRun(
          pipelineRun.id,
          'completed',
          'no-data',
          0,
          0,
          0,
        );
        return {
          statusCode: 200,
          message: '수집할 데이터가 없습니다.',
          data: {
            pipelineRunId: pipelineRun.id,
            phase: 'full',
            totalProcessed: 0,
            finishedAt: new Date(),
          },
        };
      }

      if (dryRun) {
        await this.completePipelineRun(
          pipelineRun.id,
          'completed',
          'dry-run',
          collected.length,
          0,
          0,
        );
        return {
          statusCode: 200,
          message: '단일 파이프라인 드라이런 완료',
          data: {
            pipelineRunId: pipelineRun.id,
            phase: 'full',
            totalProcessed: 0,
            finishedAt: new Date(),
          },
        };
      }

      // 2) 저장 — 여기서 “존재하면 업데이트/없으면 생성” 자동 수행
      const saveResult = await this.persistence.saveProcessedGames(
        collected,
        pipelineRun.id,
      );

      await this.completePipelineRun(
        pipelineRun.id,
        'completed',
        undefined,
        collected.length,
        saveResult.created + saveResult.updated,
        saveResult.failed,
      );

      const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(2);
      this.logger.log(
        `✅ [단일 파이프라인] 완료 (${durationSeconds}s) — created:${saveResult.created}, updated:${saveResult.updated}, failed:${saveResult.failed}`,
      );

      return {
        statusCode: 200,
        message: '단일 파이프라인 실행 완료',
        data: {
          pipelineRunId: pipelineRun.id,
          phase: 'full',
          totalProcessed: collected.length,
          finishedAt: new Date(),
        },
      };
    } catch (error) {
      const err = this.normalizeError(error);
      const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(2);
      this.logger.error(
        `❌ [단일 파이프라인] 실패 (${durationSeconds}s) - ${err.message}`,
      );
      await this.completePipelineRun(pipelineRun.id, 'failed', err.message);
      throw err;
    }
  }

  private normalizeError(error: unknown): Error & { code?: string } {
    if (error instanceof Error) {
      return error as Error & { code?: string };
    }

    if (typeof error === 'object' && error !== null) {
      const details = error as {
        message?: unknown;
        code?: unknown;
        name?: unknown;
      };
      const message =
        typeof details.message === 'string'
          ? details.message
          : this.stringifyUnknown(details);
      const normalized = new Error(message) as Error & { code?: string };
      if (typeof details.code === 'string') {
        normalized.code = details.code;
      }
      if (typeof details.name === 'string') {
        normalized.name = details.name;
      }
      return normalized;
    }

    return new Error(this.stringifyUnknown(error)) as Error & { code?: string };
  }

  private stringifyUnknown(value: unknown): string {
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private async createPipelineRun(
    triggerType: 'automatic' | 'manual',
    phase: 'steam' | 'rawg' | 'full',
    pipelineTypeOverride?: string,
  ): Promise<PipelineRun> {
    const run = this.pipelineRunsRepository.create({
      pipeline_type: pipelineTypeOverride ?? `${phase}_pipeline_${triggerType}`,
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
    const updatePayload: Partial<PipelineRun> = {
      status,
      total_items: totalItems,
      completed_items: completedItems,
      failed_items: failedItems,
      finished_at: new Date(),
    };

    if (typeof message !== 'undefined') {
      updatePayload.summary_message = message;
    }

    await this.pipelineRunsRepository.update(runId, updatePayload);
  }

}
