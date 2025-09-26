import { GameTypeValue } from '../../../types/domain.types';

/**
 * 게임명 분석 결과를 표현하는 구조체
 */
export interface GameNameAnalysis {
  originalName: string;
  cleanedName: string;
  patterns: {
    isDlc: boolean;
    isEdition: boolean;
    isPort: boolean;
    hasSubtitle: boolean;
  };
  extractedInfo: {
    baseName: string;
    subtitle?: string;
    detectedKeywords: string[];
  };
}

/**
 * 분류 결과를 통합 표현하는 구조체
 */
export interface GameClassificationResult {
  gameType: GameTypeValue;
  confidence: number;
  reason: string;
  isMainGame: boolean;
  priority: number;
}

/**
 * RAWG·Steam 맥락 정보를 담아 분류 규칙에서 활용하도록 전달
 */
export interface ClassificationContext {
  rawgName: string;
  parentsCount: number;
  additionsCount: number;
  hasStoreLink: boolean;
  steamType?: string | null;
  dlcList?: number[];
  hasFullgameInfo?: boolean;
}
