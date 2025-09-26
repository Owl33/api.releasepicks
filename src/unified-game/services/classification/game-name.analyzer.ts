import { GAME_KEYWORDS } from '../../../common/constants/game-classification.constants';
import { GameNameAnalysis } from './classification.types';

/**
 * 게임명을 분석해 DLC 여부, 부제 유무 등 패턴을 추출한다.
 */
export function analyzeGameName(gameName: string): GameNameAnalysis {
  const originalName = gameName.trim();
  const lowerName = originalName.toLowerCase();

  const isDlc = GAME_KEYWORDS.DLC.some((kw) => lowerName.includes(kw));
  const isEdition = GAME_KEYWORDS.EDITION.some((kw) => lowerName.includes(kw));
  const isPort = GAME_KEYWORDS.PORT.some((kw) => lowerName.includes(kw));

  const colonIndex = originalName.indexOf(':');
  const dashIndex = originalName.indexOf(' - ');

  let baseName = originalName;
  let subtitle: string | undefined;

  if (colonIndex > 0) {
    baseName = originalName.substring(0, colonIndex).trim();
    subtitle = originalName.substring(colonIndex + 1).trim();
  } else if (dashIndex > 0) {
    baseName = originalName.substring(0, dashIndex).trim();
    subtitle = originalName.substring(dashIndex + 3).trim();
  }

  let cleanedName = originalName;
  if (isDlc && subtitle) {
    cleanedName = baseName;
  }

  const detectedKeywords: string[] = [];
  if (isDlc) {
    detectedKeywords.push(
      ...GAME_KEYWORDS.DLC.filter((kw) => lowerName.includes(kw)),
    );
  }
  if (isEdition) {
    detectedKeywords.push(
      ...GAME_KEYWORDS.EDITION.filter((kw) => lowerName.includes(kw)),
    );
  }
  if (isPort) {
    detectedKeywords.push(
      ...GAME_KEYWORDS.PORT.filter((kw) => lowerName.includes(kw)),
    );
  }

  return {
    originalName,
    cleanedName,
    patterns: {
      isDlc,
      isEdition,
      isPort,
      hasSubtitle: !!subtitle,
    },
    extractedInfo: {
      baseName,
      subtitle,
      detectedKeywords,
    },
  };
}
