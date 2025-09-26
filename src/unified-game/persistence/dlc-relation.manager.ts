import { Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { Game } from '../../entities/game.entity';
import { GameCalendarData } from '../../types/game-calendar-unified.types';
import { LoggerHelper } from '../../common/utils/logger.helper';
import { DlcRelationPlan } from '../../types/persistence.types';

export class DlcRelationManager {
  constructor(private readonly logger: Logger) {}

  async ensureRelations(
    manager: EntityManager,
    game: Game,
    gameData: GameCalendarData,
  ): Promise<void> {
    if (gameData.is_dlc) {
      const plan = this.buildRelationPlan(gameData);
      await this.attachParent(manager, game, plan);
    } else if (game.parent_game_id || game.parent_steam_game_id) {
      game.parent_game_id = undefined;
      game.parent_steam_game_id = undefined;
      await manager.save(game);
    }
  }

  private buildRelationPlan(gameData: GameCalendarData): DlcRelationPlan {
    const steamContext = gameData.dlc_context?.steam_fullgame_info;
    const rawgParentIds = gameData.dlc_context?.rawg_parent_ids;
    const classification = gameData.game_type
      ? {
          type: gameData.game_type,
          confidence: gameData.game_type_confidence ?? 0,
          reason: gameData.game_type_reason ?? '',
        }
      : undefined;

    return {
      rawgId: gameData.rawg_id,
      steamId: gameData.steam_id ?? null,
      parentSteamId:
        gameData.parent_steam_id ??
        (steamContext?.appid ? Number(steamContext.appid) : null),
      parentRawgId:
        gameData.parent_rawg_id ??
        (Array.isArray(rawgParentIds) && rawgParentIds.length > 0
          ? rawgParentIds[0] ?? null
          : null),
      classification,
    };
  }

  private async attachParent(
    manager: EntityManager,
    game: Game,
    plan: DlcRelationPlan,
  ): Promise<void> {
    const searchConditions = [] as Array<Promise<Game | null>>;

    if (plan.parentSteamId) {
      searchConditions.push(
        manager.findOne(Game, {
          where: { steam_id: plan.parentSteamId },
        }),
      );
    }

    if (plan.parentRawgId) {
      searchConditions.push(
        manager.findOne(Game, {
          where: { rawg_id: plan.parentRawgId },
        }),
      );
    }

    if (searchConditions.length === 0) {
      LoggerHelper.logWarning(
        this.logger,
        'DLC 부모 미지정',
        'steam/rawg ID 미확인',
        {
          rawg_id: game.rawg_id,
          classification: plan.classification,
        },
      );
      return;
    }

    const parent = (await Promise.all(searchConditions)).find(Boolean) || null;

    if (!parent) {
      LoggerHelper.logWarning(
        this.logger,
        'DLC 부모 미확인',
        '부모 게임을 찾을 수 없음',
        {
          rawg_id: game.rawg_id,
          parent_steam_id: plan.parentSteamId,
          parent_rawg_id: plan.parentRawgId,
          classification: plan.classification,
        },
      );
      return;
    }

    game.parent_game_id = parent.id;
    game.parent_steam_game_id =
      parent.steam_id ?? plan.parentSteamId ?? undefined;
    await manager.save(game);
  }
}
