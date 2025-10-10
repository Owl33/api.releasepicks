// src/steam-community/steamcommunity.service.ts
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import axios from 'axios';
import { getGlobalRateLimiter } from '../../common/concurrency/global-rate-limiter';

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

/** ───────────────────────────────────────────────────────────────
 *  Puppeteer 구조적 타입 (필요 메서드만)
 *  ─ puppeteer / puppeteer-core 어느 쪽이 와도 호환됨
 *  ───────────────────────────────────────────────────────────── */
interface MinimalPage {
  setJavaScriptEnabled(enabled: boolean): Promise<void>;
  setUserAgent(ua: string): Promise<void>;
  setExtraHTTPHeaders(headers: Record<string, string>): Promise<void>;
  evaluateOnNewDocument(fn: (...args: any[]) => any): Promise<void>;
  setRequestInterception(value: boolean): Promise<void>;
  on(event: 'request', cb: (req: any) => void): void;
  goto(
    url: string,
    opts?: any,
  ): Promise<{ status(): number; headers(): Record<string, string> } | null>;
  waitForFunction(
    fn: (...args: any[]) => any,
    opts?: { timeout?: number },
    ...args: any[]
  ): Promise<any>;
  evaluate<T>(fn: (...args: any[]) => T, ...args: any[]): Promise<T>;
  close(): Promise<void>;
}

interface MinimalBrowser {
  newPage(): Promise<MinimalPage>;
  close(): Promise<void>;
}

/** 간단 토큰 버킷 리미터: burst 허용 후 초당 일정 속도로 회복 (+ 일시 감속 지원) */
class TokenBucket {
  private tokens: number;
  private readonly capacity: number;
  private readonly baseRefillPerSec: number;
  private refillPerSec: number;
  private lastRefill = Date.now();
  private slowUntil = 0;

  constructor(opts: { capacity: number; refillPerSec: number }) {
    this.capacity = opts.capacity;
    this.baseRefillPerSec = opts.refillPerSec;
    this.refillPerSec = opts.refillPerSec;
    this.tokens = opts.capacity;
  }

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
    if (minDelayMs > 0)
      await sleep(minDelayMs + Math.floor(Math.random() * jitterMs));

    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed > 0) {
      this.tokens = Math.min(
        this.capacity,
        this.tokens + elapsed * this.refillPerSec,
      );
      this.lastRefill = now;
    }
    if (this.tokens < 1) {
      const need = 1 - this.tokens;
      const waitSec = need / this.refillPerSec;
      await sleep(Math.ceil(waitSec * 1000));
      this.tokens = 0;
    }
    this.tokens -= 1;
  }
}

@Injectable()
export class SteamCommunityService implements OnModuleDestroy {
  private readonly logger = new Logger(SteamCommunityService.name);

  // 브라우저/런처는 지연 초기화 (구조적 타입 사용)
  private browserPromise: Promise<MinimalBrowser> | null = null;

  private readonly globalLimiter = getGlobalRateLimiter();

  // ── 성능/안정화 파라미터 (ENV로 조절 가능) ─────────────────────────────
  private readonly MAX_CONCURRENCY = Math.min(
    4,
    Math.max(1, Number(process.env.STEAM_COMMUNITY_MAX_CONCURRENCY ?? 4)),
  );
  private readonly MIN_DELAY_MS = Number(
    process.env.STEAM_COMMUNITY_MIN_DELAY_MS ?? 350,
  );
  private readonly DELAY_JITTER_MS = Number(
    process.env.STEAM_COMMUNITY_DELAY_JITTER_MS ?? 220,
  );
  private readonly RPS = Number(process.env.STEAM_COMMUNITY_RPS ?? 1.0);
  private readonly BURST = Number(process.env.STEAM_COMMUNITY_BURST ?? 1.1);
  private readonly JS_FAST_PATH =
    (process.env.STEAM_COMMUNITY_JS_FAST_PATH ?? '1') === '1';

  // 타임박스/타임아웃(짧게)
  private readonly DEADLINE_MS = Number(
    process.env.STEAM_COMMUNITY_DEADLINE_MS ?? 3500,
  );
  private readonly GOTO_TIMEOUT_FAST = Number(
    process.env.STEAM_COMMUNITY_GOTO_TIMEOUT_FAST ?? 1200,
  );
  private readonly GOTO_TIMEOUT_SLOW = Number(
    process.env.STEAM_COMMUNITY_GOTO_TIMEOUT_SLOW ?? 2200,
  );
  private readonly WAIT_SELECTOR_FAST = Number(
    process.env.STEAM_COMMUNITY_WAIT_SELECTOR_FAST ?? 600,
  );
  private readonly WAIT_SELECTOR_SLOW = Number(
    process.env.STEAM_COMMUNITY_WAIT_SELECTOR_SLOW ?? 1200,
  );

  private limiter = new TokenBucket({
    capacity: this.BURST,
    refillPerSec: this.RPS,
  });

  // 페이지 풀 (구조적 타입)
  private pagePool: MinimalPage[] = [];
  private pagePending = 0;

  /** 다국어 '멤버' 키워드 패턴 */
  private readonly memberRegex =
    /([0-9][0-9\.\,\s\u00A0]*)\s*(members?|member|명|membres|mitglieder|miembros|чел\.|成员|멤버|สมาชิก|человек)/i;

  // 캐시 (0도 캐싱)
  private cache = new Map<string, { at: number; value: number }>();
  private readonly CACHE_TTL_MS = Number(
    process.env.STEAM_COMMUNITY_CACHE_TTL_MS ?? 30 * 60 * 1000,
  );

  // 429 모니터링
  private recent429: number[] = [];

  /** 서버리스 환경 여부 */
  private isServerless() {
    return !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_VERSION;
  }

  /** 필요 시에만 브라우저 띄우기 (서버리스/로컬 분기) */
  private async getBrowser(): Promise<MinimalBrowser> {
    if (this.browserPromise) return this.browserPromise;

    this.logger.log('🚀 Puppeteer 브라우저 초기화 시작');

    if (this.isServerless()) {
      // 서버리스: puppeteer-core + @sparticuz/chromium
      this.browserPromise = (async () => {
        const [chromiumMod, pptrCore] = await Promise.all([
          import('@sparticuz/chromium'),
          import('puppeteer-core'),
        ]);

        const chromium = (chromiumMod as any).default || (chromiumMod as any);

        const executablePath = await chromium.executablePath();
        const browser = await (pptrCore as any).launch({
          args: chromium.args,
          executablePath,
          headless: true,
          defaultViewport: { width: 1280, height: 800 },
        });

        this.logger.log('✅ 서버리스 브라우저 준비 완료');
        return browser as unknown as MinimalBrowser;
      })();
    } else {
      // 로컬 개발: puppeteer (devDependency) 사용
      this.browserPromise = (async () => {
        const local = await import('puppeteer');
        const browser = await local.default.launch({
          headless: true,
          defaultViewport: { width: 1280, height: 800 },
        });
        this.logger.log('✅ 로컬 브라우저 준비 완료');
        return browser as unknown as MinimalBrowser;
      })();
    }

    return this.browserPromise;
  }

  async onModuleDestroy() {
    if (this.browserPromise) {
      try {
        const browser = await this.browserPromise;
        this.logger.log('🛑 Puppeteer 종료');
        await Promise.allSettled(
          this.pagePool.map((p) => p.close().catch(() => {})),
        );
        await browser.close();
      } catch (e) {
        this.logger.warn(`브라우저 종료 중 경고: ${e?.message || e}`);
      } finally {
        this.browserPromise = null;
      }
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

  // ───────────────────────────────────────────────────────────────
  // 페이지 풀
  // ───────────────────────────────────────────────────────────────
  private async acquirePage(jsEnabled: boolean): Promise<MinimalPage> {
    const browser = await this.getBrowser();

    const page = this.pagePool.pop();
    if (page) {
      try {
        await page.setJavaScriptEnabled(jsEnabled);
      } catch {}
      return page;
    }

    while (this.pagePending >= this.MAX_CONCURRENCY) await sleep(10);
    this.pagePending++;
    try {
      const p = await browser.newPage();
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
      p.on('request', (req: any) => {
        const t = req.resourceType?.() ?? req._resourceType; // core/local 호환
        if (
          t === 'image' ||
          t === 'media' ||
          t === 'font' ||
          t === 'stylesheet'
        ) {
          req.abort();
        } else {
          req.continue();
        }
      });

      return p;
    } finally {
      this.pagePending--;
    }
  }

  private releasePage(page: MinimalPage) {
    this.pagePool.push(page);
  }

  // ───────────────────────────────────────────────────────────────
  // 유틸: 질의어 정제/대체 (속도↑, 매칭↑)
  // ───────────────────────────────────────────────────────────────
  private simplifyName(name: string): string {
    // 괄호/브래킷 안 부가어, 데모/에디션/사운드트랙/패키지/번들 등 제거
    const cleaned = name
      .replace(/[\(\[\{].*?[\)\]\}]/g, ' ')
      .replace(
        /\b(demo|dlc|soundtrack|ost|edition|bundle|package|pack|advanced|tech|tactician)\b/gi,
        ' ',
      )
      .replace(/\s{2,}/g, ' ')
      .trim();
    return cleaned.length >= 3 ? cleaned : name;
  }

  private buildQueries(appid: number, gameName: string): string[] {
    const q0 = gameName.trim();
    const q1 = this.simplifyName(q0);
    const q2 = `appid ${appid}`; // 카드 텍스트에 appid가 직접 노출되는 케이스 대응
    // 같은 값이면 중복 제거
    const uniq = Array.from(new Set([q0, q1, q2].filter(Boolean)));
    return uniq;
  }

  // ───────────────────────────────────────────────────────────────
  // 🔎 그룹 검색 1페이지에서 /app/<appid> 링크 카드의 멤버 수만 파싱
  // ───────────────────────────────────────────────────────────────
  async scrapeFollowers(appid: number, gameName: string): Promise<number> {
    const cacheKey = `${appid}::${gameName.toLowerCase()}`;
    const now = Date.now();
    const cached = this.cache.get(cacheKey);
    if (cached && now - cached.at < this.CACHE_TTL_MS) return cached.value;

    // 전역 속도 제한
    await this.limiter.take(this.MIN_DELAY_MS, this.DELAY_JITTER_MS);

    const deadline = now + this.DEADLINE_MS;
    const queries = this.buildQueries(appid, gameName);

    let best = 0;

    for (const q of queries) {
      if (Date.now() >= deadline) break;
      const url = `https://steamcommunity.com/search/groups/?text=${encodeURIComponent(q)}`;

      // ① Fast path (JS:off)
      if (this.JS_FAST_PATH) {
        best = await this.tryParseWithPage(
          appid,
          gameName,
          url,
          /*jsEnabled*/ false,
          this.GOTO_TIMEOUT_FAST,
          this.WAIT_SELECTOR_FAST,
          deadline,
        );
        if (best > 0) break;
      }

      // 짧은 지연(패턴 완화)
      await sleep(60 + Math.floor(Math.random() * 90));
      if (Date.now() >= deadline) break;

      // ② Slow path (JS:on)
      best = await this.tryParseWithPage(
        appid,
        gameName,
        url,
        /*jsEnabled*/ true,
        this.GOTO_TIMEOUT_SLOW,
        this.WAIT_SELECTOR_SLOW,
        deadline,
      );
      if (best > 0) break;
    }

    const finalVal = Math.max(0, best | 0);
    this.cache.set(cacheKey, { at: Date.now(), value: finalVal }); // 0도 캐싱
    return finalVal;
  }

  /** 데코릴레이트 지터 백오프 (exponential, cap 포함) — 짧게 */
  private backoffMs(attempt: number, base = 600, cap = 6000) {
    const exp = base * Math.pow(2, attempt - 1);
    const jitter = Math.floor(Math.random() * base);
    return Math.min(cap, exp + jitter);
  }

  /** 429 처리: 짧은 백오프 + Retry-After + 일시감속(짧게) */
  private async on429(attempt: number, retryAfterHeader?: string | number) {
    const now = Date.now();

    // 일시 감속 40%/45초
    this.limiter.temporarilySlowDown(0.6, 45_000);
    this.globalLimiter.backoff('steam:followers', 0.5, 45_000);

    const retryAfterSec = Number(retryAfterHeader ?? 0);
    if (!Number.isNaN(retryAfterSec) && retryAfterSec > 0) {
      const wait = retryAfterSec * 1000 + Math.floor(Math.random() * 300);
      this.logger.warn(`⏳ Retry-After 감지 → ${wait}ms 대기`);
      await sleep(wait);
    } else {
      const wait = this.backoffMs(attempt, 700, 8000);
      this.logger.warn(`⏳ 429 백오프 → ${wait}ms 대기`);
      await sleep(wait);
    }

    this.recent429 = this.recent429.filter((t) => now - t <= 90_000);
    this.recent429.push(now);

    // 추가 쿨다운(아주 짧게)
    if (this.recent429.length >= 3) {
      const cool = 12_000 + Math.floor(Math.random() * 10_000); // 12~22s
      this.logger.warn(`🧯 429 빈발 → 추가 쿨다운 ${cool}ms`);
      await sleep(cool);
      this.limiter.temporarilySlowDown(0.5, 30_000);
      this.globalLimiter.backoff('steam:followers', 0.4, 30_000);
      this.recent429 = [];
    }
  }

  private async tryParseWithPage(
    appid: number,
    gameName: string,
    searchUrl: string,
    jsEnabled: boolean,
    gotoTimeoutMs: number,
    waitSelectorMs: number,
    deadline: number,
  ): Promise<number> {
    if (Date.now() >= deadline) return 0;

    const page = await this.acquirePage(jsEnabled);

    try {
      this.logger.debug(
        `🌐 [Search] (${jsEnabled ? 'JS:on' : 'JS:off'}) 열기: ${searchUrl}`,
      );

      // 시도 수 1회만 (빠르게 실패·성공 결정)
      const attempt = 1;

      while (attempt <= 1) {
        if (Date.now() >= deadline) return 0;

        try {
          const res = await page.goto(searchUrl, {
            waitUntil: 'domcontentloaded',
            timeout: Math.max(
              300,
              Math.min(gotoTimeoutMs, Math.max(0, deadline - Date.now())),
            ),
          });

          const status = res?.status() ?? 0;

          if (status === 429) {
            const retryAfter = res?.headers()['retry-after'];
            this.logger.warn(`⚠️  429 Too Many Requests (attempt ${attempt})`);
            await this.on429(attempt, retryAfter);
            // 이 path는 단 1회만 시도하므로 바로 종료
            return 0;
          }

          if (status >= 500 && status < 600) {
            // 서버 오류면 즉시 실패(짧은 파이프)
            this.logger.warn(`⚠️  ${status} 서버 오류 → 이 path 종료`);
            return 0;
          }

          if (jsEnabled) {
            // 결과 컨테이너 등장만 짧게 대기
            await page
              .waitForFunction(
                (q: string) => !!document.querySelector(q),
                {
                  timeout: Math.max(
                    200,
                    Math.min(
                      waitSelectorMs,
                      Math.max(0, deadline - Date.now()),
                    ),
                  ),
                },
                '.search_result_container, .search_results, .search_row, .search_result_row',
              )
              .catch(() => null);
          }

          // 아주 짧은 랜덤 대기(패턴 완화)
          await sleep(
            jsEnabled ? 80 + Math.random() * 100 : 40 + Math.random() * 60,
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

              // 카드 없으면 바로 리턴(상위에서 다음 쿼리 시도)
              if (cards.length === 0)
                return { totalCards: 0, matchedCount: 0, firstMembers: 0 };

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

          // 카드 0개면 즉시 실패(다음 질의로)
          if (out.totalCards === 0) {
            this.logger.debug('❌ [Search] 카드 0개 → 즉시 다음 질의로');
            return 0;
          }

          // 카드가 있어도 매칭 0이면 실패
          this.logger.debug('❌ [Search] 1페이지 매칭 실패');
          return 0;
        } catch (e: any) {
          const msg = e?.message ?? String(e);
          this.logger.warn(`⚠️  path 실패(단일 시도) → ${msg}`);
          return 0;
        }
      }

      return 0;
    } finally {
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
