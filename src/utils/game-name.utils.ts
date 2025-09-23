/**
 * 🎮 게임명 처리 공통 유틸리티
 * DLC 패턴, 에디션 패턴, Steam 검색용 정리 등을 통합 관리
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

export class GameNameUtils {
  // DLC 관련 키워드들
  private static readonly DLC_KEYWORDS = [
    'dlc', 'expansion', 'season pass', 'episode', 'pack', 'content pack',
    'add-on', 'downloadable content'
  ];

  // 에디션 관련 키워드들
  private static readonly EDITION_KEYWORDS = [
    'remaster', 'remastered', 'definitive edition', 'complete edition',
    'director\'s cut', 'anniversary edition', 'ultimate edition',
    'deluxe edition', 'goty', 'game of the year', 'enhanced edition',
    'gold edition', 'premium edition', 'special edition', 'collector\'s edition',
    'legendary edition', 'royal edition', 'platinum edition'
  ];

  // 포트/플랫폼 관련 키워드들
  private static readonly PORT_KEYWORDS = [
    'pc port', 'pc version', 'steam edition', 'console edition'
  ];

  /**
   * 게임명 종합 분석
   */
  static analyzeGameName(gameName: string): GameNameAnalysis {
    if (!gameName) {
      return this.createEmptyAnalysis(gameName);
    }

    const lowerName = gameName.toLowerCase().trim();
    const patterns = this.detectPatterns(lowerName);
    const extractedInfo = this.extractNameComponents(gameName, lowerName);

    return {
      originalName: gameName,
      cleanedName: this.cleanForSteamSearch(gameName),
      patterns,
      extractedInfo
    };
  }

  /**
   * Steam 검색용 게임명 정리
   * DLC 부제목, 에디션 키워드, 포트 키워드 제거
   */
  static cleanForSteamSearch(gameName: string): string {
    if (!gameName) return '';

    let cleaned = gameName.trim();

    // 1. 명시적 DLC 키워드만 제거 (위험한 30글자 로직 제거)
    // 예: "Game: DLC Pack", "Game: Expansion" 등
    if (cleaned.includes(': ')) {
      const parts = cleaned.split(': ');
      const beforeColon = parts[0].trim();
      const afterColon = parts[1]?.trim().toLowerCase();

      // 명시적 DLC 키워드만 제거 (30글자 로직 완전 제거)
      if (beforeColon.length >= 3 && afterColon) {
        const hasExplicitDlcKeyword = this.DLC_KEYWORDS.some(keyword =>
          afterColon.includes(keyword.toLowerCase())
        );

        if (hasExplicitDlcKeyword) {
          cleaned = beforeColon;
        }
      }
    }

    // 2. 에디션/포트 키워드 제거
    const allKeywords = [
      ...this.EDITION_KEYWORDS,
      ...this.PORT_KEYWORDS,
      'director\'s cut'
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

  /**
   * DLC 패턴 감지 (개선된 로직)
   */
  static isDlcPattern(gameName: string): boolean {
    const lowerName = gameName.toLowerCase();

    // 1. 명확한 DLC 키워드 직접 포함
    if (this.DLC_KEYWORDS.some(keyword => lowerName.includes(keyword))) {
      return true;
    }

    // 2. 콜론 뒤 부제목 패턴 (더 정교한 검사)
    if (lowerName.includes(': ')) {
      const subtitle = lowerName.split(': ')[1];
      if (subtitle && subtitle.length < 30) {
        // 에디션 패턴은 제외
        if (this.EDITION_KEYWORDS.some(keyword => lowerName.includes(keyword))) {
          return false;
        }

        // 속편 패턴 제외 (독립 게임 가능성 높음)
        const sequelPatterns = [
          'silksong', 'part', 'chapter', 'volume', 'ii', 'iii', 'iv', 'v',
          'sequel', 'returns', 'reborn', 'awakens', 'origins'
        ];
        if (sequelPatterns.some(pattern => subtitle.includes(pattern))) {
          return false;
        }

        // 숫자가 포함된 속편 패턴 제외
        if (/\b\d+\b/.test(subtitle)) {
          return false;
        }

        // 일반적인 지역/장소명 제외 (독립 게임 가능성)
        const placePatterns = [
          'earth', 'world', 'land', 'kingdom', 'city', 'island', 'valley'
        ];
        if (placePatterns.some(pattern => subtitle.includes(pattern))) {
          return false;
        }

        // DLC 가능성이 높은 특정 패턴만 true
        const dlcHintPatterns = [
          'instinct', 'liberty', 'awakening', 'rising', 'fallen',
          'nightmare', 'shadow', 'destiny', 'legacy'
        ];
        if (dlcHintPatterns.some(pattern => subtitle.includes(pattern))) {
          return true;
        }

        // 기본적으로는 독립 게임으로 간주
        return false;
      }
    }

    return false;
  }

  /**
   * 에디션 패턴 감지
   */
  static isEditionPattern(gameName: string): boolean {
    const lowerName = gameName.toLowerCase();
    return this.EDITION_KEYWORDS.some(keyword => lowerName.includes(keyword));
  }

  /**
   * 포트 패턴 감지
   */
  static isPortPattern(gameName: string): boolean {
    const lowerName = gameName.toLowerCase();
    return this.PORT_KEYWORDS.some(keyword => lowerName.includes(keyword));
  }

  // === Private Methods ===

  private static detectPatterns(lowerName: string) {
    return {
      isDlc: this.isDlcPattern(lowerName),
      isEdition: this.isEditionPattern(lowerName),
      isPort: this.isPortPattern(lowerName),
      hasSubtitle: lowerName.includes(': ')
    };
  }

  private static extractNameComponents(originalName: string, lowerName: string) {
    const detectedKeywords: string[] = [];

    // 키워드 수집
    [...this.DLC_KEYWORDS, ...this.EDITION_KEYWORDS, ...this.PORT_KEYWORDS]
      .forEach(keyword => {
        if (lowerName.includes(keyword)) {
          detectedKeywords.push(keyword);
        }
      });

    // 기본명과 부제목 분리
    let baseName = originalName;
    let subtitle: string | undefined;

    if (originalName.includes(': ')) {
      const parts = originalName.split(': ');
      baseName = parts[0].trim();
      subtitle = parts[1]?.trim();
    }

    return {
      baseName,
      subtitle,
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
}