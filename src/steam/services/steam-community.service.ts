import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import puppeteer, { Browser } from 'puppeteer';

/**
 * Steam Community 서비스
 * FINAL-ARCHITECTURE-DESIGN Phase 1 구현
 *
 * 역할: Steam 커뮤니티 페이지 스크레이핑을 통한 팔로워 수 수집
 * 특징: 인기도 계산의 핵심 지표, Circuit Breaker 패턴 적용
 */
@Injectable()
export class SteamCommunityService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SteamCommunityService.name);
  private readonly baseUrl = 'https://steamcommunity.com';
  private browser: Browser | null = null;

  // Circuit Breaker 상태 (IP 밴 방지)
  private failureCount = 0;
  private lastFailureTime: Date | null = null;
  private readonly FAILURE_THRESHOLD = 3; // 3회 연속 실패 시 차단 (기존 5회에서 강화)
  private readonly CIRCUIT_TIMEOUT = 600000; // 10분 (기존 5분에서 연장, IP 밴 회복 시간)

  constructor(
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit() {
    this.logger.log('🚀 Puppeteer 브라우저 시작');
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    this.browser = await puppeteer.launch({
      headless: true,
      executablePath: executablePath || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
      ],
    });
  }

  async onModuleDestroy() {
    if (this.browser) {
      this.logger.log('🛑 Puppeteer 브라우저 종료');
      await this.browser.close();
      this.browser = null;
    }
  }

  /**
   * Steam 게임의 팔로워 수 스크레이핑
   * URL: https://steamcommunity.com/app/{appid}
   *
   * @param appId Steam AppID
   * @param gameName 게임 이름 (로깅용)
   * @returns 팔로워 수 (실패시 null)
   */
  async scrapeFollowers(appId: number, gameName: string): Promise<number | null> {
    // Circuit Breaker 체크
    if (this.isCircuitOpen()) {
      this.logger.warn(`🔌 Circuit Breaker OPEN - 팔로워 스크레이핑 건너뜀: ${gameName}`);
      return null;
    }

    try {
      const followers = await this.scrapeFollowersInternal(appId, gameName);
      this.onSuccess(); // Circuit Breaker 성공 처리
      return followers;

    } catch (error) {
      // 429 에러 (Rate Limit) 특별 처리
      if (error.response?.status === 429) {
        this.logger.error(`🚨 Rate Limit 초과 (429) - IP 밴 위험! ${gameName} (${appId})`);
        this.failureCount += 2; // 429 에러는 2배로 카운트 (더 엄격하게)
      } else {
        this.onFailure(); // Circuit Breaker 실패 처리
      }

      this.logger.error(`❌ 팔로워 스크레이핑 실패 - ${gameName} (${appId}): ${error.message}`);
      return null;
    }
  }

  /**
   * 내부 팔로워 스크레이핑 로직
   * ✅ Puppeteer 사용: JavaScript 동적 렌더링 지원
   * ✅ 그룹 검색 방식: /search/groups/?text={gameName}
   * - 첫 페이지 모든 카드를 순회하며 /app/{appId} 링크가 있는 첫 번째 카드에서 팔로워 파싱
   */
  private async scrapeFollowersInternal(appId: number, gameName: string): Promise<number | null> {
    if (!this.browser) {
      throw new Error('Puppeteer 브라우저가 초기화되지 않았습니다.');
    }

    const startTime = Date.now();

    // 요청 간격 조절
    const delayMs = this.getRandomDelay();
    this.logger.debug(`    ⏳ Rate Limit 지연: ${delayMs.toFixed(0)}ms`);
    await this.delay(delayMs);

    const searchUrl = `${this.baseUrl}/search/groups/?text=${encodeURIComponent(gameName)}`;
    this.logger.debug(`    🌐 Puppeteer 페이지 열기: ${searchUrl}`);

    const page = await this.browser.newPage();

    try {
      // User-Agent 설정
      await page.setUserAgent(this.getUserAgent());

      const requestStart = Date.now();

      // 페이지 로딩 (networkidle2: 네트워크 요청 완료 대기)
      await page.goto(searchUrl, {
        waitUntil: 'networkidle2',
        timeout: 60000
      });

      // ✅ 동적 로딩 대기 (JavaScript 실행 완료)
      await this.delay(1200);

      const requestDuration = Date.now() - requestStart;
      this.logger.debug(`    ⏱️  페이지 로딩: ${(requestDuration / 1000).toFixed(2)}초`);

      // ✅ JavaScript 실행 후 DOM 쿼리
      type EvalOut = {
        totalCards: number;
        matchedCount: number;
        firstMembers: number | null;
      };

      const out: EvalOut = await page.evaluate((id) => {
        const cards = Array.from(document.querySelectorAll<HTMLDivElement>('.search_row.group'));
        let matchedCount = 0;
        let firstMembers: number | null = null;

        for (const card of cards) {
          const hasAppLink = !!card.querySelector<HTMLAnchorElement>(`a[href*="/app/${id}"]`);
          if (!hasAppLink) continue;

          matchedCount++;

          // 팔로워 수 파싱 (다국어)
          const text = card.innerText || '';
          const m = text.match(/([\d\.,\s]+)\s*(명|members|member|membres|mitglieder|miembros|чел\.|成员|멤버)/i);
          const num = m ? (m[1] || '').replace(/[^\d]/g, '') : '';
          const members = num ? parseInt(num, 10) : null;

          // 첫 매칭 카드만 채택
          if (firstMembers === null) {
            firstMembers = members;
            break;
          }
        }

        return { totalCards: cards.length, matchedCount, firstMembers };
      }, appId);

      this.logger.debug(
        `🔍 [그룹 검색] ${gameName} (AppID: ${appId}) - 총 ${out.totalCards}개 카드, /app/${appId} 매칭 ${out.matchedCount}개`
      );

      if (out.firstMembers == null) {
        this.logger.warn(`⚠️ [그룹 검색] ${gameName} - /app/${appId} 링크가 있는 카드를 찾을 수 없음`);
        return null;
      }

      this.logger.log(`👥 팔로워 파싱 성공: ${gameName} = ${out.firstMembers.toLocaleString()}명`);
      return out.firstMembers;

    } catch (error) {
      this.logger.error(`    ❌ Puppeteer 스크레이핑 실패: ${error.message}`);
      throw error;
    } finally {
      await page.close();
    }
  }

  /**
   * Circuit Breaker 상태 확인
   */
  private isCircuitOpen(): boolean {
    if (this.failureCount >= this.FAILURE_THRESHOLD) {
      if (this.lastFailureTime) {
        const timeSinceFailure = Date.now() - this.lastFailureTime.getTime();
        return timeSinceFailure < this.CIRCUIT_TIMEOUT;
      }
    }
    return false;
  }

  /**
   * Circuit Breaker 성공 처리
   */
  private onSuccess(): void {
    this.failureCount = 0;
    this.lastFailureTime = null;
  }

  /**
   * Circuit Breaker 실패 처리
   */
  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = new Date();

    if (this.failureCount >= this.FAILURE_THRESHOLD) {
      this.logger.warn(`🔌 Steam Community Circuit Breaker OPEN (${this.failureCount}회 연속 실패)`);
    }
  }

  /**
   * User-Agent 로테이션
   */
  private getUserAgent(): string {
    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ];

    const configuredAgent = this.configService.get<string>('STEAM_USER_AGENT');
    if (configuredAgent) {
      return configuredAgent;
    }

    return userAgents[Math.floor(Math.random() * userAgents.length)];
  }

  /**
   * 랜덤 지연 시간 생성 (1-2초)
   * Steam Community 스크래이핑 안전 기준:
   * - 초당 1-2 요청 (비공식 API, 엄격)
   * - 너무 빠르면 IP 밴 위험
   * - 안전 마진: 1-2초 랜덤 (초당 0.5-1 요청)
   */
  private getRandomDelay(): number {
    const baseDelay = parseInt(this.configService.get<string>('STEAM_COMMUNITY_DELAY') || '1000', 10);
    const randomFactor = Math.random() * 1000; // 0-1초 추가 (패턴 탐지 방지)
    return baseDelay + randomFactor;
  }

  /**
   * 지연 함수
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

}