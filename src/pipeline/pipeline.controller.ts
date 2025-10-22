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
import { GameType } from '../entities/enums';

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

import { SteamRefreshDto } from './dto/steam-refresh.dto';
import { SteamNewDto } from './dto/steam-new.dto';
import {
  SingleGameManualDto,
  ModeEnum,
  SourcesEnum,
} from './dto/single-game-manual-dto';
import {
  FullRefreshDto,
  FullRefreshTargetEnum,
} from './dto/full-refresh.dto';
import { RawgNewDto } from '../rawg/dto/rawg-new.dto';
import { RawgRefreshDto } from '../rawg/dto/rawg-refresh.dto';
import {
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiOkResponse,
} from '@nestjs/swagger';
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

@ApiTags('Pipeline')
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
  @ApiOperation({
    summary: 'Steam 유지보수 (cron용)',
    description:
      '출시 윈도우 갱신과 신규 탐지를 순차적으로 실행합니다. 운영자 전용 엔드포인트입니다.',
  })
  @ApiOkResponse({
    description: '실행 결과',
    schema: {
      example: {
        statusCode: 200,
        message: 'Steam maintenance completed',
        data: {
          refresh: {
            statusCode: 200,
            message: '...',
            data: { pipelineRunId: 1 },
          },
          steamNew: {
            statusCode: 200,
            message: '...',
            data: { pipelineRunId: 2 },
          },
        },
      },
    },
  })
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
  @Post('rawg/new')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({
    summary: 'RAWG 신규 수집',
    description:
      'RAWG에서 지정한 기간/월 범위의 신규 게임을 수집하여 DB에 저장합니다.',
  })
  @ApiBody({
    type: RawgNewDto,
    examples: {
      default: {
        summary: '예시 요청',
        value: {
          monthsBack: 0,
          monthsForward: 1,
          pageSize: 10,
          excludeExisting: true,
          dryRun: false,
        },
      },
      customRange: {
        summary: '명시적 범위 지정 예시',
        value: {
          startMonth: '2024-01',
          endMonth: '2024-06',
          ordering: '-added',
          pageSize: 20,
          excludeExisting: false,
          dryRun: true,
        },
      },
    },
  })
  @ApiOkResponse({
    description: 'RAWG 신규 수집 결과',
    schema: {
      example: {
        statusCode: 200,
        message: 'RAWG 신규 수집 완료 (12.34s)',
        data: {
          pipelineRunId: 123,
          phase: 'rawg-new',
          totalProcessed: 15,
          finishedAt: '2025-10-21T12:00:00.000Z',
          rawgNewSummary: {
            collected: 15,
            saved: 15,
            created: 15,
            updated: 0,
            failed: 0,
            dryRun: false,
            excludeExisting: true,
          },
        },
      },
    },
  })
  async executeRawgNew(
    @Body() dto: RawgNewDto,
  ): Promise<ApiResponse<PipelineRunResult>> {
    const startedAt = Date.now();
    const dryRun = dto.dryRun ?? false;
    const excludeExisting = dto.excludeExisting ?? true;

    const pipelineRun = await this.createPipelineRun(
      'manual',
      'rawg-new',
      'rawg_new_pipeline_manual',
    );

    try {
      const processed = await this.rawgDataPipeline.collectNewGames({
        startMonth: dto.startMonth,
        endMonth: dto.endMonth,
        monthsBack: dto.monthsBack,
        monthsForward: dto.monthsForward,
        limitMonths: dto.limitMonths,
        ordering: dto.ordering,
        metacritic: dto.metacritic,
        pageSize: dto.pageSize,
        excludeExisting,
      });

      const totalCollected = processed.length;
      const groupedByMonth = new Map<string, ProcessedGameData[]>();
      for (const item of processed) {
        const monthKey = item.sourceMonth ?? 'unknown';
        if (!groupedByMonth.has(monthKey)) {
          groupedByMonth.set(monthKey, []);
        }
        groupedByMonth.get(monthKey)!.push(item);
      }
      const orderedMonths = Array.from(groupedByMonth.keys()).sort();

      const aggregated: PersistenceSaveResult = {
        created: 0,
        updated: 0,
        failed: 0,
        failures: [],
      };
      let failureSummaries: ReturnType<typeof this.mapFailureDetails> = [];

      if (!dryRun && totalCollected > 0) {
        const SAVE_BATCH_SIZE = 1000;
        for (const monthKey of orderedMonths) {
          const items = groupedByMonth.get(monthKey)!;
          const totalChunks = Math.ceil(items.length / SAVE_BATCH_SIZE) || 1;
          this.logger.log(
            `💾 [RAWG 신규] ${monthKey} 월 저장 시작 (${items.length}건, 청크=${totalChunks})`,
          );
          for (let index = 0; index < items.length; index += SAVE_BATCH_SIZE) {
            const chunk = items.slice(index, index + SAVE_BATCH_SIZE);
            const chunkNo = Math.floor(index / SAVE_BATCH_SIZE) + 1;
            this.logger.log(
              `   chunk ${chunkNo}/${totalChunks} 저장 (${chunk.length}건)`,
            );
            const chunkResult = await this.persistence.saveProcessedGames(
              chunk,
              pipelineRun.id,
            );
            aggregated.created += chunkResult.created;
            aggregated.updated += chunkResult.updated;
            aggregated.failed += chunkResult.failed;
            if (chunkResult.failures?.length) {
              aggregated.failures.push(...chunkResult.failures);
            }
          }
        }

        failureSummaries = this.mapFailureDetails(aggregated.failures);
      } else if (dryRun) {
        this.logger.log(`🧪 [RAWG 신규] 드라이런 모드 — 저장 생략`);
      } else {
        this.logger.log(`ℹ️ [RAWG 신규] 저장할 데이터가 없습니다.`);
      }

      await this.completePipelineRun(
        pipelineRun.id,
        'completed',
        dryRun ? 'dry-run' : undefined,
        totalCollected,
        aggregated.created + aggregated.updated,
        aggregated.failed,
      );

      const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(2);
      const rawgReport = this.rawgDataPipeline.getLatestReport();

      return {
        statusCode: 200,
        message: `RAWG 신규 수집 완료 (${durationSeconds}s)`,
        data: {
          pipelineRunId: pipelineRun.id,
          phase: 'rawg-new',
          totalProcessed: totalCollected,
          finishedAt: new Date(),
          rawgNewSummary: {
            collected: totalCollected,
            saved: aggregated.created + aggregated.updated,
            created: aggregated.created,
            updated: aggregated.updated,
            failed: aggregated.failed,
            dryRun,
            excludeExisting,
            monthsBack: dto.monthsBack ?? null,
            monthsForward: dto.monthsForward ?? null,
            startMonth: dto.startMonth ?? null,
            endMonth: dto.endMonth ?? null,
            pageSize: dto.pageSize ?? null,
            months: orderedMonths,
            failures:
              failureSummaries.length > 0 ? failureSummaries : undefined,
          },
          rawgReport: rawgReport ?? undefined,
        },
      };
    } catch (error) {
      const err = this.normalizeError(error);
      this.logger.error(`❌ [RAWG 신규] 실패 - ${err.message}`);

      await this.completePipelineRun(pipelineRun.id, 'failed', err.message);
      throw err;
    }
  }

  @Post('rawg/refresh')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({
    summary: 'RAWG 데이터 갱신',
    description:
      'rawgIds 배열을 지정하거나 전체 RAWG DB 게임을 대상으로 상세 정보를 갱신합니다.',
  })
  @ApiBody({
    type: RawgRefreshDto,
    examples: {
      selected: {
        summary: '선택 업데이트',
        value: {
          rawgIds: [1234, 5678],
          chunkSize: 10,
          delayMs: 1000,
          dryRun: false,
        },
      },
      full: {
        summary: '전체 갱신 (limit 100)',
        value: {
          limit: 100,
          chunkSize: 20,
          delayMs: 1500,
          dryRun: true,
        },
      },
    },
  })
  @ApiOkResponse({
    description: 'RAWG 갱신 결과',
    schema: {
      example: {
        statusCode: 200,
        message: 'RAWG 갱신 완료 (8.21s)',
        data: {
          pipelineRunId: 456,
          phase: 'rawg-refresh',
          totalProcessed: 20,
          finishedAt: '2025-10-21T12:10:00.000Z',
          rawgRefreshSummary: {
            targetIds: [1234, 5678],
            inspected: 2,
            processed: 2,
            saved: 2,
            failed: 0,
            dryRun: false,
            chunkSize: 20,
            delayMs: 1000,
          },
        },
      },
    },
  })
  async executeRawgRefresh(
    @Body() dto: RawgRefreshDto,
  ): Promise<ApiResponse<PipelineRunResult>> {
    const startedAt = Date.now();
    const dryRun = dto.dryRun ?? false;

    const pipelineRun = await this.createPipelineRun(
      'manual',
      'rawg-refresh',
      'rawg_refresh_pipeline_manual',
    );

    try {
      let targetIds: number[] = [];
      let processed: ProcessedGameData[] = [];

      if (dto.rawgIds && dto.rawgIds.length > 0) {
        targetIds = Array.from(new Set(dto.rawgIds)).filter((id) => id > 0);
        processed = await this.rawgDataPipeline.collectByRawgIds(targetIds, {
          chunkSize: dto.chunkSize,
          delayMs: dto.delayMs,
        });
      } else {
        const { targetIds: ids, processed: data } =
          await this.rawgDataPipeline.collectAllExisting({
            limit: dto.limit,
            chunkSize: dto.chunkSize,
            delayMs: dto.delayMs,
          });
        targetIds = ids;
        processed = data;
      }

      if (targetIds.length === 0) {
        this.logger.warn('⚠️ [RAWG Refresh] 갱신 대상이 없습니다.');
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
          message: 'RAWG 갱신 대상이 없습니다.',
          data: {
            pipelineRunId: pipelineRun.id,
            phase: 'rawg-refresh',
            totalProcessed: 0,
            finishedAt: new Date(),
            rawgRefreshSummary: {
              targetIds: [],
              inspected: 0,
              processed: 0,
              saved: 0,
              failed: 0,
              dryRun,
              chunkSize: dto.chunkSize ?? null,
              delayMs: dto.delayMs ?? null,
            },
          },
        };
      }

      const totalCollected = processed.length;
      const aggregated: PersistenceSaveResult = {
        created: 0,
        updated: 0,
        failed: 0,
        failures: [],
      };
      let failureSummaries: ReturnType<typeof this.mapFailureDetails> = [];

      if (!dryRun && totalCollected > 0) {
        const SAVE_BATCH_SIZE = 1000;
        const totalChunks = Math.ceil(totalCollected / SAVE_BATCH_SIZE) || 1;
        this.logger.log(
          `💾 [RAWG Refresh] ${totalCollected}/${targetIds.length}건 저장 시작 (청크=${totalChunks})`,
        );
        for (let index = 0; index < totalCollected; index += SAVE_BATCH_SIZE) {
          const chunk = processed.slice(index, index + SAVE_BATCH_SIZE);
          const chunkNo = Math.floor(index / SAVE_BATCH_SIZE) + 1;
          this.logger.log(
            `   chunk ${chunkNo}/${totalChunks} 저장 (${chunk.length}건)`,
          );
          const chunkResult = await this.persistence.saveProcessedGames(
            chunk,
            pipelineRun.id,
          );
          aggregated.created += chunkResult.created;
          aggregated.updated += chunkResult.updated;
          aggregated.failed += chunkResult.failed;
          if (chunkResult.failures?.length) {
            aggregated.failures.push(...chunkResult.failures);
          }
        }
        failureSummaries = this.mapFailureDetails(aggregated.failures);
      } else if (dryRun) {
        this.logger.log(`🧪 [RAWG Refresh] 드라이런 모드 — 저장 생략`);
      } else {
        this.logger.log('ℹ️ [RAWG Refresh] 저장할 데이터가 없습니다.');
      }

      await this.completePipelineRun(
        pipelineRun.id,
        'completed',
        dryRun ? 'dry-run' : undefined,
        targetIds.length,
        aggregated.created + aggregated.updated,
        aggregated.failed,
      );

      const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(2);
      const rawgReport = this.rawgDataPipeline.getLatestReport();

      return {
        statusCode: 200,
        message: `RAWG 갱신 완료 (${durationSeconds}s)`,
        data: {
          pipelineRunId: pipelineRun.id,
          phase: 'rawg-refresh',
          totalProcessed: totalCollected,
          finishedAt: new Date(),
          rawgRefreshSummary: {
            targetIds,
            inspected: targetIds.length,
            processed: totalCollected,
            saved: aggregated.created + aggregated.updated,
            failed: aggregated.failed,
            dryRun,
            chunkSize: dto.chunkSize ?? null,
            delayMs: dto.delayMs ?? null,
            failures:
              failureSummaries.length > 0 ? failureSummaries : undefined,
          },
          rawgReport: rawgReport ?? undefined,
        },
      };
    } catch (error) {
      const err = this.normalizeError(error);
      this.logger.error(`❌ [RAWG Refresh] 실패 - ${err.message}`);

      await this.completePipelineRun(pipelineRun.id, 'failed', err.message);
      throw err;
    }
  }

  @Post('steam/new')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({
    summary: 'Steam 신규 게임 탐지',
    description:
      'Steam AppList에서 기존에 저장되지 않은 게임을 찾아 상세 정보를 수집합니다.',
  })
  @ApiBody({
    type: SteamNewDto,
    examples: {
      default: {
        summary: '예시',
        value: {
          mode: 'operational',
          limit: 500,
          dryRun: false,
        },
      },
    },
  })
  @ApiOkResponse({
    description: 'Steam 신규 탐지 결과',
    schema: {
      example: {
        statusCode: 200,
        message: 'Steam 신규 30건 처리 완료 (수집 30/100건)',
        data: {
          pipelineRunId: 789,
          phase: 'steam',
          totalProcessed: 30,
          finishedAt: '2025-10-21T12:15:00.000Z',
          steamNewSummary: {
            candidates: 120,
            inspected: 100,
            targetIds: [123, 456],
            excludedByRegistry: 5,
            created: 25,
            updated: 5,
            saved: 30,
            failed: 0,
            dryRun: false,
          },
        },
      },
    },
  })
  async executeSteamNew(
    @Body() params: SteamNewDto,
  ): Promise<ApiResponse<PipelineRunResult>> {
    const mode =
      params.mode === 'bootstrap' ? ModeEnum.bootstrap : ModeEnum.operational;
    const limit = params.limit ?? 2000;
    const dryRun = params.dryRun ?? false;

    // ✅ 배치 저장 크기 (요구사항)
    const SAVE_BATCH_SIZE = 1000;

    this.logger.log('🆕 [Steam 신규 탐지] 시작');
    this.logger.log(`   - mode: ${mode}`);
    this.logger.log(
      `   - limit: ${limit} (요청값: ${params.limit ?? 'undefined'})`,
    );
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
          onCollected: ({ batchIndex, batchCount, steamIds, collected }) => {
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
  @ApiOperation({
    summary: 'Steam 출시 윈도우 갱신',
    description:
      '출시 임박 또는 최근 출시된 게임을 중심으로 상세 정보를 재수집합니다.',
  })
  @ApiBody({
    type: SteamRefreshDto,
    examples: {
      default: {
        summary: '예시',
        value: {
          limit: 40,
          dryRun: false,
        },
      },
    },
  })
  @ApiOkResponse({
    description: 'Steam 출시 윈도우 갱신 결과',
    schema: {
      example: {
        statusCode: 200,
        message: 'Steam 출시 윈도우 갱신 완료 (5.02s)',
        data: {
          pipelineRunId: 1011,
          phase: 'steam',
          totalProcessed: 40,
          finishedAt: '2025-10-21T12:20:00.000Z',
          refreshSummary: {
            totalCandidates: 40,
            processed: 38,
            saved: 35,
            failed: 3,
            dryRun: false,
            candidates: [],
          },
        },
      },
    },
  })
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
  @ApiOperation({
    summary: 'Steam 전체 게임 갱신',
    description:
      '저장된 모든 Steam 게임에 대해 상세 정보를 재수집합니다. 비용이 큰 작업이므로 주의해서 사용하세요.',
  })
  @ApiBody({
    type: FullRefreshDto,
    examples: {
      default: {
        summary: '예시',
        value: {
          mode: 'operational',
          dryRun: true,
          limit: 500,
        },
      },
    },
  })
  @ApiOkResponse({
    description: 'Steam 전체 갱신 결과',
    schema: {
      example: {
        statusCode: 200,
        message: 'Steam 전체 갱신 완료 (dry-run)',
        data: {
          pipelineRunId: 1213,
          phase: 'steam',
          totalProcessed: 0,
          finishedAt: '2025-10-21T12:30:00.000Z',
          fullRefreshSummary: {
            totalGames: 5000,
            processedGames: 0,
            steamRequested: 0,
            collected: 0,
            updated: 0,
            failed: 0,
            dryRun: true,
          },
        },
      },
    },
  })
  async executeFullGamesRefresh(
    @Body() params: FullRefreshDto,
  ): Promise<ApiResponse<PipelineRunResult>> {
    const mode = params.mode ?? ModeEnum.operational;
    const dryRun = params.dryRun ?? false;
    const batchSize = params.batchSize ?? 1000;
    const SAVE_BATCH_SIZE = 1000;
    const target = params.target ?? FullRefreshTargetEnum.all;

    this.logger.log('♻️ [Steam 전체 갱신] 시작');
    this.logger.log(`   - mode: ${mode}`);
    this.logger.log(`   - dryRun: ${dryRun}`);
    this.logger.log(`   - batchSize: ${batchSize}`);
    this.logger.log(`   - target: ${target}`);

    const pipelineRun = await this.createPipelineRun(
      'manual',
      'full',
      'full_refresh_games_manual',
    );

    try {
      const query = this.gamesRepository
        .createQueryBuilder('game')
        .select(['game.id AS game_id', 'game.steam_id AS steam_id'])
        .where('game.steam_id IS NOT NULL');

      switch (target) {
        case FullRefreshTargetEnum.zeroPopularity:
          query.andWhere('game.game_type = :gameType', {
            gameType: GameType.GAME,
          });
          query.andWhere('game.popularity_score = 0');
          this.logger.log(
            '   - zero-popularity 모드: 세부 정보 미보유 본편도 포함합니다.',
          );
          break;
        case FullRefreshTargetEnum.missingFollowers:
          query.andWhere('game.followers_cache IS NULL');
          query.andWhere('game.popularity_score > 0');
          this.logger.log(
            '   - missing-followers 모드: 팔로워 캐시 미보유 게임을 갱신합니다.',
          );
          break;
        default:
          query.innerJoin('game.details', 'detail');
          query.innerJoin('game.releases', 'release');
          break;
      }

      const rawTargets = await query
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
              target,
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
              this.logger.warn('   ⚠️ 수집된 데이터가 없어 저장을 건너뜁니다.');
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
            target,
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
      const targetEnd = Math.min(
        targetStart + effectiveFetchBatchSize,
        totalTargets,
      );
      const targetSlice = targets.slice(targetStart, targetEnd);
      const steamIds = targetSlice
        .map(toSteamId)
        .filter(
          (id): id is number =>
            typeof id === 'number' && Number.isFinite(id) && id > 0,
        );

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
    phase: string,
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
