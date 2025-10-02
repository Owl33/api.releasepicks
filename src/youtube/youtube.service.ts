// src/youtube.service.ts
import { Injectable, Logger } from '@nestjs/common';
import {
  YouTubeSearchItem,
  YouTubeSearchFilters,
  GameTrailerResult,
  ConfidenceLevel,
} from './youtube.types';
import * as https from 'https';

// ────────────────────────────────────────────────────────────────
// Node 18+ 권장: IPv4 우선 (일부 환경에서 DNS 관련 지연/실패 방지)
// ────────────────────────────────────────────────────────────────
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dns = require('node:dns');
  if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
  }
} catch {
  // ignore - 선택적 최적화
}

/** 토큰 버킷 레이트리미터 (429 방지 + 지터) */
class TokenBucket {
  private tokens: number;
  private lastRefill = Date.now();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number, // 초당 회복량
  ) {
    this.tokens = capacity;
  }

  private static async _sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** 최소 지연/지터 적용 후 토큰 1개 차감 (없으면 대기) */
  async take(minDelayMs = 0, jitterMs = 0): Promise<void> {
    if (minDelayMs > 0) {
      const jitter = jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0;
      await TokenBucket._sleep(minDelayMs + jitter);
    }

    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    if (elapsedSec > 0) {
      this.tokens = Math.min(
        this.capacity,
        this.tokens + elapsedSec * this.refillPerSec,
      );
      this.lastRefill = now;
    }

    if (this.tokens < 1) {
      const need = 1 - this.tokens;
      const waitSec = need / this.refillPerSec;
      await TokenBucket._sleep(Math.ceil(waitSec * 1000));
      this.tokens = 0; // 아래에서 1 소모
    }
    this.tokens -= 1;
  }
}

/** 간단 LRU + TTL 캐시 */
class LruCache<V> {
  private map = new Map<string, { v: V; at: number }>();

  constructor(private readonly max = 200, private readonly ttlMs = 20 * 60 * 1000) {}

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (Date.now() - e.at > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    // LRU 갱신
    this.map.delete(key);
    this.map.set(key, { v: e.v, at: Date.now() });
    return e.v;
  }

  set(key: string, value: V) {
    if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest) this.map.delete(oldest);
    }
    this.map.set(key, { v: value, at: Date.now() });
  }
}

/** 서킷 브레이커 상태 */
type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

@Injectable()
export class YouTubeService {
  private readonly logger = new Logger(YouTubeService.name);

  // ── 튜닝 파라미터 (환경변수로 조정 가능) ─────────────────────────
  private readonly perRequestTimeoutMs = Number(process.env.YT_TIMEOUT_MS ?? 3500);
  private readonly maxRetries = Math.max(0, Number(process.env.YT_MAX_RETRIES ?? 2));
  private readonly highConfidenceCutoff = Math.min(
    1,
    Math.max(0, Number(process.env.YT_HIGH_CONFIDENCE ?? 0.85)),
  );
  private readonly batchSize = Math.max(1, Number(process.env.YT_BATCH_SIZE ?? 3));
  private readonly maxConcurrency = Math.max(1, Number(process.env.YT_MAX_CONCURRENCY ?? 6));
  private readonly rps = Number(process.env.YT_RPS ?? 3);
  private readonly burst = Number(process.env.YT_BURST ?? 6);
  private readonly cacheMax = Number(process.env.YT_CACHE_MAX ?? 200);
  private readonly cacheTtlMs = Number(process.env.YT_CACHE_TTL_MS ?? 20 * 60 * 1000);
  private readonly cbThreshold = Number(process.env.YT_CB_THRESHOLD ?? 8);
  private readonly cbCooldownMs = Number(process.env.YT_CB_COOLDOWN_MS ?? 60_000);

  /** 레이트 리미터 */
  private readonly limiter = new TokenBucket(this.burst, this.rps);

  /** keep-alive 에이전트 (연결 재사용으로 지연 감소) */
  private readonly agent = new https.Agent({ keepAlive: true, maxSockets: 32 });

  /** 캐시 */
  private readonly cache = new LruCache<GameTrailerResult | null>(this.cacheMax, this.cacheTtlMs);

  /** 서킷 브레이커 */
  private breakerState: BreakerState = 'CLOSED';
  private consecutiveFailures = 0;
  private breakerOpenUntil = 0;

  /** 신뢰 채널 및 트레일러 키워드 */
  private readonly trustedChannels: string[] = [
    'playstation', 'xbox', 'nintendo', 'capcom', 'ea', 'ubisoft', 'bandai',
    'sega', 'square enix', 'bethesda', 'devolver', 'riot', 'blizzard',
    'rockstar', 'cd projekt', 'ign', 'game spot', 'gamespot',
  ];
  private readonly trailerKeywords: string[] = [
    'trailer', 'announcement', 'gameplay', 'reveal', 'launch', 'teaser',
  ];

  // ============== Public API ==============

  /**
   * 게임 슬러그(또는 근접 이름)로 공식 트레일러 후보를 빠르게 찾는다.
   * - 병렬 배치 + 레이트리미트 + 조기 종료 + 재시도 + 서킷브레이커 + 캐시
   */
  async findOfficialTrailer(
    slug: string,
    filters: YouTubeSearchFilters = {},
  ): Promise<GameTrailerResult | null> {
    const started = Date.now();
    const cacheKey = this.cacheKey(slug, filters);
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cached;

    if (this.isBreakerOpen()) {
      this.logger.warn(
        `[CB:OPEN] skip YouTube: '${slug}' until ${new Date(this.breakerOpenUntil).toISOString()}`,
      );
      const res: GameTrailerResult = { slug, queryTried: [], picked: null };
      this.cache.set(cacheKey, res);
      return res;
    }

    const queries = this.planQueries(slug, filters);
    this.logger.debug(
      `🔍 [YouTube:${slug}] 총 ${queries.length}개 쿼리 생성 (배치 ${this.batchSize}, 동시 ${this.maxConcurrency})`,
    );

    const tried: string[] = [];
    let best: YouTubeSearchItem | null = null;
    let bestScore = 0;

    // 상신뢰도 발견 시 잔여 작업 취소
    const globalAbort = new AbortController();

    // 간단한 워커/큐 기반 동시성 제어
    let running = 0;
    const qQueue: Array<() => Promise<void>> = [];

    const enqueue = (fn: () => Promise<void>) => qQueue.push(fn);
    const runNext = async () => {
      if (globalAbort.signal.aborted) return;
      if (running >= this.maxConcurrency) return;
      const fn = qQueue.shift();
      if (!fn) return;
      running++;
      try {
        await fn();
      } finally {
        running--;
        if (!globalAbort.signal.aborted) runNext();
      }
    };
    const waitQueueIdle = () =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (globalAbort.signal.aborted) return resolve();
          if (qQueue.length === 0 && running === 0) return resolve();
          setTimeout(check, 20);
        };
        check();
      });

    // 배치 단위로 작업 enqueue
    for (let i = 0; i < queries.length; i += this.batchSize) {
      const batch = queries.slice(i, i + this.batchSize);
      this.logger.debug(
        `  ▶️ 배치 ${Math.ceil((i + 1) / this.batchSize)}/${Math.ceil(queries.length / this.batchSize)} 시작 (${batch.length}개)`,
      );

      for (const q of batch) {
        enqueue(async () => {
          if (globalAbort.signal.aborted) return;

          const qStart = Date.now();
          tried.push(q);
          this.logger.debug(`  ⏱️  쿼리: "${q.length > 80 ? q.slice(0, 77) + '...' : q}"`);

          try {
            await this.limiter.take(60, 120); // RPS 제어 + 지터
            const items = await this.searchOnceWithRetry(q, filters, globalAbort.signal);

            // 최고 점수 후보 갱신
            const { top, score } = this.pickBest(items, slug, filters);
            if (top) {
              if (score > bestScore) {
                best = top;
                bestScore = score;
                this.logger.debug(
                  `    🎯 새로운 최고 점수: ${score.toFixed(3)} - "${(top.title ?? '').slice(0, 50)}..."`,
                );
                if (score >= this.highConfidenceCutoff) {
                  this.logger.debug(
                    `    ⚡ High confidence (${score.toFixed(3)} >= ${this.highConfidenceCutoff}) 발견! 조기 종료`,
                  );
                  globalAbort.abort(); // 잔여 작업 취소
                }
              }
            }

            const spent = Date.now() - qStart;
            this.logger.debug(`  ✅ 완료: ${items.length}개 결과 (소요: ${spent}ms)`);
            this.noteSuccess();
          } catch (err: unknown) {
            if (globalAbort.signal.aborted) return; // 조용히 중단
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.warn(`  ⚠️ 쿼리 실패: ${msg}`);
            this.noteFailure();
          }
        });
      }

      // 워커 가동
      for (let k = 0; k < Math.min(this.maxConcurrency, batch.length); k++) runNext();

      // 배치 종료 대기 (혹은 상신뢰도 조기 종료)
      await waitQueueIdle();
      if (globalAbort.signal.aborted) break;
    }

    const picked = best ? this.toResult(best, bestScore) : null;
    const result: GameTrailerResult = { slug, queryTried: tried, picked };

    // 캐시 저장
    this.cache.set(cacheKey, result);

    // 브레이커 회복/유지
    if (picked) this.noteSuccess();

    const totalMs = Date.now() - started;
    this.logger.debug(
      `📊 [YouTube:${slug}] 완료 - 총 ${totalMs}ms (쿼리:${tried.length}개, 최고점:${bestScore.toFixed(3)})`,
    );
    return result;
  }

  // ============== 내부 구현 ==============

  private cacheKey(slug: string, filters: YouTubeSearchFilters): string {
    // filters 순서/공백에 영향 안 받도록 정규화
    const norm: YouTubeSearchFilters = {
      releaseYear: filters.releaseYear,
      keywords: (filters.keywords ?? []).filter(Boolean),
    };
    return `${this.normalizeSlug(slug).toLowerCase()}::${JSON.stringify(norm)}`;
  }

  private normalizeSlug(slug: string): string {
    return slug.replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  private planQueries(slug: string, filters: YouTubeSearchFilters): string[] {
    const name = this.normalizeSlug(slug);
    const year = filters.releaseYear ? String(filters.releaseYear) : '';
    const baseQuoted = `"${name}"`;
    const baseLoose = name;

    const trailerTerms = [
      'official trailer',
      'gameplay trailer',
      'reveal trailer',
      'launch trailer',
      'announcement trailer',
      'teaser',
    ];
    const brandTerms = ['official', 'ps5', 'xbox', 'nintendo', 'pc', 'steam'];

    const set = new Set<string>();

    // 가장 강한 조합: "이름" + trailer term (+연도)
    for (const t of trailerTerms) {
      set.add(`${baseQuoted} ${t}${year ? ' ' + year : ''}`);
    }

    // 브랜드/플랫폼 + trailer
    for (const b of brandTerms) {
      set.add(`${baseLoose} ${b} trailer`);
      if (year) set.add(`${baseLoose} ${b} trailer ${year}`);
    }

    // 일반 trailer
    set.add(`${baseLoose} trailer`);
    if (year) set.add(`${baseLoose} trailer ${year}`);

    // 추가 키워드가 있으면 최전방에 배치
    const extra = (filters.keywords ?? [])
      .filter(Boolean)
      .map((k) => `${baseLoose} ${k}`);

    // 최종 목록 (과도하게 길지 않게 상한)
    const queries = [...extra, ...Array.from(set)];
    const hardCap = Math.max(10, this.batchSize * 3);
    return queries.slice(0, hardCap);
  }

  /** 재시도 래퍼 (지수 백오프 + 지터) */
  private async searchOnceWithRetry(
    q: string,
    filters: YouTubeSearchFilters,
    signal?: AbortSignal,
  ): Promise<YouTubeSearchItem[]> {
    let attempt = 0;
    let lastError: unknown;

    while (attempt <= this.maxRetries) {
      attempt++;
      try {
        const res = await this.searchOnce(q, filters, signal);
        return res;
      } catch (e: unknown) {
        lastError = e;
        // 이미 취소된 경우 즉시 전파
        if (signal?.aborted) throw e;

        const msg = e instanceof Error ? e.message : String(e);
        const retryable = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|fetch failed|HTTP 429|HTTP 5\d\d|YT_TIMEOUT/i.test(
          msg,
        );
        if (!retryable || attempt > this.maxRetries) break;

        const backoff = 250 * attempt + Math.floor(Math.random() * 200);
        this.logger.warn(`   ↻ 재시도 ${attempt}/${this.maxRetries} (대기 ${backoff}ms): ${msg}`);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /** 실제 검색 요청 (웹 결과 파싱 경량 버전) */
  private async searchOnce(
    q: string,
    _filters: YouTubeSearchFilters,
    outerSignal?: AbortSignal,
  ): Promise<YouTubeSearchItem[]> {
    // Node 18+ 전제: 글로벌 fetch/AbortController 사용 가능
    const controller = new AbortController();
    const combined = this.combineSignals(outerSignal, controller.signal);
    const timeout = setTimeout(() => controller.abort(new Error('YT_TIMEOUT')), this.perRequestTimeoutMs);

    try {
      const url =
        `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgIQAQ%253D%253D`; // 동영상만
      const res: any = await (globalThis.fetch as any)(url, {
        // Node fetch는 undici 기반. 타입 충돌 방지 위해 any 사용.
        agent: this.agent as any,
        redirect: 'follow',
        signal: combined,
        headers: {
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
          'accept-language': 'en-US,en;q=0.9,ko-KR;q=0.8',
        },
      });

      const status: number = typeof res?.status === 'number' ? res.status : 0;
      if (!res || status < 200 || status >= 400) {
        const bodyPreview =
          (await res?.text?.().catch(() => ''))?.slice(0, 200) ?? '';
        throw new Error(`HTTP ${status} ${res?.statusText ?? ''} :: ${bodyPreview}`);
      }

      const html: string = await res.text();
      const items = this.parseYouTubeResults(html);
      return items;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** ytInitialData 에서 동영상 카드들을 추출하는 경량 파서 */
  private parseYouTubeResults(html: string): YouTubeSearchItem[] {
    // ytInitialData JSON 추출
    const m =
      html.match(/ytInitialData"\]\s*=\s*(\{.*?\});/s) ||
      html.match(/var\s+ytInitialData\s*=\s*(\{.*?\});/s);
    if (!m) return [];

    let data: any;
    try {
      data = JSON.parse(m[1]);
    } catch {
      return [];
    }

    const out: YouTubeSearchItem[] = [];

    // 안전 탐색
    const primary =
      data?.contents?.twoColumnSearchResultsRenderer?.primaryContents;
    const sections =
      primary?.sectionListRenderer?.contents ??
      primary?.richGridRenderer?.contents ??
      [];

    const walk = (node: any) => {
      if (!node || typeof node !== 'object') return;

      // videoRenderer
      if (node.videoRenderer) {
        const v = node.videoRenderer;
        const title: string =
          v?.title?.runs?.[0]?.text ??
          v?.headline?.simpleText ??
          '';
        const videoId: string | undefined = v?.videoId;
        const channel: string =
          v?.ownerText?.runs?.[0]?.text ??
          v?.longBylineText?.runs?.[0]?.text ??
          '';
        const published: string = v?.publishedTimeText?.simpleText ?? '';
        const viewsText: string = v?.viewCountText?.simpleText ?? '';
        const duration: string = v?.lengthText?.simpleText ?? '';
        const desc: string =
          (v?.detailedMetadataSnippets?.[0]?.snippetText?.runs ?? [])
            .map((r: any) => r?.text ?? '')
            .join('') || '';

        out.push({
          title,
          url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : '',
          channelTitle: channel,
          publishedAt: published,
          viewCountText: viewsText,
          durationText: duration,
          description: desc,
        });
      }

      // 하위 노드 순회
      for (const k of Object.keys(node)) {
        // 키의 값이 배열/객체일 때만 재귀
        const child = (node as any)[k];
        if (child && typeof child === 'object') {
          if (Array.isArray(child)) {
            for (const c of child) walk(c);
          } else {
            walk(child);
          }
        }
      }
    };

    for (const s of sections) walk(s);
    return out;
  }

  /** 스코어링 최고 후보 선택 */
  private pickBest(items: YouTubeSearchItem[], slug: string, filters: YouTubeSearchFilters) {
    let top: YouTubeSearchItem | null = null;
    let best = 0;

    for (const it of items) {
      const s = this.score(it, slug, filters);
      if (s > best) {
        best = s;
        top = it;
      }
    }
    return { top, score: best };
  }

  /** 점수 함수 (간결/안정) 0~1 */
  private score(item: YouTubeSearchItem, slug: string, _filters: YouTubeSearchFilters): number {
    const name = this.normalizeSlug(slug).toLowerCase();
    const title = (item.title ?? '').toLowerCase();
    const desc = (item.description ?? '').toLowerCase();
    const channel = (item.channelTitle ?? '').toLowerCase();

    let s = 0;

    // 이름 매칭
    if (title.includes(name)) s += 0.35;
    if (desc.includes(name)) s += 0.10;

    // 트레일러 키워드
    if (this.trailerKeywords.some((kw) => title.includes(kw))) s += 0.25;

    // 신뢰 채널 가산
    if (this.trustedChannels.some((ch) => channel.includes(ch))) s += 0.20;

    // Gameplay 약간 가산
    if (title.includes('gameplay')) s += 0.05;

    if (s > 1) s = 1;
    return s;
  }

  private toResult(item: YouTubeSearchItem, score: number): GameTrailerResult['picked'] {
    let confidence: ConfidenceLevel = 'low';
    if (score >= this.highConfidenceCutoff) confidence = 'high';
    else if (score >= 0.6) confidence = 'medium';

    return {
      url: item.url || '',
      title: item.title || '',
      channel: item.channelTitle || '',
      publishedAt: item.publishedAt || '',
      confidence,
      score,
    };
  }

  // ── 서킷 브레이커 ─────────────────────────────────────────────
  private isBreakerOpen(): boolean {
    if (this.breakerState === 'OPEN') {
      if (Date.now() < this.breakerOpenUntil) return true;
      // 쿨다운 종료 → HALF_OPEN으로 전환
      this.breakerState = 'HALF_OPEN';
      return false;
    }
    return false;
  }

  private noteSuccess() {
    this.consecutiveFailures = 0;
    if (this.breakerState === 'HALF_OPEN') {
      this.breakerState = 'CLOSED';
    }
  }

  private noteFailure() {
    this.consecutiveFailures++;
    if (this.breakerState === 'CLOSED' && this.consecutiveFailures >= this.cbThreshold) {
      this.breakerState = 'OPEN';
      this.breakerOpenUntil = Date.now() + this.cbCooldownMs;
      this.logger.warn(`[CB:OPEN] YouTube 서킷 오픈 - ${this.cbCooldownMs}ms`);
    } else if (this.breakerState === 'HALF_OPEN') {
      this.breakerState = 'OPEN';
      this.breakerOpenUntil = Date.now() + this.cbCooldownMs;
      this.logger.warn(`[CB:OPEN] HALF_OPEN 실패로 재오픈 - ${this.cbCooldownMs}ms`);
    }
  }

  // ── 유틸 ──────────────────────────────────────────────────────
  /** 두 AbortSignal을 결합 (둘 중 하나라도 abort되면 abort) */
  private combineSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
    if (!a && !b) return undefined;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    a?.addEventListener('abort', onAbort);
    b?.addEventListener('abort', onAbort);
    if (a?.aborted || b?.aborted) controller.abort();
    return controller.signal;
  }
}
