import { Injectable } from '@nestjs/common';

import { GAME_TYPES } from '../../common/constants/game-classification.constants';
import { GameCalendarData } from '../../types/game-calendar-unified.types';
import type {
  ClassificationContext,
  GameClassificationResult,
  GameNameAnalysis,
} from './classification/classification.types';
import { analyzeGameName } from './classification/game-name.analyzer';
import { classifyGame } from './classification/game-classification.rules';
import { buildSearchStrategies } from './classification/search-strategy.builder';

@Injectable()
export class GameClassificationService {
  analyzeName(gameName: string): GameNameAnalysis {
    return analyzeGameName(gameName);
  }

  classify(
    nameAnalysis: GameNameAnalysis,
    context: ClassificationContext,
  ): GameClassificationResult {
    return classifyGame(nameAnalysis, context);
  }

  generateSearchStrategies(
    nameAnalysis: GameNameAnalysis,
    rawgName: string,
  ): string[] {
    return buildSearchStrategies(nameAnalysis, rawgName);
  }

  applyClassification(
    game: GameCalendarData,
    classification: GameClassificationResult,
  ): GameCalendarData {
    return {
      ...game,
      game_type: classification.gameType,
      game_type_confidence: classification.confidence,
      game_type_reason: classification.reason,
      is_dlc: classification.gameType === GAME_TYPES.DLC,
    };
  }
}

export type {
  ClassificationContext,
  GameClassificationResult,
  GameNameAnalysis,
} from './classification/classification.types';
