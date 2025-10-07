import {
  Body,
  Controller,
  Post,
  Query,
  Logger,
  ValidationPipe,
  UsePipes,
} from '@nestjs/common';
import { promises as fs } from 'fs';
import { join } from 'path';
import { setTimeout as sleep } from 'timers/promises';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Repository,
  DataSource,
  EntityManager,
  ILike,
  QueryFailedError,
  FindOptionsWhere,
  In,
} from 'typeorm';

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
import { SegmentedBatchDto } from './dto/segmented-batch.dto';
import { SteamRefreshDto } from './dto/steam-refresh.dto';
import { RateLimitExceededError } from '../common/concurrency/rate-limit-monitor';
import { buildSearchText } from './utils/search-text.util';

type SaveMetricsSummary = {
  totalItems: number;
  successRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  created: number;
  updated: number;
  failed: number;
  retries: Record<string, number>;
  failureReasons: { code: string; count: number }[];
  concurrency: number;
  maxAttempts: number;
};

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
        saveResult = await this.saveIntegratedData(processed, pipelineRun.id);

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

        const result = await this.saveIntegratedData(batchData, pipelineRun.id);

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

  /**
   * POST + PATCH 자동 판별 저장
   * 각 게임은 독립적인 트랜잭션으로 처리
   */

  private async saveIntegratedData(
    data: ProcessedGameData[],
    pipelineRunId: number,
  ): Promise<{ created: number; updated: number; failed: number }> {
    const concurrency = Math.max(
      1,
      Number(process.env.PIPELINE_SAVE_CONCURRENCY ?? '5'),
    );
    const maxAttempts = Math.max(
      1,
      Number(process.env.PIPELINE_SAVE_MAX_ATTEMPTS ?? '3'),
    );
    const retryBaseDelay = Math.max(
      100,
      Number(process.env.PIPELINE_SAVE_RETRY_BASE_MS ?? '320'),
    );
    const retryMaxDelay = Math.max(
      retryBaseDelay,
      Number(process.env.PIPELINE_SAVE_RETRY_MAX_MS ?? '1280'),
    );
    const retryJitter = Math.max(
      0,
      Number(process.env.PIPELINE_SAVE_RETRY_JITTER_MS ?? '96'),
    );

    type QueueItem = {
      index: number;
      data: ProcessedGameData;
      attempt: number;
    };

    const queue: QueueItem[] = data.map((gameData, index) => ({
      index,
      data: gameData,
      attempt: 1,
    }));

    let createdCount = 0;
    let updatedCount = 0;
    let failedCount = 0;
    let processedCount = 0;

    const totalCount = data.length;
    const logInterval = Math.max(10, Math.floor(totalCount * 0.1));

    const latencies: number[] = [];
    const retryHistogram = new Map<number, number>();
    const failureReasons = new Map<string, number>();

    let activeWorkers = 0;

    const calculateBackoff = (attempt: number): number => {
      const base = retryBaseDelay * Math.pow(2, attempt - 1);
      const jitter =
        retryJitter > 0 ? Math.floor(Math.random() * retryJitter) : 0;
      return Math.min(retryMaxDelay, base + jitter);
    };

    const emitProgress = () => {
      if (totalCount === 0) return;
      if (processedCount === totalCount || processedCount % logInterval === 0) {
        const successTotal = createdCount + updatedCount;
        this.logger.log(
          `📊 [통합 저장] 진행 중: ${processedCount}/${totalCount} (성공: ${successTotal}, 실패: ${failedCount})`,
        );
      }
    };

    const worker = async (): Promise<void> => {
      while (true) {
        const item = queue.shift();
        if (!item) {
          if (queue.length === 0 && activeWorkers === 0) {
            break;
          }
          await sleep(25);
          continue;
        }

        activeWorkers++;
        const start = Date.now();

        try {
          let operation: 'created' | 'updated' | null = null;
          await this.dataSource.transaction(async (manager) => {
            const existingGame = await this.findExistingGame(
              item.data,
              manager,
            );

            if (existingGame) {
              await this.updateGame(existingGame.id, item.data, manager);
              await this.createPipelineItem(
                pipelineRunId,
                'game',
                existingGame.id,
                'updated',
                manager,
              );
              operation = 'updated';
            } else {
              const newGame = await this.createGame(item.data, manager);
              await this.createPipelineItem(
                pipelineRunId,
                'game',
                newGame.id,
                'created',
                manager,
              );
              operation = 'created';
            }
          });

          const durationMs = Date.now() - start;
          latencies.push(durationMs);
          retryHistogram.set(
            item.attempt,
            (retryHistogram.get(item.attempt) ?? 0) + 1,
          );

          if (operation === 'created') {
            createdCount++;
          } else if (operation === 'updated') {
            updatedCount++;
          }

          processedCount++;
          emitProgress();
        } catch (error) {
          const { type, code } = this.classifySaveError(error);
          const normalized = this.normalizeError(error);
          const reasonKey =
            code ??
            normalized.name ??
            (normalized.message ? normalized.message.split(' ')[0] : 'unknown');
          const canRetry =
            (type === 'transient' && item.attempt < maxAttempts) ||
            (type === 'unknown' && item.attempt < Math.min(maxAttempts, 2));

          if (canRetry) {
            const wait = calculateBackoff(item.attempt);
            this.logger.warn(
              `⏳ [통합 저장] 재시도 준비 (${wait}ms) - ${item.data.name} (attempt ${
                item.attempt + 1
              })`,
            );
            await sleep(wait);
            queue.push({
              index: item.index,
              data: item.data,
              attempt: item.attempt + 1,
            });
          } else {
            failureReasons.set(
              reasonKey,
              (failureReasons.get(reasonKey) ?? 0) + 1,
            );
            failedCount++;
            processedCount++;
            retryHistogram.set(
              item.attempt,
              (retryHistogram.get(item.attempt) ?? 0) + 1,
            );
            this.logger.error(
              `❌ [통합 저장] 게임 저장 실패 (attempt ${item.attempt}): ${
                item.data.name
              } - ${normalized.message}`,
            );
            emitProgress();
          }
        } finally {
          activeWorkers--;
        }
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(concurrency, Math.max(1, totalCount)) },
        () => worker(),
      ),
    );

    const successTotal = createdCount + updatedCount;
    const successRate = totalCount
      ? Number((successTotal / totalCount).toFixed(4))
      : 0;
    const avgLatencyMs = latencies.length
      ? Math.round(latencies.reduce((sum, v) => sum + v, 0) / latencies.length)
      : 0;
    const p95LatencyMs = latencies.length
      ? this.calculatePercentile(latencies, 0.95)
      : 0;

    const metrics: SaveMetricsSummary = {
      totalItems: totalCount,
      successRate,
      avgLatencyMs,
      p95LatencyMs,
      created: createdCount,
      updated: updatedCount,
      failed: failedCount,
      retries: Object.fromEntries(
        Array.from(retryHistogram.entries()).sort(
          ([a], [b]) => Number(a) - Number(b),
        ),
      ),
      failureReasons: Array.from(failureReasons.entries()).map(
        ([reason, count]) => ({ code: reason, count }),
      ),
      concurrency,
      maxAttempts,
    };

    await this.persistSaveMetrics(pipelineRunId, metrics);

    return {
      created: createdCount,
      updated: updatedCount,
      failed: failedCount,
    };
  }

  private calculatePercentile(values: number[], percentile: number): number {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil(percentile * sorted.length) - 1),
    );
    return Math.round(sorted[rank]);
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

  private classifySaveError(error: unknown): {
    type: 'permanent' | 'transient' | 'unknown';
    code?: string;
  } {
    if (error instanceof QueryFailedError) {
      const code = (error as QueryFailedError & { code?: string }).code;
      if (code && ['23505', '23502', '23514', '22P02'].includes(code)) {
        return { type: 'permanent', code };
      }
      if (code && ['40001', '40P01', '57014'].includes(code)) {
        return { type: 'transient', code };
      }
      return { type: 'unknown', code };
    }

    const message = this.normalizeError(error).message;

    if (/timeout|deadlock|connection/i.test(message)) {
      return { type: 'transient' };
    }

    if (/duplicate|unique|not null|validation/i.test(message)) {
      return { type: 'permanent' };
    }

    return { type: 'unknown' };
  }

  private async persistSaveMetrics(
    pipelineRunId: number,
    metrics: SaveMetricsSummary,
  ): Promise<void> {
    try {
      await this.pipelineRunsRepository.update(pipelineRunId, {
        summary_message: JSON.stringify({ saveMetrics: metrics }),
      });
    } catch (error) {
      const err = this.normalizeError(error);
      this.logger.warn(
        `⚠️ [통합 저장] 메트릭 DB 저장 실패: ${err.message}`,
        err.stack,
      );
    }

    await this.writePerformanceLog(pipelineRunId, metrics);
  }

  private async writePerformanceLog(
    pipelineRunId: number,
    metrics: SaveMetricsSummary,
  ): Promise<void> {
    try {
      const dir = join(process.cwd(), 'logs', 'perf');
      await fs.mkdir(dir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filePath = join(dir, `pipeline-${pipelineRunId}-${timestamp}.json`);
      await fs.writeFile(
        filePath,
        JSON.stringify(
          {
            pipelineRunId,
            generatedAt: new Date().toISOString(),
            metrics,
          },
          null,
          2,
        ),
        'utf-8',
      );
    } catch (error) {
      const err = this.normalizeError(error);
      this.logger.warn(
        `⚠️ [통합 저장] 성능 로그 기록 실패: ${err.message}`,
        err.stack,
      );
    }
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
    if (gameData.slug) {
      return manager.findOne(Game, {
        where: { slug: ILike(gameData.slug) },
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
    const whereClauses: FindOptionsWhere<Game>[] = [];
    if (gameData.slug) {
      whereClauses.push({ slug: gameData.slug });
    }
    if (gameData.steamId) {
      whereClauses.push({ steam_id: gameData.steamId });
    }
    if (gameData.rawgId) {
      whereClauses.push({ rawg_id: gameData.rawgId });
    }

    if (whereClauses.length > 0) {
      const existing = await manager.findOne(Game, { where: whereClauses });
      if (existing) {
        await this.updateGame(existing.id, gameData, manager);
        return existing;
      }
    }

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
      release_date_date: gameData.releaseDate,
      release_date_raw: gameData.releaseDateRaw,
      release_status: gameData.releaseStatus,
      coming_soon: gameData.comingSoon,
      popularity_score: gameData.popularityScore,
      followers_cache: gameData.followersCache ?? null,
    });

    let savedGame: Game;
    try {
      savedGame = await manager.save(Game, game);
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        (error as QueryFailedError & { code?: string }).code === '23505'
      ) {
        const whereClauses: FindOptionsWhere<Game>[] = [{ slug: game.slug }];
        if (typeof game.steam_id === 'number') {
          whereClauses.push({ steam_id: game.steam_id });
        }
        if (typeof gameData.rawgId === 'number') {
          whereClauses.push({ rawg_id: gameData.rawgId });
        }

        const fallback = await manager.findOne(Game, {
          where: whereClauses,
        });

        if (fallback) {
          await this.updateGame(fallback.id, gameData, manager);
          return fallback;
        }
      }
      throw this.normalizeError(error);
    }

    // ===== Phase 5.5: DLC는 details/releases 미생성 =====
    if (isDlc) {
      this.logger.debug(
        `🎯 [DLC 저장] ${gameData.name} (Steam: ${gameData.steamId}, RAWG: ${gameData.rawgId})`,
      );
      return savedGame; // DLC는 여기서 종료
    }

    const searchText = buildSearchText(gameData.name, gameData.companies);

    // 2. game_details 저장 (본편만, 인기도 40점 이상만)
    if (gameData.popularityScore >= 40 && gameData.details) {
      await this.saveGameDetails(
        savedGame.id,
        gameData.details,
        manager,
        searchText,
      );
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

    // ===== ✅ Steam 게임 보호: RAWG 데이터로 덮어쓰지 않음 =====
    const isSteamGame = existingGame.steam_id !== null && existingGame.steam_id > 0;
    const isRawgDataSource = gameData.rawgId !== null && !gameData.steamId;

    if (isSteamGame && isRawgDataSource) {
      this.logger.debug(
        `🛡️ [Steam 게임 보호] RAWG 데이터로 detail 덮어쓰기 차단 - ${gameData.name} (steam_id: ${existingGame.steam_id})`,
      );

      // games 테이블의 변동 필드만 업데이트
      await manager.update(Game, gameId, {
        release_date_date: gameData.releaseDate,
        release_status: gameData.releaseStatus,
        coming_soon: gameData.comingSoon,
        popularity_score: gameData.popularityScore,
        followers_cache: gameData.followersCache ?? null,
        rawg_id: existingGame.rawg_id ?? gameData.rawgId, // ✅ RAWG ID 추가
        updated_at: new Date(),
      });

      // ✅ game_details 스킵, game_releases만 처리 (콘솔 릴리스 정보)
      if (gameData.releases && gameData.releases.length > 0) {
        await this.saveGameReleases(gameId, gameData.releases, manager);
        this.logger.debug(
          `✅ [콘솔 릴리스] ${gameData.releases.length}개 플랫폼 추가 완료 - ${gameData.name}`,
        );
      }

      // ✅ companies도 업데이트 (개발사/퍼블리셔 정보 보완)
      if (gameData.companies && gameData.companies.length > 0) {
        await this.saveCompanies(gameId, gameData.companies, manager);
      }

      return; // game_details 업데이트는 스킵
    }

    const isDlc = gameData.isDlc ?? existingGame.is_dlc ?? false;
    const searchText = buildSearchText(gameData.name, gameData.companies);

    // ===== Phase 5.5 패치 세맨틱: 필드별 갱신 정책 =====
    const updateData: Partial<Game> = {
      // 변동 가능 필드: 항상 갱신
      name: gameData.name,
      release_date_date: gameData.releaseDate,
      release_date_raw: gameData.releaseDateRaw,
      release_status: gameData.releaseStatus,
      coming_soon: gameData.comingSoon,
      popularity_score: gameData.popularityScore,
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
    // ===== ✅ 추가 보호: Steam 게임은 RAWG 데이터로 덮어쓰지 않음 =====
    if (gameData.popularityScore >= 40 && gameData.details) {
      // Steam 게임이고 현재 업데이트 데이터가 RAWG 소스인 경우 스킵
      if (isSteamGame && gameData.rawgId && !gameData.steamId) {
        this.logger.debug(
          `🛡️ [Steam Detail 보호] RAWG 데이터로 detail 덮어쓰기 차단 - ${gameData.name}`,
        );
      } else {
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
              header_image: gameData.details.headerImage,

              tags: gameData.details.tags,
              support_languages: gameData.details.supportLanguages,
              metacritic_score: gameData.details.metacriticScore ?? null,
              opencritic_score: gameData.details.opencriticScore ?? null,
              rawg_added: gameData.details.rawgAdded ?? null,
              total_reviews: gameData.details.totalReviews ?? null,
              review_score_desc: gameData.details.reviewScoreDesc,
              search_text: searchText,
              updated_at: new Date(),
            },
          );
        } else {
          await this.saveGameDetails(
            gameId,
            gameData.details,
            manager,
            searchText,
          );
        }
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
    searchText: string,
  ): Promise<void> {
    const details = manager.create(GameDetail, {
      game_id: Number(gameId),
      screenshots: detailsData.screenshots,
      video_url: detailsData.videoUrl,
      description: detailsData.description,
      header_image: detailsData.headerImage,
      website: detailsData.website,
      genres: detailsData.genres,
      tags: detailsData.tags,
      support_languages: detailsData.supportLanguages,
      metacritic_score: detailsData.metacriticScore ?? null,
      opencritic_score: detailsData.opencriticScore ?? null,
      rawg_added: detailsData.rawgAdded ?? null,
      total_reviews: detailsData.totalReviews ?? null,
      review_score_desc: detailsData.reviewScoreDesc,
      search_text: searchText,
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
      const storeAppId = this.normalizeStoreAppId(releaseData.storeAppId);
      // 중복 체크 (platform + store + store_app_id)
      const where: FindOptionsWhere<GameRelease> = {
        game_id: gameId,
        platform: releaseData.platform,
        store: releaseData.store,
        store_app_id: storeAppId,
      };

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
          reviews_total: releaseData.reviewsTotal ?? null,
          review_score_desc: releaseData.reviewScoreDesc ?? null,
          store_app_id: storeAppId,
          updated_at: new Date(),
        });
      } else {
        // 신규 생성
        const release = manager.create(GameRelease, {
          game_id: gameId,
          platform: releaseData.platform,
          store: releaseData.store,
          store_app_id: storeAppId,
          store_url: releaseData.storeUrl,
          release_date_date: releaseData.releaseDateDate,
          release_date_raw: releaseData.releaseDateRaw,
          release_status: releaseData.releaseStatus,
          coming_soon: releaseData.comingSoon,
          current_price_cents: releaseData.currentPriceCents ?? null,
          is_free: releaseData.isFree,
          followers: releaseData.followers ?? null,
          reviews_total: releaseData.reviewsTotal ?? null,
          review_score_desc: releaseData.reviewScoreDesc ?? null,
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

        const insertResult = await manager
          .createQueryBuilder()
          .insert()
          .into(Company)
          .values({
            name: nameTrimmed,
            slug: candidateSlug,
          })
          .onConflict('DO NOTHING')
          .returning(['id', 'name', 'slug', 'created_at', 'updated_at'])
          .execute();

        const rawRows = Array.isArray(insertResult.raw)
          ? (insertResult.raw as Array<Partial<Company>>)
          : [];
        if (rawRows.length > 0) {
          company = manager.create(Company, rawRows[0]);
        } else {
          company = await manager.findOne(Company, {
            where: [{ name: ILike(nameTrimmed) }, { slug: candidateSlug }],
          });
        }
      }

      if (!company) {
        this.logger.warn(
          `⚠️ 회사 저장 실패 - name=${nameTrimmed}, slug=${baseSlug}`,
        );
        continue;
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

  /**
   * 스토어 앱 ID를 문자열로 정규화하여 빈 값일 때는 빈 문자열을 반환한다.
   */
  private normalizeStoreAppId(storeAppId?: string | number | null): string {
    if (storeAppId === undefined || storeAppId === null) {
      return '';
    }

    const normalized = String(storeAppId).trim();
    return normalized || '';
  }
}
