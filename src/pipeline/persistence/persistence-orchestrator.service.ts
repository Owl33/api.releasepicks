import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import { join } from 'path';
import { setTimeout as sleep } from 'timers/promises';

import { DataSource, EntityManager, ILike, QueryFailedError } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ProcessedGameData } from '@pipeline/contracts';

import { Game } from '../../entities/game.entity';
import { PipelineItem } from '../../entities/pipeline-item.entity';
import { PipelineRun } from '../../entities/pipeline-run.entity';
import { RateLimitExceededError } from '../../common/concurrency/rate-limit-monitor';
import { PersistenceSaveResult, SaveMetricsSummary } from './persistence.types';
import {
  SaveFailureDetail,
  SaveFailureReason,
} from '../contracts/save-result.contract';
import { GamePersistenceService } from './services/game-persistence.service';
import { GamePersistenceResult } from './services/game-persistence.service';

/**
 * PersistenceOrchestratorService
 * - 기존 PipelineController.saveIntegratedData 로직을 이관하여
 *   게임 데이터를 저장하고 메트릭을 축적한다.
 */
@Injectable()
export class PersistenceOrchestratorService {
  private readonly logger = new Logger(PersistenceOrchestratorService.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(PipelineRun)
    private readonly pipelineRunsRepository: Repository<PipelineRun>,
    private readonly gamePersistence: GamePersistenceService,
  ) {}

  async saveBatch(
    data: ProcessedGameData[],
    pipelineRunId: number,
    options?: { allowCreate?: boolean },
  ): Promise<PersistenceSaveResult> {
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
    const failures: SaveFailureDetail[] = [];

    let activeWorkers = 0;

    const calculateBackoff = (attempt: number): number => {
      const base = retryBaseDelay * Math.pow(2, attempt - 1);
      const jitter =
        retryJitter > 0 ? Math.floor(Math.random() * retryJitter) : 0;
      return Math.min(retryMaxDelay, base + jitter);
    };

    const emitProgress = (): void => {
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
        const identity = this.formatGameKey(item.data);

        let matchedByKey:
          | 'steam_id'
          | 'rawg_id'
          | 'slug'
          | 'og_slug'
          | 'unknown' = 'unknown';

        try {
          let operation: 'created' | 'updated' | null = null;
          let targetGameId: number | null = null;

          await this.dataSource.transaction(async (manager) => {
            const result = await this.gamePersistence.upsertProcessedGame(
              item.data,
              manager,
              { allowCreate: options?.allowCreate ?? true },
            );
            operation = result.operation;
            targetGameId = result.gameId;
            matchedByKey = result.matchedBy ?? 'unknown';

            await this.createPipelineItem(
              pipelineRunId,
              'game',
              result.gameId,
              result.operation,
              manager,
            );
          });

          const durationMs = Date.now() - start;
          latencies.push(durationMs);
          retryHistogram.set(
            item.attempt,
            (retryHistogram.get(item.attempt) ?? 0) + 1,
          );

          if (operation === 'created') {
            if (options?.allowCreate === false) {
              throw new Error(
                `CREATE_NOT_ALLOWED: attempted to create new game (steamId=${item.data.steamId ?? 'null'}, slug=${item.data.slug ?? item.data.name})`,
              );
            }
            createdCount++;
            this.logger.log(
              `➕ [통합 저장] 생성 gameId=${targetGameId ?? '-'} (${identity}) name="${item.data.name}" ${durationMs}ms`,
            );
          } else if (operation === 'updated') {
            updatedCount++;
            this.logger.log(
              `🛠️ [통합 저장] 업데이트 gameId=${targetGameId ?? '-'} by=${matchedByKey} (${identity}) name="${item.data.name}" ${durationMs}ms`,
            );
          }

          processedCount++;
          emitProgress();
        } catch (error) {
          const is23505 = (error as { code?: string })?.code === '23505';
          const constraint =
            (error as { constraint?: string })?.constraint ?? '';
          const detail = (error as { detail?: string })?.detail;

          if (is23505 && constraint === 'games_og_slug_key') {
            try {
              const recoveryResult =
                await this.dataSource.transaction<GamePersistenceResult>(
                  async (manager) => {
                    const collidedOg =
                      this.extractUniqueValueFromDetail(detail, 'og_slug') ??
                      item.data.ogSlug ??
                      item.data.ogName ??
                      item.data.slug ??
                      item.data.name;

                    if (!collidedOg) {
                      throw error;
                    }

                    const existing = await manager.findOne(Game, {
                      where: { og_slug: ILike(collidedOg) },
                    });
                    if (!existing) {
                      throw error;
                    }

                    const result =
                      await this.gamePersistence.upsertWithExistingGame(
                        existing,
                        item.data,
                        manager,
                      );

                    await this.createPipelineItem(
                      pipelineRunId,
                      'game',
                      result.gameId,
                      result.operation,
                      manager,
                    );

                    return result;
                  },
                );

              retryHistogram.set(
                item.attempt,
                (retryHistogram.get(item.attempt) ?? 0) + 1,
              );
              if (recoveryResult.operation === 'created') createdCount++;
              if (recoveryResult.operation === 'updated') updatedCount++;
              matchedByKey = recoveryResult.matchedBy ?? 'og_slug';
              processedCount++;
              emitProgress();
              continue;
            } catch (recoverError) {
              error = recoverError;
            }
          }

          const errorInfo = this.classifySaveError(error);
          const normalized = this.normalizeError(error);

          if (normalized instanceof RateLimitExceededError) {
            this.logger.warn(
              `⏳ [통합 저장] RateLimitExceededError 감지 → 5초 대기 후 재시도 (${identity})`,
            );
            await sleep(5000);
          }

          if (item.attempt >= maxAttempts || errorInfo.type === 'permanent') {
            failedCount++;
            processedCount++;
            this.logger.error(
              `❌ [통합 저장] 실패 (${item.attempt}/${maxAttempts}) - ${identity} - ${normalized.message}`,
              (normalized as Error).stack,
            );
            const failureCode =
              (normalized as { code?: string }).code ??
              errorInfo.code ??
              normalized.name ??
              'unknown';
            failureReasons.set(
              failureCode,
              (failureReasons.get(failureCode) ?? 0) + 1,
            );
            failures.push({
              data: item.data,
              reason: this.mapFailureReason(failureCode, normalized.message),
              message: normalized.message,
            });
            emitProgress();
          } else {
            item.attempt += 1;
            queue.push(item);
            const backoff = calculateBackoff(item.attempt);
            this.logger.warn(
              `🔁 [통합 저장] 재시도 예정 (${item.attempt}/${maxAttempts}) - ${identity} - ${normalized.message} (${backoff}ms 후)`,
            );
            await sleep(backoff);
          }
        } finally {
          activeWorkers = Math.max(0, activeWorkers - 1);
        }
      }
    };

    const workers = Array.from({ length: concurrency }).map(() => worker());
    await Promise.all(workers);

    const successTotal = createdCount + updatedCount;
    const successRate =
      totalCount === 0 ? 1 : Number((successTotal / totalCount).toFixed(4));
    const avgLatency =
      latencies.length === 0
        ? 0
        : Math.round(
            latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
          );
    const p95Latency = this.calculatePercentile(latencies, 0.95);

    const metrics: SaveMetricsSummary = {
      totalItems: totalCount,
      successRate,
      avgLatencyMs: avgLatency,
      p95LatencyMs: p95Latency,
      created: createdCount,
      updated: updatedCount,
      failed: failedCount,
      retries: Object.fromEntries(
        Array.from(retryHistogram.entries()).map(([attempt, count]) => [
          String(attempt),
          count,
        ]),
      ),
      failureReasons: Array.from(failureReasons.entries()).map(
        ([code, count]) => ({ code, count }),
      ),
      concurrency,
      maxAttempts,
    };

    await this.persistSaveMetrics(pipelineRunId, metrics);

    return {
      created: createdCount,
      updated: updatedCount,
      failed: failedCount,
      failures,
    };
  }

  private formatGameKey(g: ProcessedGameData): string {
    const s = (v: unknown) =>
      v === null || v === undefined || v === '' ? '-' : String(v);
    return `steam:${s(g.steamId)} rawg:${s(g.rawgId)} slug:${s(g.slug)} og:${s(g.ogSlug)}`;
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

    const normalized = this.normalizeError(error);
    const message = normalized.message;

    if (/CREATE_NOT_ALLOWED/i.test(message)) {
      return { type: 'permanent', code: 'CREATE_NOT_ALLOWED' };
    }

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

  private async createPipelineItem(
    runId: number,
    subjectType: 'game' | 'release',
    subjectId: number,
    action: 'created' | 'updated',
    manager: EntityManager,
  ): Promise<void> {
    const item = manager.create(PipelineItem, {
      pipeline_run_id: runId,
      target_type: subjectType,
      target_id: subjectId,
      action_name: action,
      status: 'success',
    });

    await manager.save(PipelineItem, item);
  }

  private extractUniqueValueFromDetail(
    detail?: string,
    column = 'og_slug',
  ): string | null {
    if (!detail) return null;
    const m = detail.match(new RegExp(`\\(${column}\\)=\\((.+?)\\)`));
    return m ? m[1] : null;
  }

  private generateCompanySlug(name: string): string {
    if (!name || typeof name !== 'string') {
      this.logger.warn(
        `⚠️ generateCompanySlug: 잘못된 name 타입 - ${typeof name}, 값: ${JSON.stringify(name)}`,
      );
      return 'unknown-company';
    }

    return (
      name
        .toLowerCase()
        .replace(/[^a-z0-9가-힣\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 100) || 'unknown-company'
    );
  }

  private calculatePercentile(values: number[], percentile: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil(percentile * sorted.length) - 1),
    );
    return Math.round(sorted[rank]);
  }

  private mapFailureReason(code: string, message?: string): SaveFailureReason {
    const normalizedCode = code?.toUpperCase?.() ?? '';
    const normalizedMessage = message?.toLowerCase?.() ?? '';

    if (
      normalizedCode === '23505' ||
      /duplicate|unique/.test(normalizedMessage)
    ) {
      return 'DUPLICATE_CONSTRAINT';
    }
    if (
      normalizedCode === '23502' ||
      normalizedCode === '23514' ||
      normalizedCode === '22P02'
    ) {
      return 'VALIDATION_FAILED';
    }
    if (
      /steam/.test(normalizedMessage) &&
      /not found|404/.test(normalizedMessage)
    ) {
      return 'STEAM_APP_NOT_FOUND';
    }
    if (
      /rawg/.test(normalizedMessage) &&
      /not found|404/.test(normalizedMessage)
    ) {
      return 'RAWG_GAME_NOT_FOUND';
    }
    if (
      normalizedCode === 'RATE_LIMIT' ||
      /rate limit/.test(normalizedMessage)
    ) {
      return 'RATE_LIMIT';
    }
    return 'UNKNOWN';
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
}
