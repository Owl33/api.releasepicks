import { PERFORMANCE_LIMITS } from '../../../common/constants/game-classification.constants';
import { GameNameAnalysis } from './classification.types';

/**
 * Steam 검색 전략 후보를 생성한다.
 */
export function buildSearchStrategies(
  nameAnalysis: GameNameAnalysis,
  rawgName: string,
): string[] {
  const strategies = new Set<string>();
  strategies.add(rawgName);

  if (
    nameAnalysis.patterns.isDlc ||
    nameAnalysis.patterns.isEdition ||
    nameAnalysis.patterns.isPort
  ) {
    if (nameAnalysis.cleanedName && nameAnalysis.cleanedName !== rawgName) {
      strategies.add(nameAnalysis.cleanedName);
    }

    if (
      nameAnalysis.extractedInfo.baseName &&
      nameAnalysis.extractedInfo.baseName !== rawgName
    ) {
      strategies.add(nameAnalysis.extractedInfo.baseName);
    }
  }

  return Array.from(strategies)
    .filter((value) => value && value.length >= 3)
    .slice(0, PERFORMANCE_LIMITS.MAX_SEARCH_STRATEGIES);
}
