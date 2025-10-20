import {
  Body,
  Controller,
  Post,
  Query,
  Logger,
  ValidationPipe,
  UsePipes,
  Param,
  Get,
} from '@nestjs/common';

import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';

import { Game } from '../entities/game.entity';
import { PipelineRun } from '../entities/pipeline-run.entity';
import { PipelineItem } from '../entities/pipeline-item.entity';

import { SteamDataPipelineService } from '../steam/services/steam-data-pipeline.service';
import { RawgDataPipelineService } from '../rawg/rawg-data-pipeline.service';
import { IntegratedPersistenceService } from './persistence/integrated-persistence.service';
import { SteamExclusionService } from '../steam/services/exclusion/steam-exclusion.service';

import {
  ProcessedGameData,
  ApiResponse,
  PipelineRunResult,
} from '@pipeline/contracts';
import { SaveFailureDetail } from './contracts/save-result.contract';
import { PersistenceSaveResult } from './persistence/persistence.types';

import { ManualPipelineDto } from './dto/manual-pipeline.dto';
import { SteamRefreshDto } from './dto/steam-refresh.dto';
import { SteamNewDto } from './dto/steam-new.dto';
import {
  SingleGameManualDto,
  ModeEnum,
  SourcesEnum,
} from './dto/single-game-manual-dto';
import { FullRefreshDto } from './dto/full-refresh.dto';

type SteamBatchRunningTotals = {
  collected: number;
  created: number;
  updated: number;
  failed: number;
};

interface SteamBatchContextBase<TTarget> {
  batchIndex: number;
  batchCount: number;
  targetStart: number;
  targetEnd: number;
  targetTotal: number;
  targetSlice: readonly TTarget[];
  steamIds: readonly number[];
  steamProgressStart: number;
  steamProgressEnd: number;
  totalUniqueSteamIds: number;
  dryRun: boolean;
  runningTotals: SteamBatchRunningTotals;
}

interface SteamBatchCollectedContext<TTarget>
  extends SteamBatchContextBase<TTarget> {
  collected: readonly ProcessedGameData[];
}

interface SteamBatchSaveContext<TTarget>
  extends SteamBatchCollectedContext<TTarget> {
  saveChunkIndex: number;
  saveChunkCount: number;
  saveChunk: readonly ProcessedGameData[];
}

interface SteamBatchSaveResultContext<TTarget>
  extends SteamBatchSaveContext<TTarget> {
  saveResult: PersistenceSaveResult;
  runningTotals: SteamBatchRunningTotals;
}

type SteamBatchSaveSkippedReason = 'dry-run' | 'empty';

interface SteamBatchSaveSkippedContext<TTarget>
  extends SteamBatchCollectedContext<TTarget> {
  reason: SteamBatchSaveSkippedReason;
  runningTotals: SteamBatchRunningTotals;
}

interface SteamBatchCompletedContext<TTarget>
  extends SteamBatchCollectedContext<TTarget> {
  batchCreated: number;
  batchUpdated: number;
  batchFailed: number;
  totalCollectedSoFar: number;
  totalCreatedSoFar: number;
  totalUpdatedSoFar: number;
  totalFailedSoFar: number;
  runningTotals: SteamBatchRunningTotals;
}

interface SteamBatchHooks<TTarget> {
  onBatchStart?: (
    context: SteamBatchContextBase<TTarget>,
  ) => void | Promise<void>;
  onCollected?: (
    context: SteamBatchCollectedContext<TTarget>,
  ) => void | Promise<void>;
  onBeforeSave?: (
    context: SteamBatchSaveContext<TTarget>,
  ) => void | Promise<void>;
  onSaveResult?: (
    context: SteamBatchSaveResultContext<TTarget>,
  ) => void | Promise<void>;
  onSaveSkipped?: (
    context: SteamBatchSaveSkippedContext<TTarget>,
  ) => void | Promise<void>;
  onBatchComplete?: (
    context: SteamBatchCompletedContext<TTarget>,
  ) => void | Promise<void>;
}
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
    @InjectRepository(Game)
    private readonly gamesRepository: Repository<Game>,
    @InjectRepository(PipelineRun)
    private readonly pipelineRunsRepository: Repository<PipelineRun>,
    @InjectRepository(PipelineItem)
    private readonly pipelineItemsRepository: Repository<PipelineItem>,
    private readonly persistence: IntegratedPersistenceService,
    private readonly steamExclusionService: SteamExclusionService,
  ) {}

  // @Cron('0 2 * * *', {
  //   name: 'steam-daily-maintenance',
  //   timeZone: 'Asia/Seoul',
  // })
  // async executeAutomaticPipeline(): Promise<void> {
  //   this.logger.log('🚀 [자동 파이프라인] Steam 일일 유지보수 시작');
  //   try {
  //     this.logger.log('   ➤ 1/2 출시 윈도우 갱신 (limit=1000)');
  //     await this.executeSteamRefresh({ limit: 1000, dryRun: false });
  //     this.logger.log('   ✅ 출시 윈도우 갱신 완료');

  //     this.logger.log('   ➤ 2/2 Steam 신규 탐지 (limit=1000)');
  //     await this.executeSteamNew({
  //       limit: 1000,
  //       mode: 'operational',
  //       dryRun: false,
  //     });
  //     this.logger.log('   ✅ Steam 신규 탐지 완료');

  //     this.logger.log('✅ [자동 파이프라인] 일일 유지보수 완료');
  //   } catch (error) {
  //     const err = this.normalizeError(error);
  //     this.logger.error(
  //       `❌ [자동 파이프라인] 일일 유지보수 실패 - ${err.message}`,
  //       err.stack,
  //     );
  //     throw err;
  //   }
  // }


  @Get('cron/steam-maintenance')
  async triggerSteamMaintenance(): Promise<
    ApiResponse<{
      refresh: ApiResponse<PipelineRunResult>;
      steamNew: ApiResponse<PipelineRunResult>;
    }>
  > {
    this.logger.log('🕒 [Cron] Steam 출시 윈도우 갱신 시작 (limit=1000)');
    const refreshResult = await this.executeSteamRefresh({
      limit: 1000,
      dryRun: false,
    });
    this.logger.log('🕒 [Cron] Steam 출시 윈도우 갱신 완료');

    this.logger.log('🕒 [Cron] Steam 신규 탐지 시작 (limit=1000)');
    const steamNewResult = await this.executeSteamNew({
      mode: 'operational',
      limit: 1000,
      dryRun: false,
    });
    this.logger.log('🕒 [Cron] Steam 신규 탐지 완료');

    return {
      statusCode: 200,
      message: 'Steam maintenance completed',
      data: {
        refresh: refreshResult,
        steamNew: steamNewResult,
      },
    };
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
      let steamData: ProcessedGameData[] = [];
      let rawgData: ProcessedGameData[] = [];
      let rawgCount = 0;

      // Steam 데이터 수집
      if (phase === 'steam' || phase === 'full') {
        this.logger.log('📥 [수동 파이프라인] Steam 데이터 수집 시작');

        const collectedSteam =
          await this.steamDataPipeline.collectProcessedData({
            mode,
            limit,
            strategy,
          });
        this.logger.log(
          `✨ [수동 파이프라인] Steam: ${collectedSteam.length}/${limit}개 수집 완료`,
        );

        steamData = collectedSteam;
      }

      // RAWG 데이터 수집
      if (phase === 'rawg' || phase === 'full') {
        this.logger.log('📥 [수동 파이프라인] RAWG 데이터 수집 시작');
        rawgData = await this.rawgDataPipeline.collectProcessedData();
        rawgCount = rawgData.length;
        this.logger.log(`✨ [수동 파이프라인] RAWG: ${rawgCount}개 수집 완료`);
      }

      // 통합 저장
      const totalProcessed = steamData.length + rawgData.length;
      this.logger.log(
        `💾 [수동 파이프라인] ${totalProcessed}개 게임 저장 시작`,
      );

      let totalCreated = 0;
      let totalUpdated = 0;
      let totalFailed = 0;

      let steamSummary:
        | {
            created: number;
            updated: number;
            failed: number;
            total: number;
            failures?: {
              steamId: number | null;
              rawgId: number | null;
              slug: string | null;
              reason: string;
              message: string;
            }[];
          }
        | undefined;

      if (steamData.length > 0) {
        const steamResult = await this.persistence.saveProcessedGames(
          steamData,
          pipelineRun.id,
        );
        const steamFailures = this.mapFailureDetails(steamResult.failures);
        steamSummary = {
          created: steamResult.created,
          updated: steamResult.updated,
          failed: steamResult.failed,
          total: steamData.length,
          failures: steamFailures.length > 0 ? steamFailures : undefined,
        };
        totalCreated += steamResult.created;
        totalUpdated += steamResult.updated;
        totalFailed += steamResult.failed;
      }

      if (rawgData.length > 0) {
        const rawgResult = await this.persistence.saveProcessedGames(
          rawgData,
          pipelineRun.id,
        );
        totalCreated += rawgResult.created;
        totalUpdated += rawgResult.updated;
        totalFailed += rawgResult.failed;
      }

      // saveResult는 최소한 아래 형태라고 가정
      // type SaveResult = { created: number; updated: number; failed: number; failedItems?: any[] };

      const duration = Date.now() - startTime;
      const durationSeconds = (duration / 1000).toFixed(2);

      const rawgReport =
        rawgCount > 0 ? this.rawgDataPipeline.getLatestReport() : null;

      await this.completePipelineRun(
        pipelineRun.id,
        'completed',
        undefined,
        totalProcessed,
        totalCreated + totalUpdated,
        totalFailed,
      );
      this.logger.log(`✅ [수동 파이프라인] 완료`);
      this.logger.log(`   - 총 처리 시간: ${durationSeconds}초`);
      this.logger.log(`   - 성공: ${totalCreated + totalUpdated}개`);
      this.logger.log(`   - 실패: ${totalFailed}개`);

      return {
        statusCode: 200,
        message: '파이프라인 수동 실행 완료',
        data: {
          pipelineRunId: pipelineRun.id,
          phase,
          totalProcessed,
          finishedAt: new Date(),
          steamSummary: steamSummary ?? undefined,
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

  @Post('steam/new')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  async executeSteamNew(
    @Body() params: SteamNewDto,
  ): Promise<ApiResponse<PipelineRunResult>> {
    const mode =
      params.mode === 'bootstrap'
        ? ModeEnum.bootstrap
        : ModeEnum.operational;
    const limit = params.limit ?? 2000;
    const dryRun = params.dryRun ?? false;

    // ✅ 배치 저장 크기 (요구사항)
    const SAVE_BATCH_SIZE = 1000;

    this.logger.log('🆕 [Steam 신규 탐지] 시작');
    this.logger.log(`   - mode: ${mode}`);
    this.logger.log(`   - limit: ${limit} (요청값: ${params.limit ?? 'undefined'})`);
    this.logger.log(`   - dryRun: ${dryRun}`);

    const pipelineRun = await this.createPipelineRun(
      'manual',
      'steam',
      'steam_new_pipeline_manual',
    );

    try {
      const existingSteamIdsRaw = await this.gamesRepository
        .createQueryBuilder('g')
        .select('g.steam_id', 'steam_id')
        .where('g.steam_id IS NOT NULL')
        .getRawMany<{ steam_id: number }>();
      const existing = new Set(
        existingSteamIdsRaw.map((r) => Number(r.steam_id)),
      );

      const allIds = await this.steamDataPipeline.listAllSteamAppIdsV2();
      const exclusionBitmap = await this.steamExclusionService.loadBitmap();
      const newcomers = allIds.filter(
        (id) => !existing.has(id) && !exclusionBitmap.has(id),
      );
      const excludedByRegistry = allIds.filter((id) =>
        exclusionBitmap.has(id),
      ).length;

      this.logger.log(
        `🧮 [Steam 신규 탐지] 후보 집계 — AppList=${allIds.length}, DB=${existing.size}, 제외=${excludedByRegistry}, 신규=${newcomers.length}`,
      );

      if (newcomers.length === 0) {
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
            steamNewSummary: {
              candidates: 0,
              inspected: 0,
              targetIds: [],
              excludedByRegistry,
              created: 0,
              updated: 0,
              saved: 0,
              failed: 0,
              dryRun,
            },
          },
        };
      }

      const targets = newcomers.sort((a, b) => b - a).slice(0, limit);
      this.logger.log(
        `🎯 [Steam 신규 탐지] 처리 대상 확정 — limit=${limit}, 실제 대상=${targets.length}`,
      );

      if (dryRun) {
        await this.completePipelineRun(
          pipelineRun.id,
          'completed',
          'dry-run',
          0,
          0,
          0,
        );
        return {
          statusCode: 200,
          message: `Steam 신규 후보 ${targets.length}건 (dry-run)`,
          data: {
            pipelineRunId: pipelineRun.id,
            phase: 'steam',
            totalProcessed: 0,
            finishedAt: new Date(),
            steamNewSummary: {
              candidates: newcomers.length,
              inspected: targets.length,
              targetIds: targets,
              excludedByRegistry,
              created: 0,
              updated: 0,
              saved: 0,
              failed: 0,
              dryRun: true,
              sample: targets.slice(0, Math.min(20, targets.length)),
            },
          },
        };
      }

      // ===== 1+2) 2,000개씩 수집 → 즉시 저장 (청크 단위 처리) =====
      const totalChunks = Math.ceil(targets.length / SAVE_BATCH_SIZE);
      this.logger.log(
        `🔄 [Steam 신규 탐지] ${targets.length}개를 ${totalChunks}개 청크(${SAVE_BATCH_SIZE}개씩)로 처리 시작`,
      );

      const batchResult = await this.runSteamCollectionBatches<number>({
        targets,
        toSteamId: (id) => id,
        mode,
        pipelineRunId: pipelineRun.id,
        dryRun,
        fetchBatchSize: SAVE_BATCH_SIZE,
        saveBatchSize: SAVE_BATCH_SIZE,
        allowCreate: true,
        hooks: {
          onBatchStart: ({
            batchIndex,
            batchCount,
            targetSlice,
            targetStart,
            targetEnd,
          }) => {
            this.logger.log(
              `📥 [Steam 신규 탐지] 청크 ${batchIndex + 1}/${batchCount} — ${targetSlice.length}개 게임 수집 시작 (ID 범위: ${targetStart}-${targetEnd - 1})`,
            );
          },
          onCollected: ({
            batchIndex,
            batchCount,
            steamIds,
            collected,
          }) => {
            this.logger.log(
              `📦 [Steam 신규 탐지] 청크 ${batchIndex + 1}/${batchCount} — 수집 완료: ${collected.length}/${steamIds.length}개`,
            );
          },
          onBeforeSave: ({ batchIndex, batchCount, saveChunk }) => {
            if (saveChunk.length > 0) {
              this.logger.log(
                `💾 [Steam 신규 탐지] 청크 ${batchIndex + 1}/${batchCount} — ${saveChunk.length}개 저장 시작`,
              );
            }
          },
          onSaveResult: ({ batchIndex, batchCount, saveResult }) => {
            this.logger.log(
              `   ✅ 청크 ${batchIndex + 1}/${batchCount} 저장 완료: created=${saveResult.created}, updated=${saveResult.updated}, failed=${saveResult.failed}`,
            );
          },
          onSaveSkipped: ({ batchIndex, batchCount, reason }) => {
            if (reason === 'empty') {
              this.logger.warn(
                `   ⚠️ 청크 ${batchIndex + 1}/${batchCount} 수집된 데이터 없음 → 저장 스킵`,
              );
            }
          },
          onBatchComplete: ({
            batchIndex,
            batchCount,
            totalCollectedSoFar,
            totalCreatedSoFar,
            totalUpdatedSoFar,
            totalFailedSoFar,
          }) => {
            this.logger.log(
              `📊 [Steam 신규 탐지] 진행 상황: ${batchIndex + 1}/${batchCount} 청크 완료 (누적: 수집=${totalCollectedSoFar}, 생성=${totalCreatedSoFar}, 갱신=${totalUpdatedSoFar}, 실패=${totalFailedSoFar})`,
            );
          },
        },
      });

      const failureSummaries = this.mapFailureDetails(batchResult.failures);

      this.logger.log(
        `✅ [Steam 신규 탐지] 전체 처리 완료 — 수집=${batchResult.totalCollected}/${targets.length}, created=${batchResult.totalCreated}, updated=${batchResult.totalUpdated}, failed=${batchResult.totalFailed}`,
      );

      await this.completePipelineRun(
        pipelineRun.id,
        'completed',
        undefined,
        batchResult.totalCollected,
        batchResult.totalCreated + batchResult.totalUpdated,
        batchResult.totalFailed,
      );

      return {
        statusCode: 200,
        message: `Steam 신규 ${batchResult.totalCreated + batchResult.totalUpdated}건 처리 완료 (수집 ${batchResult.totalCollected}/${targets.length}건)`,
        data: {
          pipelineRunId: pipelineRun.id,
          phase: 'steam',
          totalProcessed: batchResult.totalCollected,
          finishedAt: new Date(),
          steamNewSummary: {
            candidates: newcomers.length,
            inspected: targets.length,
            targetIds: targets,
            excludedByRegistry,
            created: batchResult.totalCreated,
            updated: batchResult.totalUpdated,
            saved: batchResult.totalCreated + batchResult.totalUpdated,
            failed: batchResult.totalFailed,
            dryRun: false,
            failures:
              failureSummaries.length > 0 ? failureSummaries : undefined,
          },
        },
      };
    } catch (error) {
      const err = this.normalizeError(error);
      this.logger.error(`❌ [Steam 신규 탐지] 실패 - ${err.message}`);

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

      let saveResult: PersistenceSaveResult = {
        created: 0,
        updated: 0,
        failed: 0,
        failures: [],
      };
      let failureSummaries: {
        steamId: number | null;
        rawgId: number | null;
        slug: string | null;
        reason: string;
        message: string;
      }[] = [];

      if (processed.length > 0) {
        this.logger.log(
          `💾 [Steam Refresh] ${processed.length}/${candidates.length}건 저장 시작`,
        );
        saveResult = await this.persistence.saveProcessedGames(
          processed,
          pipelineRun.id,
        );
        failureSummaries = this.mapFailureDetails(saveResult.failures);

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
            failures:
              failureSummaries.length > 0 ? failureSummaries : undefined,
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

  @Post('steam/full-refresh')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  async executeFullGamesRefresh(
    @Body() params: FullRefreshDto,
  ): Promise<ApiResponse<PipelineRunResult>> {
    const mode = params.mode ?? ModeEnum.operational;
    const dryRun = params.dryRun ?? false;
    const batchSize = params.batchSize ?? 1000;
    const SAVE_BATCH_SIZE = 1000;

    this.logger.log('♻️ [Steam 전체 갱신] 시작');
    this.logger.log(`   - mode: ${mode}`);
    this.logger.log(`   - dryRun: ${dryRun}`);
    this.logger.log(`   - batchSize: ${batchSize}`);

    const pipelineRun = await this.createPipelineRun(
      'manual',
      'full',
      'full_refresh_games_manual',
    );

    try {
      const rawTargets = await this.gamesRepository
        .createQueryBuilder('game')
        .innerJoin('game.details', 'detail')
        .innerJoin('game.releases', 'release')
        .select(['game.id AS game_id', 'game.steam_id AS steam_id'])
        .where('game.steam_id IS NOT NULL')
        .distinct(true)
        .getRawMany<{
          game_id: string;
          steam_id: number | null;
        }>();

      const targets = rawTargets.map((row) => ({
        gameId: Number(row.game_id),
        steamId:
          row.steam_id !== null && Number.isFinite(Number(row.steam_id))
            ? Number(row.steam_id)
            : null,
      }));

      const totalGames = targets.length;
      if (totalGames === 0) {
        await this.completePipelineRun(
          pipelineRun.id,
          'completed',
          'no-targets',
          0,
          0,
          0,
        );
        return {
          statusCode: 200,
          message: '갱신할 게임이 없습니다.',
          data: {
            pipelineRunId: pipelineRun.id,
            phase: 'full',
            totalProcessed: 0,
            finishedAt: new Date(),
            fullRefreshSummary: {
              totalGames: 0,
              processedGames: 0,
              steamRequested: 0,
              collected: 0,
              updated: 0,
              failed: 0,
              dryRun,
            },
          },
        };
      }

      const steamIdSet = new Set<number>();
      targets.forEach((t) => {
        if (t.steamId && t.steamId > 0) steamIdSet.add(t.steamId);
      });

      const totalSteamIds = steamIdSet.size;

      this.logger.log(
        `📊 [Steam 전체 갱신] 대상 ${totalGames}건 (Steam=${totalSteamIds})`,
      );

      const totalBatches = Math.ceil(totalGames / batchSize);
      this.logger.log(
        `🧮 [Steam 전체 갱신] ${totalGames}건을 ${totalBatches}개 배치(${batchSize}개 기준)로 처리`,
      );

      let processedGames = 0;
      const batchResult = await this.runSteamCollectionBatches<
        (typeof targets)[number]
      >({
        targets,
        toSteamId: (target) =>
          typeof target.steamId === 'number' ? target.steamId : null,
        mode,
        pipelineRunId: pipelineRun.id,
        dryRun,
        fetchBatchSize: batchSize,
        saveBatchSize: SAVE_BATCH_SIZE,
        allowCreate: false,
        progressTotal: totalSteamIds > 0 ? totalSteamIds : undefined,
        hooks: {
          onBatchStart: ({
            batchIndex,
            batchCount,
            targetStart,
            targetEnd,
            targetTotal,
            steamIds,
            steamProgressStart,
            steamProgressEnd,
            totalUniqueSteamIds,
          }) => {
            this.logger.log(
              `🔁 [Steam 전체 갱신] 배치 ${batchIndex + 1}/${batchCount} 시작 — 게임 ${targetStart + 1}-${targetEnd}/${targetTotal}`,
            );
            if (steamIds.length > 0) {
              const totalSteam =
                totalUniqueSteamIds > 0 ? totalUniqueSteamIds : steamIds.length;
              this.logger.log(
                `   🔄 Steam 수집 시작 — ${steamIds.length}건 (누적 ${steamProgressStart + 1}-${steamProgressEnd}/${totalSteam})`,
              );
            } else {
              this.logger.log('   ℹ️ Steam 대상 없음 (배치)');
            }
          },
          onCollected: ({ steamIds, collected }) => {
            if (steamIds.length > 0) {
              this.logger.log(
                `   ✅ Steam 수집 완료 — ${collected.length}/${steamIds.length}건`,
              );
            }
          },
          onBeforeSave: ({ saveChunkIndex, saveChunkCount, saveChunk }) => {
            if (dryRun || saveChunk.length === 0) return;
            this.logger.log(
              `   💾 저장 ${saveChunkIndex + 1}/${saveChunkCount} — ${saveChunk.length}건`,
            );
          },
          onSaveResult: ({ saveResult }) => {
            this.logger.log(
              `      ↳ 결과 updated=${saveResult.updated}, failed=${saveResult.failed}`,
            );
          },
          onSaveSkipped: ({ reason }) => {
            if (reason === 'empty' && !dryRun) {
              this.logger.warn(
                '   ⚠️ 수집된 데이터가 없어 저장을 건너뜁니다.',
              );
            }
          },
          onBatchComplete: ({
            batchIndex,
            batchCount,
            targetSlice,
            totalUpdatedSoFar,
            totalFailedSoFar,
          }) => {
            processedGames += targetSlice.length;
            this.logger.log(
              `📈 [Steam 전체 갱신] 배치 ${batchIndex + 1}/${batchCount} 완료 — 누적 처리 ${processedGames}/${totalGames}, 업데이트 ${totalUpdatedSoFar}, 실패 ${totalFailedSoFar}`,
            );
          },
        },
      });

      const failureSummaries = this.mapFailureDetails(batchResult.failures);

      if (dryRun) {
        await this.completePipelineRun(
          pipelineRun.id,
          'completed',
          'dry-run',
          batchResult.totalCollected,
          batchResult.totalUpdated,
          0,
        );
      } else {
        await this.completePipelineRun(
          pipelineRun.id,
          'completed',
          undefined,
          batchResult.totalCollected,
          batchResult.totalUpdated,
          batchResult.totalFailed,
        );
      }

      this.logger.log(
        `✅ [Steam 전체 갱신] 완료 — 대상=${totalGames}, 수집=${batchResult.totalCollected}, 업데이트=${batchResult.totalUpdated}, 실패=${batchResult.totalFailed}, dryRun=${dryRun}`,
      );

      return {
        statusCode: 200,
        message: dryRun
          ? 'Steam 전체 갱신 드라이런 완료'
          : 'Steam 전체 갱신 완료',
        data: {
          pipelineRunId: pipelineRun.id,
          phase: 'full',
          totalProcessed: batchResult.totalCollected,
          finishedAt: new Date(),
          fullRefreshSummary: {
            totalGames,
            processedGames,
            steamRequested: batchResult.totalRequestedSteamIds,
            collected: batchResult.totalCollected,
            updated: batchResult.totalUpdated,
            failed: batchResult.totalFailed,
            dryRun,
            failures:
              failureSummaries.length > 0 ? failureSummaries : undefined,
          },
        },
      };
    } catch (error) {
      const err = this.normalizeError(error);
      this.logger.error(`❌ [Steam 전체 갱신] 실패 - ${err.message}`);
      await this.completePipelineRun(pipelineRun.id, 'failed', err.message);
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
    const mode = params.mode ?? ModeEnum.operational;
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

  private async runSteamCollectionBatches<TTarget>(params: {
    targets: readonly TTarget[];
    toSteamId: (target: TTarget) => number | null | undefined;
    mode: ModeEnum;
    pipelineRunId: number;
    dryRun: boolean;
    fetchBatchSize: number;
    saveBatchSize: number;
    allowCreate: boolean;
    progressOffset?: number;
    progressTotal?: number;
    hooks?: SteamBatchHooks<TTarget>;
  }): Promise<{
    totalCollected: number;
    totalCreated: number;
    totalUpdated: number;
    totalFailed: number;
    failures: SaveFailureDetail[];
    totalRequestedSteamIds: number;
    totalTargets: number;
    totalUniqueSteamIds: number;
  }> {
    const {
      targets,
      toSteamId,
      mode,
      pipelineRunId,
      dryRun,
      fetchBatchSize,
      saveBatchSize,
      allowCreate,
      progressOffset,
      progressTotal,
      hooks,
    } = params;

    const totalTargets = targets.length;
    if (totalTargets === 0) {
      return {
        totalCollected: 0,
        totalCreated: 0,
        totalUpdated: 0,
        totalFailed: 0,
        failures: [],
        totalRequestedSteamIds: 0,
        totalTargets: 0,
        totalUniqueSteamIds: 0,
      };
    }

    const effectiveFetchBatchSize = Math.max(1, fetchBatchSize);
    const effectiveSaveBatchSize = Math.max(1, saveBatchSize);

    const uniqueSteamIds = new Set<number>();
    targets.forEach((target) => {
      const id = toSteamId(target);
      if (typeof id === 'number' && Number.isFinite(id) && id > 0) {
        uniqueSteamIds.add(id);
      }
    });
    const totalUniqueSteamIds = uniqueSteamIds.size;
    const computedProgressTotal =
      progressTotal ??
      (totalUniqueSteamIds > 0 ? totalUniqueSteamIds : totalTargets);

    const batchCount = Math.ceil(totalTargets / effectiveFetchBatchSize);
    const runningTotals: SteamBatchRunningTotals = {
      collected: 0,
      created: 0,
      updated: 0,
      failed: 0,
    };
    const failures: SaveFailureDetail[] = [];

    let steamProgress = progressOffset ?? 0;
    let totalRequestedSteamIds = 0;

    for (let batchIndex = 0; batchIndex < batchCount; batchIndex += 1) {
      const targetStart = batchIndex * effectiveFetchBatchSize;
      const targetEnd = Math.min(targetStart + effectiveFetchBatchSize, totalTargets);
      const targetSlice = targets.slice(targetStart, targetEnd);
      const steamIds = targetSlice
        .map(toSteamId)
        .filter((id): id is number => typeof id === 'number' && Number.isFinite(id) && id > 0);

      const baseContext: SteamBatchContextBase<TTarget> = {
        batchIndex,
        batchCount,
        targetStart,
        targetEnd,
        targetTotal: totalTargets,
        targetSlice,
        steamIds,
        steamProgressStart: steamProgress,
        steamProgressEnd: steamProgress + steamIds.length,
        totalUniqueSteamIds,
        dryRun,
        runningTotals: { ...runningTotals },
      };

      await hooks?.onBatchStart?.(baseContext);

      let collected: ProcessedGameData[] = [];
      if (steamIds.length > 0) {
        collected = await this.steamDataPipeline.collectManyBySteamIds(
          steamIds,
          {
            mode,
            progressOffset: steamProgress,
            progressTotal: computedProgressTotal,
          },
        );
      }

      steamProgress += steamIds.length;
      totalRequestedSteamIds += steamIds.length;
      runningTotals.collected += collected.length;

      const collectedContext: SteamBatchCollectedContext<TTarget> = {
        ...baseContext,
        collected,
        steamProgressStart: baseContext.steamProgressStart,
        steamProgressEnd: steamProgress,
        runningTotals: { ...runningTotals },
      };

      await hooks?.onCollected?.(collectedContext);

      let batchCreated = 0;
      let batchUpdated = 0;
      let batchFailed = 0;

      if (!dryRun && collected.length > 0) {
        const saveChunkCount = Math.ceil(
          collected.length / effectiveSaveBatchSize,
        );
        for (
          let saveChunkIndex = 0;
          saveChunkIndex < saveChunkCount;
          saveChunkIndex += 1
        ) {
          const chunkStart = saveChunkIndex * effectiveSaveBatchSize;
          const chunkEnd = Math.min(
            chunkStart + effectiveSaveBatchSize,
            collected.length,
          );
          const saveChunk = collected.slice(chunkStart, chunkEnd);

          const saveContext: SteamBatchSaveContext<TTarget> = {
            ...collectedContext,
            saveChunkIndex,
            saveChunkCount,
            saveChunk,
          };
          await hooks?.onBeforeSave?.(saveContext);

          const saveResult = await this.persistence.saveProcessedGames(
            saveChunk,
            pipelineRunId,
            allowCreate ? undefined : { allowCreate: false },
          );

          batchCreated += saveResult.created;
          batchUpdated += saveResult.updated;
          batchFailed += saveResult.failed;

          runningTotals.created += saveResult.created;
          runningTotals.updated += saveResult.updated;
          runningTotals.failed += saveResult.failed;

          if (saveResult.failures?.length) {
            failures.push(...saveResult.failures);
          }

          const saveResultContext: SteamBatchSaveResultContext<TTarget> = {
            ...saveContext,
            saveResult,
            runningTotals: { ...runningTotals },
          };
          await hooks?.onSaveResult?.(saveResultContext);
        }
      } else {
        const skippedContext: SteamBatchSaveSkippedContext<TTarget> = {
          ...collectedContext,
          reason: dryRun ? 'dry-run' : 'empty',
          runningTotals: { ...runningTotals },
        };
        await hooks?.onSaveSkipped?.(skippedContext);
      }

      const completedContext: SteamBatchCompletedContext<TTarget> = {
        ...collectedContext,
        batchCreated,
        batchUpdated,
        batchFailed,
        totalCollectedSoFar: runningTotals.collected,
        totalCreatedSoFar: runningTotals.created,
        totalUpdatedSoFar: runningTotals.updated,
        totalFailedSoFar: runningTotals.failed,
        runningTotals: { ...runningTotals },
      };
      await hooks?.onBatchComplete?.(completedContext);
    }

    return {
      totalCollected: runningTotals.collected,
      totalCreated: runningTotals.created,
      totalUpdated: runningTotals.updated,
      totalFailed: runningTotals.failed,
      failures,
      totalRequestedSteamIds,
      totalTargets,
      totalUniqueSteamIds,
    };
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

  private mapFailureDetails(failures: SaveFailureDetail[]): {
    steamId: number | null;
    rawgId: number | null;
    slug: string | null;
    reason: string;
    message: string;
  }[] {
    if (!failures?.length) return [];
    return failures.map((failure) => ({
      steamId: failure.data.steamId ?? null,
      rawgId: failure.data.rawgId ?? null,
      slug:
        failure.data.slug ?? failure.data.ogSlug ?? failure.data.name ?? null,
      reason: failure.reason,
      message: failure.message,
    }));
  }
}
