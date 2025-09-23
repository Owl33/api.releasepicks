/**
 * 🎯 통합 게임 분석 서비스
 * 게임명 분석, 분류, 매칭 전략, DLC 역검색을 모두 통합 관리
 *
 * 기존 분산된 로직들을 하나로 통합:
 * - GameNameUtils (게임명 분석)
 * - GameClassificationService (게임 분류)
 * - SteamService의 DLC 관련 로직들
 * - UnifiedGameService의 게임 관련 유틸리티들
 */

import axios from 'axios';
import { Logger } from '@nestjs/common';

// === 인터페이스 정의 ===

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
  priority: number; // 매칭 우선순위 (높을수록 우선)
  searchStrategies: string[]; // Steam 검색에 사용할 이름들
}

export interface ClassificationContext {
  // RAWG 데이터
  rawgName: string;
  parentsCount: number;
  additionsCount: number;

  // Steam 데이터 (있는 경우)
  steamType?: string;
  dlcList?: number[];
  hasFullgameInfo?: boolean;

  // Store Links
  hasStoreLink: boolean;

  // 게임명 분석
  nameAnalysis: GameNameAnalysis;
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

// Steam API 타입 정의 (필요한 부분만)
interface SteamAppDetailsResponse {
  [app_id: string]: {
    success: boolean;
    data?: {
      name: string;
    };
  };
}

// === 메인 서비스 클래스 ===

export class GameAnalysisService {

  // 🎯 Logger 및 상수 정의
  private static readonly logger = new Logger(GameAnalysisService.name);
  private static readonly STEAM_APPDETAILS_URL = 'https://store.steampowered.com/api/appdetails';

  // 🎯 통합 키워드 정의
  private static readonly KEYWORDS = {
    DLC: ['dlc', 'expansion', 'season pass', 'episode', 'pack', 'content pack', 'add-on', 'downloadable content'],
    EDITION: [
      'remaster', 'remastered', 'definitive edition', 'complete edition',
      'director\'s cut', 'anniversary edition', 'ultimate edition',
      'deluxe edition', 'goty', 'game of the year', 'enhanced edition',
      'gold edition', 'premium edition', 'special edition', 'collector\'s edition',
      'legendary edition', 'royal edition', 'platinum edition'
    ],
    PORT: ['pc port', 'pc version', 'steam edition', 'console edition']
  };

  // === 🎮 게임명 분석 메서드들 ===

  /**
   * 🎯 게임명 종합 분석
   */
  static analyzeGameName(gameName: string): GameNameAnalysis {
    if (!gameName) {
      return this.createEmptyAnalysis(gameName);
    }

    const lowerName = gameName.toLowerCase().trim();
    const patterns = this.detectPatterns(gameName);
    const extractedInfo = this.extractNameComponents(gameName, lowerName);

    return {
      originalName: gameName,
      cleanedName: this.cleanForSteamSearch(gameName),
      patterns,
      extractedInfo
    };
  }

  /**
   * 🔧 Steam 검색용 게임명 정리
   */
  static cleanForSteamSearch(gameName: string): string {
    if (!gameName) return '';

    let cleaned = gameName.trim();

    // 1. 명시적 DLC 키워드 제거 (공통 유틸리티 사용)
    const { beforeColon, afterColon } = this.splitGameNameByColon(cleaned);
    if (afterColon && beforeColon.length >= 3) {
      const hasExplicitDlcKeyword = this.KEYWORDS.DLC.some(keyword =>
        afterColon.toLowerCase().includes(keyword.toLowerCase())
      );

      if (hasExplicitDlcKeyword) {
        cleaned = beforeColon;
      }
    }

    // 2. 에디션/포트 키워드 제거
    const allKeywords = [
      ...this.KEYWORDS.EDITION,
      ...this.KEYWORDS.PORT
    ];

    for (const keyword of allKeywords) {
      const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
      cleaned = cleaned.replace(regex, '').trim();
    }

    // 3. 연속된 공백 정리
    cleaned = cleaned.replace(/\s+/g, ' ').trim();

    // 4. 너무 짧아지면 원본 반환
    if (!cleaned || cleaned.length < 3) {
      return gameName.trim();
    }

    return cleaned;
  }

  // === 🎯 게임 분류 메서드들 ===

  /**
   * 🥇 메인 분류 메서드 - 모든 컨텍스트를 종합하여 최종 게임 타입 결정
   */
  static classifyGame(context: ClassificationContext): GameClassificationResult {
    // 🥇 RAWG parents_count > 0 → 가장 신뢰할 만한 DLC/Edition/Port 지표
    if (context.parentsCount > 0) {
      return this.classifyByParentCount(context);
    }

    // 🥈 RAWG additions_count > 0 → 본편 게임 확실
    if (context.additionsCount > 0) {
      return {
        gameType: 'main_game',
        confidence: 0.95,
        reason: `RAWG 본편 게임 (${context.additionsCount}개 추가 콘텐츠 보유)`,
        isMainGame: true,
        priority: 100,
        searchStrategies: this.getSearchStrategies(context, true) // 확실한 본편 - 단순 전략
      };
    }

    // 🥉 Steam 데이터 기반 분류 (있는 경우)
    if (context.steamType) {
      return this.classifyBySteamData(context);
    }

    // 🏅 게임명 패턴 기반 분류 (마지막 수단)
    return this.classifyByNamePattern(context);
  }

  /**
   * 🔧 검색 전략 헬퍼 (최적화)
   * @param context 분류 컨텍스트
   * @param useSimpleStrategy 단순 전략 사용 여부 (확실한 본편 게임용)
   */
  private static getSearchStrategies(context: ClassificationContext, useSimpleStrategy: boolean = false): string[] {
    return useSimpleStrategy ? [context.rawgName] : this.generateSearchStrategies(context);
  }

  /**
   * 🎯 Steam 검색 전략 생성
   */
  static generateSearchStrategies(context: ClassificationContext): string[] {
    const strategies: string[] = [];
    const { rawgName, nameAnalysis } = context;

    // 1. 원본명 (기본)
    strategies.push(rawgName);

    // 2. 정리된 이름 (DLC/Edition일 가능성이 있는 경우)
    if (nameAnalysis.patterns.isDlc || nameAnalysis.patterns.isEdition || nameAnalysis.patterns.isPort) {
      if (nameAnalysis.cleanedName && nameAnalysis.cleanedName !== rawgName) {
        strategies.push(nameAnalysis.cleanedName);
      }

      // 3. 베이스명 (부제목 제거)
      if (nameAnalysis.extractedInfo.baseName && nameAnalysis.extractedInfo.baseName !== rawgName) {
        strategies.push(nameAnalysis.extractedInfo.baseName);
      }
    }

    // 4. PC Port 특별 처리
    if (nameAnalysis.patterns.isPort) {
      const withoutPort = rawgName.replace(/\s*pc\s*port\s*/gi, '').trim();
      if (withoutPort && withoutPort !== rawgName && withoutPort.length >= 3) {
        strategies.unshift(withoutPort); // 앞에 추가 (우선순위 높음)
      }
    }

    // 5. Edition 특별 처리
    if (nameAnalysis.patterns.isEdition) {
      const editionPatterns = [
        /\s*-\s*game\s+of\s+the\s+year\s+edition$/gi,
        /\s*-\s*goty$/gi,
        /\s*-\s*complete\s+edition$/gi,
        /\s*-\s*definitive\s+edition$/gi,
        /\s*-\s*director'?s\s+cut$/gi,
        /\s*director'?s\s+cut$/gi,
        /\s*ultimate\s+edition$/gi,
        /\s*deluxe\s+edition$/gi,
        /\s*gold\s+edition$/gi,
        /\s*premium\s+edition$/gi,
        /\s*special\s+edition$/gi,
        /\s*enhanced\s+edition$/gi,
        /\s*royal\s+edition$/gi,
        /\s*legendary\s+edition$/gi
      ];

      let withoutEdition = rawgName;
      for (const pattern of editionPatterns) {
        const cleaned = withoutEdition.replace(pattern, '').trim();
        if (cleaned && cleaned !== withoutEdition && cleaned.length >= 3) {
          withoutEdition = cleaned;
          break; // 첫 번째 매칭만 적용
        }
      }

      if (withoutEdition !== rawgName) {
        strategies.unshift(withoutEdition); // 우선순위 높음
      }
    }

    // 중복 제거 및 빈 문자열 필터링
    return [...new Set(strategies)].filter(s => s && s.length >= 3);
  }

  // === Private 분류 메서드들 ===

  private static classifyByParentCount(context: ClassificationContext): GameClassificationResult {
    const { nameAnalysis, parentsCount } = context;

    // PC Port 우선 검사
    if (nameAnalysis.patterns.isPort) {
      return {
        gameType: 'port',
        confidence: 0.95,
        reason: `PC Port (${parentsCount}개 부모 게임 + Port 패턴)`,
        isMainGame: true, // Port는 보통 본편으로 취급
        priority: 90,
        searchStrategies: this.getSearchStrategies(context) // 복잡한 게임 - 다중 전략
      };
    }

    // Edition 검사
    if (nameAnalysis.patterns.isEdition) {
      return {
        gameType: 'edition',
        confidence: 0.93,
        reason: `Edition (${parentsCount}개 부모 게임 + Edition 패턴)`,
        isMainGame: true, // Edition은 본편으로 취급
        priority: 85,
        searchStrategies: this.getSearchStrategies(context) // 복잡한 게임 - 다중 전략
      };
    }

    // DLC (기본값)
    return {
      gameType: 'dlc',
      confidence: 0.98,
      reason: `DLC (${parentsCount}개 부모 게임 존재)`,
      isMainGame: false,
      priority: 50,
      searchStrategies: this.generateSearchStrategies(context)
    };
  }

  private static classifyBySteamData(context: ClassificationContext): GameClassificationResult {
    const { steamType, dlcList = [], hasFullgameInfo, nameAnalysis, parentsCount, additionsCount } = context;

    // Steam 공식 DLC 타입
    if (steamType === 'dlc') {
      return {
        gameType: 'dlc',
        confidence: 0.95,
        reason: `Steam 공식 DLC 타입${hasFullgameInfo ? ' (본편 정보 포함)' : ''}`,
        isMainGame: false,
        priority: 60,
        searchStrategies: this.getSearchStrategies(context) // 복잡한 게임 - 다중 전략
      };
    }

    // Steam game 타입이지만 DLC 목록이 있는 경우
    if (steamType === 'game' && dlcList.length > 0) {
      // 🎯 최적화: RAWG 데이터가 명확하면 역검색 생략
      if (parentsCount === 0 && additionsCount === 0) {
        return {
          gameType: 'main_game',
          confidence: 0.95,
          reason: `RAWG+Steam 일치: 본편 게임 (부모 게임 없음, 추가 콘텐츠 없음, Steam 'game' 타입, ${dlcList.length}개 DLC 보유)`,
          isMainGame: true,
          priority: 95,
          searchStrategies: this.getSearchStrategies(context, true) // 확실한 본편 - 단순 전략 // 원본명만 사용
        };
      }

      // RAWG 데이터가 불분명한 경우는 별도 처리 필요 (DLC 역검색)
      return {
        gameType: 'main_game', // 임시, 역검색 후 결정
        confidence: 0.75,
        reason: `Steam 본편 후보 (${dlcList.length}개 DLC 보유, RAWG 데이터 불분명 - 역검색 필요)`,
        isMainGame: true,
        priority: 80,
        searchStrategies: this.getSearchStrategies(context) // 복잡한 게임 - 다중 전략
      };
    }

    // Steam game 타입, DLC 목록 없음
    if (steamType === 'game') {
      // 게임명 패턴으로 추가 검증
      if (nameAnalysis.patterns.isDlc) {
        return {
          gameType: 'dlc',
          confidence: 0.75,
          reason: `Steam game 타입이지만 게임명이 DLC 패턴: ${nameAnalysis.extractedInfo.subtitle || 'DLC 키워드 포함'}`,
          isMainGame: false,
          priority: 65,
          searchStrategies: this.getSearchStrategies(context) // 복잡한 게임 - 다중 전략
        };
      }

      if (nameAnalysis.patterns.isEdition) {
        return {
          gameType: 'edition',
          confidence: 0.82,
          reason: `Steam 에디션 게임: ${nameAnalysis.extractedInfo.detectedKeywords.join(', ')}`,
          isMainGame: true,
          priority: 85,
          searchStrategies: this.getSearchStrategies(context) // 복잡한 게임 - 다중 전략
        };
      }

      return {
        gameType: 'standalone',
        confidence: 0.85,
        reason: 'Steam 단독 게임 (DLC 없음)',
        isMainGame: true,
        priority: 90,
        searchStrategies: this.getSearchStrategies(context, true) // 확실한 본편 - 단순 전략
      };
    }

    // 기타 Steam 타입들
    return {
      gameType: 'standalone',
      confidence: 0.70,
      reason: `Steam ${steamType} 타입`,
      isMainGame: steamType !== 'dlc',
      priority: 70,
      searchStrategies: this.generateSearchStrategies(context)
    };
  }

  private static classifyByNamePattern(context: ClassificationContext): GameClassificationResult {
    const { nameAnalysis } = context;

    if (nameAnalysis.patterns.isDlc) {
      return {
        gameType: 'dlc',
        confidence: 0.70,
        reason: `게임명 DLC 패턴: ${nameAnalysis.extractedInfo.subtitle || 'DLC 키워드 포함'}`,
        isMainGame: false,
        priority: 55,
        searchStrategies: this.getSearchStrategies(context) // 복잡한 게임 - 다중 전략
      };
    }

    if (nameAnalysis.patterns.isEdition) {
      return {
        gameType: 'edition',
        confidence: 0.80,
        reason: `게임명 에디션 패턴: ${nameAnalysis.extractedInfo.detectedKeywords.join(', ')}`,
        isMainGame: true,
        priority: 85,
        searchStrategies: this.getSearchStrategies(context) // 복잡한 게임 - 다중 전략
      };
    }

    if (nameAnalysis.patterns.isPort) {
      return {
        gameType: 'port',
        confidence: 0.85,
        reason: `게임명 포트 패턴: ${nameAnalysis.extractedInfo.detectedKeywords.join(', ')}`,
        isMainGame: true,
        priority: 90,
        searchStrategies: this.getSearchStrategies(context) // 복잡한 게임 - 다중 전략
      };
    }

    // 기본값: 단독 본편
    return {
      gameType: 'standalone',
      confidence: 0.85,
      reason: '단독 본편 게임 (추가 콘텐츠/부모 게임/특수 패턴 없음)',
      isMainGame: true,
      priority: 88,
      searchStrategies: [context.rawgName]
    };
  }

  // === Private 유틸리티 메서드들 ===

  private static detectPatterns(gameName: string) {
    return {
      isDlc: this.hasKeywords(gameName, this.KEYWORDS.DLC),
      isEdition: this.hasKeywords(gameName, this.KEYWORDS.EDITION),
      isPort: this.hasKeywords(gameName, this.KEYWORDS.PORT),
      hasSubtitle: gameName.includes(': ')
    };
  }

  private static hasKeywords(gameName: string, keywords: string[]): boolean {
    const lowerName = gameName.toLowerCase();
    return keywords.some(keyword => lowerName.includes(keyword));
  }

  /**
   * 🔧 콜론 기반 게임명 분리 (공통 유틸리티)
   */
  private static splitGameNameByColon(gameName: string): { beforeColon: string; afterColon?: string } {
    if (!gameName.includes(': ')) {
      return { beforeColon: gameName };
    }

    const parts = gameName.split(': ');
    const beforeColon = parts[0].trim();
    const afterColon = parts[1]?.trim();

    return { beforeColon, afterColon };
  }

  private static extractNameComponents(originalName: string, lowerName: string) {
    const detectedKeywords: string[] = [];

    // 키워드 수집
    [...this.KEYWORDS.DLC, ...this.KEYWORDS.EDITION, ...this.KEYWORDS.PORT]
      .forEach(keyword => {
        if (lowerName.includes(keyword)) {
          detectedKeywords.push(keyword);
        }
      });

    // 기본명과 부제목 분리 (공통 유틸리티 사용)
    const { beforeColon, afterColon } = this.splitGameNameByColon(originalName);

    return {
      baseName: beforeColon,
      subtitle: afterColon,
      detectedKeywords
    };
  }

  private static createEmptyAnalysis(gameName: string): GameNameAnalysis {
    return {
      originalName: gameName,
      cleanedName: gameName,
      patterns: {
        isDlc: false,
        isEdition: false,
        isPort: false,
        hasSubtitle: false
      },
      extractedInfo: {
        baseName: gameName,
        detectedKeywords: []
      }
    };
  }

  // === 🔍 DLC 관련 메서드들 (Steam Service에서 이동) ===

  /**
   * 🔍 Steam DLC 역검색: DLC 목록에서 특정 게임명과 일치하는지 확인
   * @param dlcIds DLC Steam ID 배열
   * @param originalGameName 원본 게임명 (RAWG)
   * @returns DLC 일치 결과
   */
  static async checkIfGameIsDlcInList(
    dlcIds: number[],
    originalGameName: string,
  ): Promise<DlcCheckResult> {
    try {
      this.logger.debug(
        `DLC 역검색 시작: ${originalGameName} in [${dlcIds.join(', ')}]`,
      );

      // DLC 목록이 없거나 너무 많으면 건너뛰기
      if (!dlcIds || dlcIds.length === 0) {
        return {
          isDlc: false,
          reason: 'DLC 목록 없음',
        };
      }

      if (dlcIds.length > 20) {
        this.logger.warn(`DLC 목록이 너무 많음 (${dlcIds.length}개), 건너뛰기`);
        return {
          isDlc: false,
          reason: `DLC 목록이 너무 많음 (${dlcIds.length}개)`,
        };
      }

      // 각 DLC의 이름을 조회하여 비교
      for (const dlcId of dlcIds) {
        try {
          const dlcName = await this.getDlcName(dlcId);
          if (!dlcName) continue;

          const similarity = this.calculateNameSimilarity(
            originalGameName,
            dlcName,
          );

          this.logger.debug(
            `DLC 비교: "${originalGameName}" vs "${dlcName}" = ${similarity.toFixed(2)}`,
          );

          // 유사도 80% 이상이면 일치로 판단
          if (similarity >= 0.8) {
            return {
              isDlc: true,
              matchedDlc: {
                steam_id: dlcId,
                name: dlcName,
                similarity,
              },
              reason: `DLC 목록에서 발견: "${dlcName}" (유사도: ${(similarity * 100).toFixed(1)}%)`,
            };
          }
        } catch (error) {
          this.logger.warn(`DLC ${dlcId} 조회 실패:`, error.message);
          continue;
        }
      }

      return {
        isDlc: false,
        reason: `DLC 목록 ${dlcIds.length}개 중 일치하는 게임 없음`,
      };
    } catch (error) {
      this.logger.error(`DLC 역검색 실패: ${originalGameName}`, error.message);
      return {
        isDlc: false,
        reason: `DLC 역검색 오류: ${error.message}`,
      };
    }
  }

  /**
   * 🔍 특정 Steam ID의 게임명만 조회 (경량화)
   */
  private static async getDlcName(steamId: number): Promise<string | null> {
    try {
      const response = await axios.get<SteamAppDetailsResponse>(
        `${this.STEAM_APPDETAILS_URL}?appids=${steamId}&l=korean&cc=KR`,
        {
          timeout: 5000,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
        },
      );

      const appData = response.data[steamId.toString()];

      if (!appData || !appData.success || !appData.data) {
        return null;
      }

      return appData.data.name || null;
    } catch (error) {
      this.logger.warn(`Steam ${steamId} 이름 조회 실패:`, error.message);
      return null;
    }
  }

  /**
   * 🔍 게임명 유사도 계산 (Jaro-Winkler 유사 알고리즘)
   */
  private static calculateNameSimilarity(name1: string, name2: string): number {
    if (!name1 || !name2) return 0;

    const clean1 = name1.toLowerCase().trim();
    const clean2 = name2.toLowerCase().trim();

    // 정확히 일치
    if (clean1 === clean2) return 1.0;

    // 한쪽이 다른 쪽을 포함 (DLC 패턴)
    if (clean1.includes(clean2) || clean2.includes(clean1)) {
      const shorter = clean1.length < clean2.length ? clean1 : clean2;
      const longer = clean1.length >= clean2.length ? clean1 : clean2;
      return shorter.length / longer.length;
    }

    // 단어 기반 유사도 (간단한 Jaccard 유사도)
    const words1 = new Set(clean1.split(/\s+/));
    const words2 = new Set(clean2.split(/\s+/));

    const intersection = new Set([...words1].filter((x) => words2.has(x)));
    const union = new Set([...words1, ...words2]);

    return intersection.size / union.size;
  }
}