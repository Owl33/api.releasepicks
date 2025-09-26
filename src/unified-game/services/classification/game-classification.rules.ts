import {
  CONFIDENCE_THRESHOLDS,
  GAME_TYPES,
} from '../../../common/constants/game-classification.constants';
import {
  ClassificationContext,
  GameClassificationResult,
  GameNameAnalysis,
} from './classification.types';

/**
 * RAWG·Steam 맥락과 이름 분석 결과를 기반으로 규칙에 따라 게임 타입을 판별한다.
 */
export function classifyGame(
  nameAnalysis: GameNameAnalysis,
  context: ClassificationContext,
): GameClassificationResult {
  const {
    parentsCount,
    additionsCount,
    hasStoreLink,
    steamType,
    dlcList,
    hasFullgameInfo,
  } = context;

  if (parentsCount > 0 && nameAnalysis.patterns.isDlc) {
    return {
      gameType: GAME_TYPES.DLC,
      confidence: 0.98,
      reason: `RAWG 부모 게임 ${parentsCount}개 존재`,
      isMainGame: false,
      priority: 50,
    };
  }

  if (parentsCount === 0 && additionsCount > 0 && hasStoreLink) {
    return {
      gameType: GAME_TYPES.MAIN_GAME,
      confidence: 0.95,
      reason: `RAWG 본편 게임 (추가 콘텐츠 ${additionsCount}개)`,
      isMainGame: true,
      priority: 100,
    };
  }

  if (steamType === 'dlc') {
    return {
      gameType: GAME_TYPES.DLC,
      confidence: 0.95,
      reason: `Steam 공식 DLC${hasFullgameInfo ? ' (본편 정보 포함)' : ''}`,
      isMainGame: false,
      priority: 60,
    };
  }

  if (steamType === 'game' && parentsCount === 0 && additionsCount === 0) {
    const dlcCount = dlcList?.length ?? 0;
    return {
      gameType: GAME_TYPES.MAIN_GAME,
      confidence: 0.95,
      reason: `Steam 본편 게임 (${dlcCount}개 DLC 보유)`,
      isMainGame: true,
      priority: 95,
    };
  }

  if (nameAnalysis.patterns.isDlc) {
    return {
      gameType: GAME_TYPES.DLC,
      confidence: CONFIDENCE_THRESHOLDS.MEDIUM,
      reason: `게임명 DLC 패턴${
        nameAnalysis.extractedInfo.subtitle
          ? `: ${nameAnalysis.extractedInfo.subtitle}`
          : ''
      }`,
      isMainGame: false,
      priority: 55,
    };
  }

  return {
    gameType: GAME_TYPES.STANDALONE,
    confidence: 0.85,
    reason: '추가 콘텐츠/부모 게임/특수 패턴 없음',
    isMainGame: true,
    priority: 88,
  };
}
