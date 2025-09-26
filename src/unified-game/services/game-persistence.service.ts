import { Logger } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';

import {
  GameCalendarData,
  MonthlyUnifiedGameResult,
  UnifiedGameOptions,
} from '../../types/game-calendar-unified.types';
import { Game } from '../../entities/game.entity';
import { GameDetail } from '../../entities/game-detail.entity';
import { IngestLog } from '../../entities/ingest-log.entity';
import { IngestStatus } from '../../types/domain.types';
import { DataMapper } from '../persistence/mappers/data.mapper';
import { LoggerHelper } from '../../common/utils/logger.helper';
import { GameUpdateEvaluator } from '../persistence/game-update.evaluator';
import { DlcRelationManager } from '../persistence/dlc-relation.manager';

export type PersistenceAction = 'inserted' | 'updated' | 'skipped' | 'error';

export interface PersistenceSummary {
  rawgId: number;
  action: PersistenceAction;
  updatedFields: string[];
}

export interface PersistenceResult {
  saved: number;
  skipped: number;
  errors: number;
  summaries?: PersistenceSummary[];
  ingestLogId?: string;
}

export interface PersistenceDependencies {
  dataSource: DataSource;
  ingestLogRepository: Repository<IngestLog>;
  updateEvaluator: GameUpdateEvaluator;
}

export class GamePersistenceService {
  private readonly logger = new Logger(GamePersistenceService.name);
  private readonly dlcRelationManager = new DlcRelationManager(this.logger);

  constructor(private readonly deps: PersistenceDependencies) {}

  static create(deps: PersistenceDependencies): GamePersistenceService {
    return new GamePersistenceService(deps);
  }

  async fetchGameSnapshot(criteria: {
    rawgId?: number | null;
    steamId?: number | null;
  }): Promise<GameCalendarData | null> {
    const rawgId = criteria.rawgId ?? null;
    const steamId = criteria.steamId ?? null;

    if (!rawgId && !steamId) {
      return null;
    }

    const repository = this.deps.dataSource.getRepository(Game);
    const query = repository
      .createQueryBuilder('game')
      .leftJoinAndSelect('game.game_detail', 'detail');

    if (rawgId && steamId) {
      query
        .where('game.rawg_id = :rawgId', { rawgId })
        .orWhere('game.steam_id = :steamId', { steamId });
    } else if (rawgId) {
      query.where('game.rawg_id = :rawgId', { rawgId });
    } else if (steamId) {
      query.where('game.steam_id = :steamId', { steamId });
    }

    const entity = await query.getOne();
    if (!entity) {
      return null;
    }

    const detail = (entity as Game & { game_detail?: GameDetail | null })
      .game_detail ?? null;

    return DataMapper.mapFromGameEntity(entity, detail);
  }

  async persistBatch(
    games: GameCalendarData[],
    month: string,
    options: Required<UnifiedGameOptions>,
    processingResult: MonthlyUnifiedGameResult,
    context: { captureDiff?: boolean } = {},
  ): Promise<PersistenceResult> {
    LoggerHelper.logStart(this.logger, '월별 게임 저장', {
      month,
      options,
      stats: processingResult.collection_stats,
    });

    const result = await this.saveGames(games, context.captureDiff ?? false);
    const ingestLogId = await this.recordIngestLog(
      month,
      options,
      processingResult,
      result,
    );

    LoggerHelper.logComplete(this.logger, '월별 게임 저장', {
      ...result,
      stats: processingResult.collection_stats,
    });

    return {
      ...result,
      ingestLogId,
    };
  }

  private async saveGames(
    games: GameCalendarData[],
    captureDiff: boolean,
  ): Promise<PersistenceResult> {
    if (games.length === 0) {
      return { saved: 0, skipped: 0, errors: 0 };
    }

    const { dataSource, updateEvaluator } = this.deps;
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;
    const summaries: PersistenceSummary[] = [];

    try {
      for (const gameData of games) {
        try {
          const existing = await queryRunner.manager.findOne(Game, {
            where: { rawg_id: gameData.rawg_id },
            relations: ['game_detail'],
          });

          if (!existing) {
            const gameEntity = queryRunner.manager.create(
              Game,
              DataMapper.mapToGameEntity(gameData),
            );
            const savedGame = await queryRunner.manager.save(gameEntity);

            const detailEntity = queryRunner.manager.create(
              GameDetail,
              DataMapper.mapToGameDetailEntity(gameData, savedGame.id),
            );
            await queryRunner.manager.save(detailEntity);
            await this.dlcRelationManager.ensureRelations(
              queryRunner.manager,
              savedGame,
              gameData,
            );
            inserted += 1;
            if (captureDiff) {
              summaries.push({
                rawgId: gameData.rawg_id,
                action: 'inserted',
                updatedFields: [],
              });
            }
          } else {
            const evaluation = updateEvaluator.evaluate(
              existing,
              existing.game_detail,
              gameData,
            );

            if (evaluation.shouldUpdateGame) {
              DataMapper.updateGameEntity(existing, gameData);
              await queryRunner.manager.save(existing);
            }

            if (evaluation.shouldUpdateDetail) {
              if (existing.game_detail) {
                DataMapper.updateGameDetailEntity(
                  existing.game_detail,
                  gameData,
                );
                await queryRunner.manager.save(existing.game_detail);
              } else {
                const detailEntity = queryRunner.manager.create(
                  GameDetail,
                  DataMapper.mapToGameDetailEntity(gameData, existing.id),
                );
                await queryRunner.manager.save(detailEntity);
              }
            }

            await this.dlcRelationManager.ensureRelations(
              queryRunner.manager,
              existing,
              gameData,
            );

            if (evaluation.shouldUpdateGame || evaluation.shouldUpdateDetail) {
              updated += 1;
              const hasDiff =
                evaluation.gameDiff.changedPaths.length > 0 ||
                evaluation.gameDiff.created.length > 0 ||
                evaluation.gameDiff.removed.length > 0 ||
                evaluation.detailDiff.changedPaths.length > 0 ||
                evaluation.detailDiff.created.length > 0 ||
                evaluation.detailDiff.removed.length > 0;

              if (hasDiff) {
                LoggerHelper.logStats(this.logger, '게임 업데이트 필드', {
                  game: evaluation.gameDiff,
                  detail: evaluation.detailDiff,
                  rawg_id: gameData.rawg_id,
                });
              }

              if (captureDiff) {
                const updatedFields = new Set<string>();
                evaluation.gameDiff.changedPaths.forEach((path) =>
                  updatedFields.add(path.replace(/^game\./, '')),
                );
                evaluation.detailDiff.changedPaths.forEach((path) =>
                  updatedFields.add(path.replace(/^detail\./, '')),
                );
                evaluation.gameDiff.created.forEach((path) =>
                  updatedFields.add(path.replace(/^game\./, '')),
                );
                evaluation.detailDiff.created.forEach((path) =>
                  updatedFields.add(path.replace(/^detail\./, '')),
                );

                summaries.push({
                  rawgId: gameData.rawg_id,
                  action: 'updated',
                  updatedFields: Array.from(updatedFields),
                });
              }
            } else {
              skipped += 1;
              if (captureDiff) {
                summaries.push({
                  rawgId: gameData.rawg_id,
                  action: 'skipped',
                  updatedFields: [],
                });
              }
            }
          }
        } catch (error) {
          errors += 1;
          this.logger.error(
            `게임 저장 실패: ${gameData.name}`,
            (error as Error)?.stack || String(error),
          );
          if (captureDiff) {
            summaries.push({
              rawgId: gameData.rawg_id,
              action: 'error',
              updatedFields: [],
            });
          }
        }
      }

      await queryRunner.commitTransaction();
    } catch (transactionError) {
      await queryRunner.rollbackTransaction();
      throw transactionError;
    } finally {
      await queryRunner.release();
    }

    return {
      saved: inserted + updated,
      skipped,
      errors,
      summaries: captureDiff ? summaries : undefined,
    };
  }

  private async recordIngestLog(
    month: string,
    options: Required<UnifiedGameOptions>,
    processingResult: MonthlyUnifiedGameResult,
    persistence: PersistenceResult,
  ): Promise<string | undefined> {
    const status: IngestStatus =
      persistence.errors > 0 && persistence.saved === 0
        ? 'failed'
        : persistence.errors > 0
          ? 'partial'
          : 'success';

    const { ingestLogRepository } = this.deps;

    const savedLog = await ingestLogRepository.save({
      status,
      context: {
        month,
        options,
      },
      affected_games: {
        total: processingResult.total_games,
        updated: persistence.saved,
        skipped: persistence.skipped,
        failed: persistence.errors,
      },
      details: {
        collection_stats: processingResult.collection_stats,
      },
    });

    return savedLog?.id;
  }
}
