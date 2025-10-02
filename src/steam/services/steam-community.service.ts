// src/steam-community/steamcommunity.service.ts
import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import axios from 'axios';
import puppeteer, { Browser, Page } from 'puppeteer';

type App = { appid: number; name: string };
export type SteamFollowersResult = {
  appid: number;
  name: string;
  followers: number;
};

const APP_LIST_URL = 'https://api.steampowered.com/ISteamApps/GetAppList/v2/';

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 간단 토큰 버킷 리미터: burst 허용 후 초당 일정 속도로 회복 (+ 일시 감속 지원) */
class TokenBucket {
  private tokens: number;
  private readonly capacity: number;
  private readonly baseRefillPerSec: number;
  private refillPerSec: number;
  private lastRefill = Date.now();

  // 일시 감속 상태
  private slowUntil = 0;

  constructor(opts: { capacity: number; refillPerSec: number }) {
    this.capacity = opts.capacity;
    this.baseRefillPerSec = opts.refillPerSec;
    this.refillPerSec = opts.refillPerSec;
    this.tokens = opts.capacity;
  }

  /** 429 등에서 호출해 일시적으로 속도를 낮춤 (factor < 1.0 권장) */
  temporarilySlowDown(factor: number, durationMs: number) {
    const now = Date.now();
    this.slowUntil = Math.max(this.slowUntil, now + durationMs);
    this.refillPerSec = Math.max(0.1, this.baseRefillPerSec * factor);
  }

  private maybeRestoreRate() {
    if (this.slowUntil && Date.now() >= this.slowUntil) {
      this.slowUntil = 0;
      this.refillPerSec = this.baseRefillPerSec;
    }
  }

  async take(minDelayMs = 0, jitterMs = 0) {
    this.maybeRestoreRate();

    // 최소 간격 + 지터
    if (minDelayMs > 0)
      await sleep(minDelayMs + Math.floor(Math.random() * jitterMs));

    // 버킷 리필
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed > 0) {
      this.tokens = Math.min(
        this.capacity,
        this.tokens + elapsed * this.refillPerSec,
      );
      this.lastRefill = now;
    }

    // 토큰 없으면 대기
    if (this.tokens < 1) {
      const need = 1 - this.tokens;
      const waitSec = need / this.refillPerSec;
      await sleep(Math.ceil(waitSec * 1000));
      this.tokens = 0; // 아래에서 1 소모
    }

    this.tokens -= 1;
  }
}

@Injectable()
export class SteamCommunityService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SteamCommunityService.name);
  private browser: Browser | null = null;

  // ── 성능/안정화 파라미터 (필요시 환경변수로 조절) ──────────────────────
  private readonly MAX_CONCURRENCY = Number(
    process.env.STEAM_COMMUNITY_MAX_CONCURRENCY ?? 2, // 권장: 2부터 시작
  );
  private readonly MIN_DELAY_MS = Number(
    process.env.STEAM_COMMUNITY_MIN_DELAY_MS ?? 800,
  );
  private readonly DELAY_JITTER_MS = Number(
    process.env.STEAM_COMMUNITY_DELAY_JITTER_MS ?? 400,
  );
  private readonly RPS = Number(process.env.STEAM_COMMUNITY_RPS ?? 0.8); // 초당 < 1회부터
  private readonly BURST = Number(process.env.STEAM_COMMUNITY_BURST ?? 1);
  private readonly JS_FAST_PATH =
    (process.env.STEAM_COMMUNITY_JS_FAST_PATH ?? '1') === '1'; // JS off 시도

  private limiter = new TokenBucket({
    capacity: this.BURST,
    refillPerSec: this.RPS,
  });

  // 간단 페이지 풀
  private pagePool: Page[] = [];
  private pagePending = 0;

  /** 다국어 '멤버' 키워드 패턴 */
  private readonly memberRegex =
    /([0-9][0-9\.\,\s\u00A0]*)\s*(members?|member|명|membres|mitglieder|miembros|чел\.|成员|멤버|สมาชิก|человек)/i;

  // 캐시(선택): 동일 요청 재사용 (기본 30분) — 0(실패)도 캐싱
  private cache = new Map<string, { at: number; value: number }>();
  private readonly CACHE_TTL_MS = Number(
    process.env.STEAM_COMMUNITY_CACHE_TTL_MS ?? 30 * 60 * 1000,
  );

  // 429 모니터링
  private recent429: number[] = []; // epoch ms

  async onModuleInit() {
    this.logger.log('🚀 Puppeteer 실행 시작');
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;

    this.browser = await puppeteer.launch({
      headless: true,
      executablePath: executablePath || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--blink-settings=imagesEnabled=false',
      ],
      defaultViewport: { width: 1280, height: 800 },
    });
  }

  async onModuleDestroy() {
    if (this.browser) {
      this.logger.log('🛑 Puppeteer 종료');
      await Promise.allSettled(
        this.pagePool.map((p) => p.close().catch(() => {})),
      );
      await this.browser.close();
      this.browser = null;
    }
  }

  /** Steam 앱 리스트 */
  async fetchAppList(): Promise<App[]> {
    this.logger.log(`📡 AppList API 호출: ${APP_LIST_URL}`);
    const { data } = await axios.get(APP_LIST_URL, { timeout: 60_000 });
    const apps = data?.applist?.apps ?? [];
    this.logger.log(
      `📥 AppList 로딩 완료: 총 ${apps.length.toLocaleString()}개`,
    );
    return apps;
  }

  /** 무작위 n개 샘플 */
  sample<T>(arr: T[], n: number): T[] {
    const a = [...arr];
    const out: T[] = [];
    while (out.length < n && a.length) {
      const i = Math.floor(Math.random() * a.length);
      out.push(a.splice(i, 1)[0]);
    }
    return out;
  }

  // ───────────────────────────────────────────────────────────────
  // 페이지 풀
  // ───────────────────────────────────────────────────────────────
  private async acquirePage(jsEnabled: boolean): Promise<Page> {
    if (!this.browser) throw new Error('브라우저가 초기화되지 않았습니다.');

    // 풀에 남아있으면 재사용
    const page = this.pagePool.pop();
    if (page) {
      // JS 모드가 다르면 맞춰준다
      try {
        await page.setJavaScriptEnabled(jsEnabled);
      } catch {}
      return page;
    }

    // 동시 페이지 생성 제한
    while (this.pagePending >= this.MAX_CONCURRENCY) {
      await sleep(20);
    }

    this.pagePending++;
    try {
      const p = await this.browser!.newPage();

      await p.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
      );
      await p.setExtraHTTPHeaders({
        'accept-language': 'en-US,en;q=0.9,ko-KR;q=0.8',
      });

      await p.evaluateOnNewDocument(() => {
        // @ts-ignore
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
      });

      await p.setJavaScriptEnabled(jsEnabled);

      await p.setRequestInterception(true);
      p.on('request', (req) => {
        const t = req.resourceType();
        // 이미지/폰트/미디어/스타일은 모두 차단 (렌더 필요 없는 텍스트 기반 파싱)
        if (
          t === 'image' ||
          t === 'media' ||
          t === 'font' ||
          t === 'stylesheet'
        )
          req.abort();
        else req.continue();
      });

      return p;
    } finally {
      this.pagePending--;
    }
  }

  private releasePage(page: Page) {
    // 풀에 반납 (닫지 않음)
    this.pagePool.push(page);
  }

  // ───────────────────────────────────────────────────────────────
  // 🔎 그룹 검색 1페이지에서 /app/<appid> 링크 카드의 멤버 수만 파싱
  // ───────────────────────────────────────────────────────────────

  /**
   * (최종 선택지) 그룹 검색 1페이지에서 /app/<appid> 링크 카드의 멤버 수 파싱
   * - 허브 경로는 사용하지 않음(요청사항 반영)
   * - 빠른 경로(JS off) → 실패 시 JS on 재시도
   * - 레이트리밋 + 지수 백오프 + Retry-After 대응
   * - 실패 시 0 반환(네거티브 캐시 적용)
   */
  async scrapeFollowers(appid: number, gameName: string): Promise<number> {
    const cacheKey = `${appid}::${gameName.toLowerCase()}`;
    const now = Date.now();
    const cached = this.cache.get(cacheKey);
    if (cached && now - cached.at < this.CACHE_TTL_MS) {
      return cached.value;
    }

    const searchUrl = `https://steamcommunity.com/search/groups/?text=${encodeURIComponent(
      gameName,
    )}`;

    // 레이트리미트(최소 지연 + 버스트 제어)
    await this.limiter.take(this.MIN_DELAY_MS, this.DELAY_JITTER_MS);

    // ① 빠른 경로: JS 비활성화
    let best = 0;
    if (this.JS_FAST_PATH) {
      best = await this.tryParseWithPage(appid, gameName, searchUrl, false);
    }

    if (best <= 0) {
      // 429/가드 회피를 위한 추가 대기
      await sleep(250 + Math.floor(Math.random() * 250));

      // ② 폴백: JS 활성화 (동적 요소 대비)
      best = await this.tryParseWithPage(appid, gameName, searchUrl, true);
    }

    const finalVal = Math.max(0, best | 0);
    this.cache.set(cacheKey, { at: now, value: finalVal }); // 0도 캐싱
    return finalVal;
  }

  /** 데코릴레이트 지터 백오프 (exponential, cap 포함) */
  private backoffMs(attempt: number, base = 1200, cap = 15000) {
    const exp = base * Math.pow(2, attempt - 1);
    const jitter = Math.floor(Math.random() * base);
    return Math.min(cap, exp + jitter);
  }

  /** 429 발생시 호출: 속도 낮추고, 최근 히트 집계 → 임계 넘으면 쿨다운 */
  private async on429(attempt: number, retryAfterHeader?: string | number) {
    const now = Date.now();

    // 1) 버킷 일시 감속 (2분간 50% 속도)
    this.limiter.temporarilySlowDown(0.5, 2 * 60 * 1000);

    // 2) Retry-After 우선
    const retryAfterSec = Number(retryAfterHeader ?? 0);
    if (!Number.isNaN(retryAfterSec) && retryAfterSec > 0) {
      const wait = retryAfterSec * 1000 + Math.floor(Math.random() * 500);
      this.logger.warn(`⏳ Retry-After 감지 → ${wait}ms 대기`);
      await sleep(wait);
    } else {
      // 없으면 시도수 기반 백오프
      const wait = this.backoffMs(attempt, 1200, 15000);
      this.logger.warn(`⏳ 429 백오프 → ${wait}ms 대기`);
      await sleep(wait);
    }

    // 3) 최근 90초 내 429가 3회 이상이면 추가 쿨다운
    this.recent429 = this.recent429.filter((t) => now - t <= 90_000);
    this.recent429.push(now);

    if (this.recent429.length >= 3) {
      const cool = 30_000 + Math.floor(Math.random() * 30_000); // 30~60s
      this.logger.warn(`🧯 429 빈발 → 추가 쿨다운 ${cool}ms`);
      await sleep(cool);
      // 버킷 더 느리게 1분
      this.limiter.temporarilySlowDown(0.4, 60_000);
      // 카운터 약간 완화
      this.recent429.shift();
    }
  }

  private async tryParseWithPage(
    appid: number,
    gameName: string,
    searchUrl: string,
    jsEnabled: boolean,
  ): Promise<number> {
    const page = await this.acquirePage(jsEnabled);

    try {
      this.logger.debug(
        `🌐 [Search] (${jsEnabled ? 'JS:on' : 'JS:off'}) 열기: ${searchUrl}`,
      );

      const maxAttempts = 5; // 3 → 5로 상향
      let attempt = 0;
      let lastErr: any = null;

      while (attempt < maxAttempts) {
        attempt++;

        try {
          const res = await page.goto(searchUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 20_000,
          });

          const status = res?.status() ?? 0;

          if (status === 429) {
            const retryAfter = res?.headers()['retry-after'];
            this.logger.warn(
              `⚠️  429 Too Many Requests (${attempt}/${maxAttempts})`,
            );
            await this.on429(attempt, retryAfter);
            continue;
          }

          if (status >= 500 && status < 600) {
            const wait = this.backoffMs(attempt, 800, 10_000);
            this.logger.warn(
              `⚠️  ${status} 서버 오류 → ${wait}ms 대기 후 재시도 (${attempt}/${maxAttempts})`,
            );
            await sleep(wait);
            continue;
          }

          if (jsEnabled) {
            await page
              .waitForFunction(
                (q: string) => !!document.querySelector(q),
                { timeout: 6_000 },
                '.search_result_container, .search_results, .search_row, .search_result_row',
              )
              .catch(() => null);
          }

          await sleep(
            jsEnabled ? 200 + Math.random() * 200 : 80 + Math.random() * 120,
          );

          type EvalOut = {
            totalCards: number;
            matchedCount: number;
            firstMembers: number;
          };

          const out: EvalOut = await page.evaluate(
            (id: number, reSource: string) => {
              const re = new RegExp(reSource, 'i');

              const cards = Array.from(
                document.querySelectorAll<HTMLElement>(
                  [
                    '.search_row.group',
                    '.search_result_row',
                    '.groupblock',
                    '.group_block',
                    '[data-search-type="groups"] [class*="row"]',
                  ].join(','),
                ),
              );

              let matchedCount = 0;
              let firstMembers: number = 0;

              for (const card of cards) {
                const appLink = card.querySelector<HTMLAnchorElement>(
                  `a[href*="/app/${id}"]`,
                );
                if (!appLink) continue;
                matchedCount++;

                // 카드 전체 텍스트에서 숫자 추출
                const txt = (card.innerText || '').replace(/\s+/g, ' ');
                const m = txt.match(re);
                if (m) {
                  const raw = (m[1] || '').replace(/[^\d]/g, '');
                  if (raw) {
                    firstMembers = parseInt(raw, 10);
                    break;
                  }
                }

                // 보조: 하위 엘리먼트 스캔
                const leaf = Array.from(
                  card.querySelectorAll<HTMLElement>(
                    'span, div, small, b, strong, i',
                  ),
                )
                  .map((el) => el.innerText || '')
                  .find((s) => re.test(s));
                if (leaf) {
                  const raw = leaf.replace(/[^\d]/g, '');
                  firstMembers = raw ? parseInt(raw, 10) : 0;
                  break;
                }
              }

              return { totalCards: cards.length, matchedCount, firstMembers };
            },
            appid,
            this.memberRegex.source,
          );

          this.logger.debug(
            `🧭 [Search] '${gameName}' (AppID=${appid}) 카드 ${out.totalCards}개 / 매칭 ${out.matchedCount}개`,
          );

          if (out.firstMembers && Number.isFinite(out.firstMembers)) {
            this.logger.debug(
              `✅ [Search] 멤버 수 파싱 성공: ${out.firstMembers.toLocaleString()}`,
            );
            return out.firstMembers;
          }

          // 없으면 실패로 간주
          this.logger.debug('❌ [Search] 1페이지 매칭 실패');
          return 0;
        } catch (e: any) {
          lastErr = e;
          // 네트워크류 에러에도 백오프
          const wait = this.backoffMs(attempt, 600, 8000);
          this.logger.warn(
            `⚠️  검색 실패 시도 ${attempt}/${maxAttempts} → ${wait}ms 대기: ${
              e?.message ?? e
            }`,
          );
          await sleep(wait);
        }
      }

      this.logger.error(`❌ [Search] 최종 실패: ${lastErr?.message ?? lastErr}`);
      return 0;
    } finally {
      // 페이지 닫지 않고 풀에 반납하여 재사용
      try {
        this.releasePage(page);
      } catch {
        try {
          await page.close();
        } catch {}
      }
    }
  }
}
