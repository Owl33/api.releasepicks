/**
 * 🎯 통합 게임 분석 서비스
 * GameAnalysisService + ClassificationResultBuilder + DlcCheckResultBuilder 통합
 *
 * 통합된 기능:
 * - 게임명 분석 및 패턴 인식
 * - 게임 분류 및 신뢰도 계산
 * - DLC 역검색 및 매칭
 * - 검색 전략 생성
 * - 분류 결과 빌드 패턴 통합
 */

import { Logger } from '@nestjs/common';

// === 타입 정의 ===

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

export interface GameClassificationResult {
  gameType: 'main_game' | 'dlc' | 'edition' | 'port' | 'standalone';
  confidence: number;
  reason: string;
  isMainGame: boolean;
  priority: number;
  searchStrategies: string[];
}

export interface ClassificationContext {
  rawgName: string;
  parentsCount: number;
  additionsCount: number;
  hasStoreLink: boolean;
  nameAnalysis: GameNameAnalysis;
  steamType?: string;
  dlcList?: any[];
  hasFullgameInfo?: boolean;
}

export interface DlcCheckResult {
  isDlc: boolean;
  matchedDlc?: {
    steam_id: number;
    name: string;
    similarity: number;
  };
  reason: string;
}

// === 상수 정의 ===

const GAME_KEYWORDS = {
  DLC: [
    'dlc', 'expansion', 'add-on', 'addon', 'content pack', 'season pass',
    'episode', 'chapter', 'downloadable content', 'extra content'
  ] as readonly string[],

  EDITION: [
    'edition', 'remaster', 'remastered', 'enhanced', 'definitive',
    'complete', 'goty', 'game of the year', 'ultimate', 'deluxe',
    'premium', 'special', 'collector', 'director\'s cut'
  ] as readonly string[],

  PORT: [
    'pc port', 'steam version', 'windows edition', 'desktop',
    'hd collection', 'trilogy'
  ] as readonly string[]
};

const GAME_TYPES = {
  MAIN_GAME: 'main_game',
  DLC: 'dlc',
  EDITION: 'edition',
  PORT: 'port',
  STANDALONE: 'standalone'
} as const;

const CONFIDENCE_THRESHOLDS = {
  SIMILARITY: 0.7,
  HIGH_CONFIDENCE: 0.9,
  MEDIUM_CONFIDENCE: 0.7,
  LOW_CONFIDENCE: 0.5
} as const;

const PERFORMANCE_LIMITS = {
  DLC_CHECK_MAX_COUNT: 50,
  SIMILARITY_CALCULATION_LIMIT: 100,
  SEARCH_STRATEGIES_LIMIT: 5
} as const;

// === 분류 결과 빌더 ===

class ClassificationResultBuilder {
  private gameType: string = 'standalone';
  private confidence: number = 0.7;
  private reason: string = '';
  private isMainGame: boolean = true;
  private priority: number = 88;
  private searchStrategies: string[] = [];

  static rawgMainGame(additionsCount: number, context: ClassificationContext): GameClassificationResult {
    return new ClassificationResultBuilder()
      .setGameType(GAME_TYPES.MAIN_GAME)
      .setConfidence(0.95)
      .setReason(`RAWG 본편 게임 (${additionsCount}개 추가 콘텐츠 보유)`)
      .setMainGame(true)
      .setPriority(100)
      .setSimpleSearchStrategies(context)
      .build();
  }

  static rawgDlc(parentCount: number, context: ClassificationContext): GameClassificationResult {
    return new ClassificationResultBuilder()
      .setGameType(GAME_TYPES.DLC)
      .setConfidence(0.98)
      .setReason(`DLC (${parentCount}개 부모 게임 존재)`)
      .setMainGame(false)
      .setPriority(50)
      .setComplexSearchStrategies(context)
      .build();
  }

  static steamOfficialDlc(hasFullgameInfo: boolean, context: ClassificationContext): GameClassificationResult {
    return new ClassificationResultBuilder()
      .setGameType(GAME_TYPES.DLC)
      .setConfidence(0.95)
      .setReason(`Steam 공식 DLC 타입${hasFullgameInfo ? ' (본편 정보 포함)' : ''}`)
      .setMainGame(false)
      .setPriority(60)
      .setComplexSearchStrategies(context)
      .build();
  }

  static steamMainGame(dlcCount: number, context: ClassificationContext): GameClassificationResult {
    return new ClassificationResultBuilder()
      .setGameType(GAME_TYPES.MAIN_GAME)
      .setConfidence(0.95)
      .setReason(`RAWG+Steam 일치: 본편 게임 (부모 게임 없음, 추가 콘텐츠 없음, Steam 'game' 타입, ${dlcCount}개 DLC 보유)`)
      .setMainGame(true)
      .setPriority(95)
      .setSimpleSearchStrategies(context)
      .build();
  }

  static patternDlc(subtitle: string | undefined, context: ClassificationContext): GameClassificationResult {
    return new ClassificationResultBuilder()
      .setGameType(GAME_TYPES.DLC)
      .setConfidence(0.7)
      .setReason(`게임명 DLC 패턴: ${subtitle || 'DLC 키워드 포함'}`)
      .setMainGame(false)
      .setPriority(55)
      .setComplexSearchStrategies(context)
      .build();
  }

  static standaloneDefault(context: ClassificationContext): GameClassificationResult {
    return new ClassificationResultBuilder()
      .setGameType(GAME_TYPES.STANDALONE)
      .setConfidence(0.85)
      .setReason('단독 본편 게임 (추가 콘텐츠/부모 게임/특수 패턴 없음)')
      .setMainGame(true)
      .setPriority(88)
      .setSimpleSearchStrategies(context)
      .build();
  }

  private setGameType(gameType: string): this {
    this.gameType = gameType;
    return this;
  }

  private setConfidence(confidence: number): this {
    this.confidence = confidence;
    return this;
  }

  private setReason(reason: string): this {
    this.reason = reason;
    return this;
  }

  private setMainGame(isMainGame: boolean): this {
    this.isMainGame = isMainGame;
    return this;
  }

  private setPriority(priority: number): this {
    this.priority = priority;
    return this;
  }

  private setSimpleSearchStrategies(context: ClassificationContext): this {
    this.searchStrategies = [context.rawgName];
    return this;
  }

  private setComplexSearchStrategies(context: ClassificationContext): this {
    this.searchStrategies = GameAnalysisService.generateSearchStrategies(context);
    return this;
  }

  private build(): GameClassificationResult {
    return {
      gameType: this.gameType as any,
      confidence: this.confidence,
      reason: this.reason,
      isMainGame: this.isMainGame,
      priority: this.priority,
      searchStrategies: this.searchStrategies
    };
  }
}

// === DLC 체크 결과 빌더 ===

class DlcCheckResultBuilder {
  static noDlcList(): DlcCheckResult {
    return {
      isDlc: false,
      reason: 'DLC 목록 없음',
    };
  }

  static tooManyDlcs(dlcCount: number): DlcCheckResult {
    return {
      isDlc: false,
      reason: `DLC 목록이 너무 많음 (${dlcCount}개)`,
    };
  }

  static matchFound(steamId: number, name: string, similarity: number): DlcCheckResult {
    return {
      isDlc: true,
      matchedDlc: {
        steam_id: steamId,
        name: name,
        similarity: similarity,
      },
      reason: `DLC 목록에서 발견: "${name}" (유사도: ${(similarity * 100).toFixed(1)}%)`,
    };
  }

  static noMatchFound(dlcCount: number): DlcCheckResult {
    return {
      isDlc: false,
      reason: `DLC 목록 ${dlcCount}개 중 일치하는 게임 없음`,
    };
  }

  static searchError(originalGameName: string, errorMessage: string): DlcCheckResult {
    return {
      isDlc: false,
      reason: `DLC 역검색 오류: ${errorMessage}`,
    };
  }
}

// === 메인 게임 분석 서비스 ===

export class GameAnalysisService {
  private static readonly logger = new Logger(GameAnalysisService.name);

  /**
   * 게임명 패턴 분석
   */
  static analyzeGameName(gameName: string): GameNameAnalysis {
    const originalName = gameName.trim();

    // DLC 패턴 체크
    const isDlc = this.hasKeywords(originalName, GAME_KEYWORDS.DLC);
    const isEdition = this.hasKeywords(originalName, GAME_KEYWORDS.EDITION);
    const isPort = this.hasKeywords(originalName, GAME_KEYWORDS.PORT);

    // 부제목 추출
    const colonIndex = originalName.indexOf(':');
    const dashIndex = originalName.indexOf(' - ');
    let baseName = originalName;
    let subtitle: string | undefined = undefined;

    if (colonIndex > 0) {
      baseName = originalName.substring(0, colonIndex).trim();
      subtitle = originalName.substring(colonIndex + 1).trim();
    } else if (dashIndex > 0) {
      baseName = originalName.substring(0, dashIndex).trim();
      subtitle = originalName.substring(dashIndex + 3).trim();
    }

    // 정리된 이름 생성
    let cleanedName = originalName;
    if (isDlc && subtitle) {
      cleanedName = baseName;
    }

    // 감지된 키워드들
    const detectedKeywords: string[] = [];
    if (isDlc) detectedKeywords.push(...GAME_KEYWORDS.DLC.filter(kw => originalName.toLowerCase().includes(kw)));
    if (isEdition) detectedKeywords.push(...GAME_KEYWORDS.EDITION.filter(kw => originalName.toLowerCase().includes(kw)));
    if (isPort) detectedKeywords.push(...GAME_KEYWORDS.PORT.filter(kw => originalName.toLowerCase().includes(kw)));

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

  /**
   * 게임 분류
   */
  static classifyGame(context: ClassificationContext): GameClassificationResult {
    const { rawgName, parentsCount, additionsCount, hasStoreLink, nameAnalysis, steamType, dlcList, hasFullgameInfo } = context;

    // RAWG 데이터 기반 분류 (최고 우선순위)
    if (parentsCount > 0 && nameAnalysis.patterns.isDlc) {
      return ClassificationResultBuilder.rawgDlc(parentsCount, context);
    }

    if (parentsCount === 0 && additionsCount > 0 && hasStoreLink) {
      return ClassificationResultBuilder.rawgMainGame(additionsCount, context);
    }

    // Steam 데이터 기반 분류
    if (steamType === 'dlc') {
      return ClassificationResultBuilder.steamOfficialDlc(!!hasFullgameInfo, context);
    }

    if (steamType === 'game' && parentsCount === 0 && additionsCount === 0) {
      const dlcCount = dlcList?.length || 0;
      return ClassificationResultBuilder.steamMainGame(dlcCount, context);
    }

    // 패턴 기반 분류
    if (nameAnalysis.patterns.isDlc) {
      return ClassificationResultBuilder.patternDlc(nameAnalysis.extractedInfo.subtitle, context);
    }

    // 기본 분류
    return ClassificationResultBuilder.standaloneDefault(context);
  }

  /**
   * 검색 전략 생성
   */
  static generateSearchStrategies(context: ClassificationContext): string[] {
    const strategies: string[] = [];
    const { rawgName, nameAnalysis } = context;

    strategies.push(rawgName);

    if (nameAnalysis.patterns.isDlc || nameAnalysis.patterns.isEdition || nameAnalysis.patterns.isPort) {
      if (nameAnalysis.cleanedName && nameAnalysis.cleanedName !== rawgName) {
        strategies.push(nameAnalysis.cleanedName);
      }

      if (nameAnalysis.extractedInfo.baseName && nameAnalysis.extractedInfo.baseName !== rawgName) {
        strategies.push(nameAnalysis.extractedInfo.baseName);
      }
    }

    return [...new Set(strategies)].filter(s => s && s.length >= 3).slice(0, PERFORMANCE_LIMITS.SEARCH_STRATEGIES_LIMIT);
  }

  /**
   * DLC 역검색
   */
  static async checkIfGameIsDlcInList(dlcList: any[], targetGameName: string): Promise<DlcCheckResult> {
    if (!dlcList || dlcList.length === 0) {
      return DlcCheckResultBuilder.noDlcList();
    }

    if (dlcList.length > PERFORMANCE_LIMITS.DLC_CHECK_MAX_COUNT) {
      return DlcCheckResultBuilder.tooManyDlcs(dlcList.length);
    }

    try {
      let bestMatch: { steamId: number; name: string; similarity: number } | null = null;

      for (const dlcItem of dlcList.slice(0, PERFORMANCE_LIMITS.SIMILARITY_CALCULATION_LIMIT)) {
        const similarity = this.calculateSimilarity(targetGameName, dlcItem.name);

        if (similarity >= CONFIDENCE_THRESHOLDS.SIMILARITY) {
          if (!bestMatch || similarity > bestMatch.similarity) {
            bestMatch = {
              steamId: dlcItem.steam_id || dlcItem.appid,
              name: dlcItem.name,
              similarity
            };
          }
        }
      }

      if (bestMatch) {
        return DlcCheckResultBuilder.matchFound(bestMatch.steamId, bestMatch.name, bestMatch.similarity);
      }

      return DlcCheckResultBuilder.noMatchFound(dlcList.length);

    } catch (error) {
      return DlcCheckResultBuilder.searchError(targetGameName, error?.message || String(error));
    }
  }

  /**
   * 유사도 계산
   */
  private static calculateSimilarity(str1: string, str2: string): number {
    const normalize = (str: string) => str.toLowerCase().replace(/[^a-z0-9]/g, '');
    const a = normalize(str1);
    const b = normalize(str2);

    if (a === b) return 1.0;
    if (a.includes(b) || b.includes(a)) return 0.8;

    const len = Math.max(a.length, b.length);
    if (len === 0) return 1.0;

    const distance = this.levenshteinDistance(a, b);
    return Math.max(0, (len - distance) / len);
  }

  /**
   * 레벤슈타인 거리 계산
   */
  private static levenshteinDistance(str1: string, str2: string): number {
    const matrix = Array(str2.length + 1).fill(null).map(() => Array(str1.length + 1).fill(null));

    for (let i = 0; i <= str1.length; i++) matrix[0][i] = i;
    for (let j = 0; j <= str2.length; j++) matrix[j][0] = j;

    for (let j = 1; j <= str2.length; j++) {
      for (let i = 1; i <= str1.length; i++) {
        const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
        matrix[j][i] = Math.min(
          matrix[j][i - 1] + 1,
          matrix[j - 1][i] + 1,
          matrix[j - 1][i - 1] + indicator,
        );
      }
    }

    return matrix[str2.length][str1.length];
  }

  /**
   * 키워드 포함 여부 체크
   */
  private static hasKeywords(text: string, keywords: readonly string[]): boolean {
    const lowerText = text.toLowerCase();
    return keywords.some(keyword => lowerText.includes(keyword.toLowerCase()));
  }
}