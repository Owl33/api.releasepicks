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

  constructor(
    private readonly max = 200,
    private readonly ttlMs = 20 * 60 * 1000,
  ) {}

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
  private readonly perRequestTimeoutMs = Number(
    process.env.YT_TIMEOUT_MS ?? 3500,
  );
  private readonly maxRetries = Math.max(
    0,
    Number(process.env.YT_MAX_RETRIES ?? 2),
  );
  private readonly highConfidenceCutoff = Math.min(
    1,
    Math.max(0, Number(process.env.YT_HIGH_CONFIDENCE ?? 0.85)),
  );
  private readonly batchSize = Math.max(
    1,
    Number(process.env.YT_BATCH_SIZE ?? 3),
  );
  private readonly maxConcurrency = Math.max(
    1,
    Number(process.env.YT_MAX_CONCURRENCY ?? 6),
  );
  private readonly rps = Number(process.env.YT_RPS ?? 3);
  private readonly burst = Number(process.env.YT_BURST ?? 6);
  private readonly cacheMax = Number(process.env.YT_CACHE_MAX ?? 200);
  private readonly cacheTtlMs = Number(
    process.env.YT_CACHE_TTL_MS ?? 20 * 60 * 1000,
  );
  private readonly cbThreshold = Number(process.env.YT_CB_THRESHOLD ?? 8);
  private readonly cbCooldownMs = Number(
    process.env.YT_CB_COOLDOWN_MS ?? 60_000,
  );
  private readonly minDurationSeconds = Math.max(
    1,
    Number(process.env.YT_MIN_DURATION_SEC ?? 20),
  );
  private readonly maxDurationSeconds = Math.max(
    this.minDurationSeconds,
    Number(process.env.YT_MAX_DURATION_SEC ?? 240),
  );
  private readonly scoreFreshBonusThresholdDays = Number(
    process.env.YT_FRESH_WINDOW_DAYS ?? 365,
  );
  private readonly scoreFreshBonus = Number(process.env.YT_FRESH_BONUS ?? 0.12);
  private readonly scoreOldPenaltyThresholdDays = Number(
    process.env.YT_OUTDATED_THRESHOLD_DAYS ?? 730,
  );
  private readonly scoreOldPenalty = Number(
    process.env.YT_OUTDATED_PENALTY ?? 0.05,
  );

  /** 레이트 리미터 */
  private readonly limiter = new TokenBucket(this.burst, this.rps);

  /** keep-alive 에이전트 (연결 재사용으로 지연 감소) */
  private readonly agent = new https.Agent({ keepAlive: true, maxSockets: 32 });

  /** 캐시 */
  private readonly cache = new LruCache<GameTrailerResult | null>(
    this.cacheMax,
    this.cacheTtlMs,
  );

  /** 서킷 브레이커 */
  private breakerState: BreakerState = 'CLOSED';
  private consecutiveFailures = 0;
  private breakerOpenUntil = 0;

  /** 신뢰 채널 및 트레일러 키워드 */
  private readonly trustedChannels: string[] = [
    'playstation',
    'xbox',
    'nintendo',
    'capcom',
    'ea',
    'ubisoft',
    'bandai',
    'sega',
    'square enix',
    'bethesda',
    'devolver',
    'riot',
    'blizzard',
    'rockstar',
    'cd projekt',
    'ign',
    'game spot',
    'gamespot',
  ];
  private readonly trailerKeywords: string[] = [
    'trailer',
    'announcement',
    'gameplay',
    'reveal',
    'launch',
    'teaser',
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
      // this.logger.warn(
      //   `[CB:OPEN] skip YouTube: '${slug}' until ${new Date(this.breakerOpenUntil).toISOString()}`,
      // );
      const res: GameTrailerResult = { slug, queryTried: [], picked: null };
      this.cache.set(cacheKey, res);
      return res;
    }

    const queries = this.planQueries(slug, filters);
    // this.logger.debug(
    //   `🔍 [YouTube:${slug}] 총 ${queries.length}개 쿼리 생성 (배치 ${this.batchSize}, 동시 ${this.maxConcurrency})`,
    // );

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
      // this.logger.debug(
      //   `  ▶️ 배치 ${Math.ceil((i + 1) / this.batchSize)}/${Math.ceil(queries.length / this.batchSize)} 시작 (${batch.length}개)`,
      // );

      for (const q of batch) {
        enqueue(async () => {
          if (globalAbort.signal.aborted) return;

          const qStart = Date.now();
          tried.push(q);
          // this.logger.debug(
          //   `  ⏱️  쿼리: "${q.length > 80 ? q.slice(0, 77) + '...' : q}"`,
          // );

          try {
            await this.limiter.take(60, 120); // RPS 제어 + 지터
            const items = await this.searchOnceWithRetry(
              q,
              filters,
              globalAbort.signal,
            );

            // 최고 점수 후보 갱신
            const { top, score } = this.pickBest(items, slug, filters);
            if (top) {
              if (score > bestScore) {
                best = top;
                bestScore = score;
                // this.logger.debug(
                //   `    🎯 새로운 최고 점수: ${score.toFixed(3)} - "${(top.title ?? '').slice(0, 50)}..."`,
                // );
                if (score >= this.highConfidenceCutoff) {
                  // this.logger.debug(
                  //   `    ⚡ High confidence (${score.toFixed(3)} >= ${this.highConfidenceCutoff}) 발견! 조기 종료`,
                  // );
                  globalAbort.abort(); // 잔여 작업 취소
                }
              }
            }

            const spent = Date.now() - qStart;
            // this.logger.debug(
            //   `  ✅ 완료: ${items.length}개 결과 (소요: ${spent}ms)`,
            // );
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
      for (let k = 0; k < Math.min(this.maxConcurrency, batch.length); k++)
        runNext();

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
    const releaseDate =
      typeof filters.releaseDate === 'string'
        ? filters.releaseDate
        : filters.releaseDate instanceof Date
          ? filters.releaseDate.toISOString()
          : undefined;
    const norm: YouTubeSearchFilters = {
      releaseYear: filters.releaseYear,
      releaseDate,
      keywords: (filters.keywords ?? []).filter(Boolean),
    };
    return `${this.normalizeSlug(slug).toLowerCase()}::${JSON.stringify(norm)}`;
  }

  private normalizeSlug(slug: string): string {
    return slug
      .replace(/[_\-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private planQueries(slug: string, filters: YouTubeSearchFilters): string[] {
    const name = this.normalizeSlug(slug);
    const year = filters.releaseYear ? String(filters.releaseYear) : '';
    const baseQuoted = `"${name}"`;
    const baseLoose = name;

    const trailerPhrases = [
      'official trailer',
      'reveal trailer',
      'launch trailer',
      'gameplay trailer',
      'announcement trailer',
      'teaser trailer',
      'story trailer',
    ];
    const trailerTokens = [
      'official',
      'reveal',
      'launch',
      'gameplay',
      'announcement',
      'teaser',
      'overview',
    ];
    const platformTerms = ['ps5', 'playstation', 'xbox', 'nintendo', 'pc'];

    const set = new Set<string>();

    for (const phrase of trailerPhrases) {
      set.add(`${baseQuoted} ${phrase}${year ? ' ' + year : ''}`.trim());
    }

    for (const token of trailerTokens) {
      set.add(`${baseLoose} ${token} trailer`.trim());
      if (year) set.add(`${baseLoose} ${token} trailer ${year}`.trim());
    }

    for (const platform of platformTerms) {
      set.add(`${baseLoose} ${platform} trailer`.trim());
      if (year) set.add(`${baseLoose} ${platform} trailer ${year}`.trim());
    }

    set.add(`${baseLoose} trailer`.trim());
    if (year) set.add(`${baseLoose} trailer ${year}`.trim());

    const queries = Array.from(set);
    const hardCap = Math.max(12, this.batchSize * 3);
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
        const retryable = (() => {
          if (e instanceof Error) {
            const nm = (e as any).name ?? '';
            const m = e.message ?? '';
            if (nm === 'AbortError') return true; // abort는 네트워크 이슈로 간주해서 재시도 허용
            if (/YT_TIMEOUT/i.test(m)) return true;
            if (
              /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|fetch failed|HTTP 429|HTTP 5\d\d|This operation was aborted/i.test(
                m,
              )
            )
              return true;
          }
          return false;
        })();

        if (!retryable || attempt > this.maxRetries) break;

        const backoff = 250 * attempt + Math.floor(Math.random() * 200);
        this.logger.warn(
          `   ↻ 재시도 ${attempt}/${this.maxRetries} (대기 ${backoff}ms): ${msg}`,
        );
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
    let timeoutFired = false;
    const { signal: combined, cleanup } = this.combineSignals(
      outerSignal,
      controller.signal,
    );
    const timeout = setTimeout(() => {
      timeoutFired = true;
      controller.abort(); // 이유 문자열을 넣는 것보다 여기선 플래그로 구분
    }, this.perRequestTimeoutMs);

    try {
      const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgIQAQ%253D%253D`; // 동영상만
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
        throw new Error(
          `HTTP ${status} ${res?.statusText ?? ''} :: ${bodyPreview}`,
        );
      }

      const html: string = await res.text();
      if (/verify you are a human|consent|captcha/i.test(html)) {
        throw new Error('YT_BLOCKED_OR_CONSENT_PAGE');
      }
      const items = this.parseYouTubeResults(html);
      return items;
    } catch (err: unknown) {
      if (timeoutFired) {
        throw new Error('YT_TIMEOUT');
      }
      // abort가 외부 signal (outerSignal) 때문에 발생했는지 확인
      if (outerSignal?.aborted) {
        // 외부 취소 신호의 경우 재시도 하지 않고 상위로 전파
        throw new Error('OUTER_ABORT');
      }
      throw err;
    } finally {
      clearTimeout(timeout);
      try {
        cleanup();
      } catch {}
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
          v?.title?.runs?.[0]?.text ?? v?.headline?.simpleText ?? '';
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

        const durationSeconds = this.parseDurationSeconds(duration);

        out.push({
          title,
          url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : '',
          channelTitle: channel,
          publishedAt: published,
          viewCountText: viewsText,
          viewCount: this.parseViewCount(viewsText),
          durationText: duration,
          durationSeconds,
          description: desc,
        });
      }

      // 하위 노드 순회
      for (const k of Object.keys(node)) {
        // 키의 값이 배열/객체일 때만 재귀
        const child = node[k];
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
  private pickBest(
    items: YouTubeSearchItem[],
    slug: string,
    filters: YouTubeSearchFilters,
  ) {
    let top: YouTubeSearchItem | null = null;
    let best = 0;

    for (const it of items) {
      const secs =
        it.durationSeconds ?? this.parseDurationSeconds(it.durationText);
      if (!this.isDurationAcceptable(secs)) {
        // this.logger.debug(
        //   `⏭️ [YouTube] 길이 조건 불만족(${secs ?? 'unknown'}s) → 스킵: ${it.url ?? it.title ?? ''}`,
        // );
        continue;
      }
      const s = this.score(it, slug, filters);
      if (s > best) {
        best = s;
        top = it;
      }
    }
    return { top, score: best };
  }

  /** 점수 함수 (간결/안정) 0~1 */
  private score(
    item: YouTubeSearchItem,
    slug: string,
    filters: YouTubeSearchFilters,
  ): number {
    const releaseDate = this.normalizeReleaseDate(filters.releaseDate);
    const publishedDate = this.parsePublishedAt(item.publishedAt);

    const name = this.normalizeSlug(slug).toLowerCase();
    const title = (item.title ?? '').toLowerCase();
    const desc = (item.description ?? '').toLowerCase();
    const channel = (item.channelTitle ?? '').toLowerCase();
    const officialNamesRaw = (filters.keywords ?? [])
      .filter((kw) => typeof kw === 'string')
      .map((kw) => kw.trim())
      .filter((kw) => kw.length > 0)
      .slice(0, 6);
    const officialNames = officialNamesRaw
      .map((kw) => this.normalizeForMatching(kw))
      .filter((kw) => kw.length > 0);
    const channelNorm = this.normalizeForMatching(channel);
    const titleNorm = this.normalizeForMatching(title);
    const descNorm = this.normalizeForMatching(desc);
    const slugInfo = this.extractSeriesInfo(name);
    const titleInfo = this.extractSeriesInfo(title);

    let s = 0;

    // 이름 매칭
    if (title.includes(name)) s += 0.35;
    if (desc.includes(name)) s += 0.1;

    // 트레일러 키워드
    if (this.trailerKeywords.some((kw) => title.includes(kw))) s += 0.25;

    // 신뢰 채널 가산
    if (this.trustedChannels.some((ch) => channel.includes(ch))) s += 0.2;

    if (channelNorm && this.matchesOfficialName(channelNorm, officialNames)) {
      s += 0.35;
    }

    // Gameplay 약간 가산
    if (title.includes('gameplay')) s += 0.05;

    // 공식 키워드(개발사/퍼블리셔) 반영
    for (const official of officialNames) {
      if (!official || official.length < 3) continue;
      if (titleNorm.includes(official) || descNorm.includes(official)) {
        s += 0.05;
      }
      if (channelNorm.includes(official)) {
        s += 0.07;
      }
    }

    // 조회수 반영 (log scale, 최대 0.2)
    const viewCount = item.viewCount ?? this.parseViewCount(item.viewCountText);
    if (viewCount != null) {
      const viewScore = Math.min(0.2, Math.log10(viewCount + 1) / 10);
      s += viewScore;
    }

    if (releaseDate && publishedDate) {
      const diffDays = Math.abs(
        (publishedDate.getTime() - releaseDate.getTime()) / 86400000,
      );
      if (diffDays <= this.scoreFreshBonusThresholdDays) {
        s += this.scoreFreshBonus;
      } else if (diffDays >= this.scoreOldPenaltyThresholdDays) {
        s -= this.scoreOldPenalty;
      }
    }

    if (this.isSeriesMismatch(slugInfo, titleInfo)) {
      s -= 0.12;
    }

    if (s > 1) s = 1;
    if (s < 0) s = 0;
    return s;
  }

  private toResult(
    item: YouTubeSearchItem,
    score: number,
  ): GameTrailerResult['picked'] {
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
      durationSeconds: item.durationSeconds ?? null,
      durationText: item.durationText,
      viewCount: item.viewCount ?? null,
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
    if (
      this.breakerState === 'CLOSED' &&
      this.consecutiveFailures >= this.cbThreshold
    ) {
      this.breakerState = 'OPEN';
      this.breakerOpenUntil = Date.now() + this.cbCooldownMs;
      this.logger.warn(`[CB:OPEN] YouTube 서킷 오픈 - ${this.cbCooldownMs}ms`);
    } else if (this.breakerState === 'HALF_OPEN') {
      this.breakerState = 'OPEN';
      this.breakerOpenUntil = Date.now() + this.cbCooldownMs;
      this.logger.warn(
        `[CB:OPEN] HALF_OPEN 실패로 재오픈 - ${this.cbCooldownMs}ms`,
      );
    }
  }

  // ── 유틸 ──────────────────────────────────────────────────────
  /** 두 AbortSignal을 결합 (둘 중 하나라도 abort되면 abort) */
  private combineSignals(
    a?: AbortSignal,
    b?: AbortSignal,
  ): { signal?: AbortSignal; cleanup: () => void } {
    if (!a && !b) return { signal: undefined, cleanup: () => {} };

    const controller = new AbortController();

    const onAbortA = () => controller.abort();
    const onAbortB = () => controller.abort();

    try {
      if (a) a.addEventListener('abort', onAbortA);
      if (b) b.addEventListener('abort', onAbortB);
    } catch {
      // 안전: 일부 환경에서는 addEventListener가 실패할 수 있음
    }

    // 안전망: 우리 controller가 abort되면 a/b에서 리스너 제거
    const onControllerAbort = () => {
      try {
        if (a) a.removeEventListener('abort', onAbortA);
        if (b) b.removeEventListener('abort', onAbortB);
      } catch {}
    };
    controller.signal.addEventListener('abort', onControllerAbort);

    // 즉시 이미 abort된 signal이 있으면 controller도 abort
    if (a?.aborted || b?.aborted) controller.abort();

    const cleanup = () => {
      try {
        if (a) a.removeEventListener('abort', onAbortA);
        if (b) b.removeEventListener('abort', onAbortB);
      } catch {}
      try {
        controller.signal.removeEventListener('abort', onControllerAbort);
      } catch {}
    };

    return { signal: controller.signal, cleanup };
  }

  private normalizeReleaseDate(value?: string | Date): Date | null {
    if (!value) return null;
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value;
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private parsePublishedAt(text?: string): Date | null {
    if (!text) return null;
    const trimmed = text.trim();
    if (!trimmed) return null;

    const cleaned = trimmed
      .replace(/^streamed live on\s+/i, '')
      .replace(/^premiered\s+/i, '')
      .replace(/^released on\s+/i, '')
      .replace(/^published on\s+/i, '');

    const absolute = Date.parse(cleaned);
    if (!Number.isNaN(absolute)) {
      return new Date(absolute);
    }

    const relMatch = cleaned.match(
      /^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i,
    );
    if (relMatch) {
      const amount = Number(relMatch[1]);
      const unit = relMatch[2].toLowerCase();
      if (Number.isFinite(amount)) {
        const now = Date.now();
        const unitMs: Record<string, number> = {
          second: 1000,
          minute: 60 * 1000,
          hour: 60 * 60 * 1000,
          day: 24 * 60 * 60 * 1000,
          week: 7 * 24 * 60 * 60 * 1000,
          month: 30 * 24 * 60 * 60 * 1000,
          year: 365 * 24 * 60 * 60 * 1000,
        };
        const delta = unitMs[unit] ?? 0;
        if (delta > 0) {
          return new Date(now - amount * delta);
        }
      }
    }

    const relativeAlt = cleaned.match(/^(\d+)\s+(?:yrs?|years?)\s+ago$/i);
    if (relativeAlt) {
      const years = Number(relativeAlt[1]);
      if (Number.isFinite(years)) {
        const now = new Date();
        now.setFullYear(now.getFullYear() - years);
        return now;
      }
    }

    return null;
  }

  private parseDurationSeconds(text?: string): number | null {
    if (!text) return null;
    const trimmed = text.trim();
    if (!trimmed) return null;
    if (/live/i.test(trimmed)) return null;
    const parts = trimmed.split(':').map((p) => Number(p.trim()));
    if (parts.some((p) => Number.isNaN(p))) return null;
    let seconds = 0;
    if (parts.length === 3) {
      seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2) {
      seconds = parts[0] * 60 + parts[1];
    } else if (parts.length === 1) {
      seconds = parts[0];
    } else {
      return null;
    }
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  }

  private parseViewCount(text?: string): number | null {
    if (!text) return null;
    const normalized = text
      .toLowerCase()
      .replace(/views?/g, '')
      .replace(/watching now/g, '')
      .replace(/[•,]/g, '')
      .trim();

    if (!normalized) return null;
    if (/no views/.test(normalized)) return 0;

    const suffix = normalized.slice(-1);
    const hasSuffix = /[kmb]/.test(suffix);
    const numberPart = hasSuffix ? normalized.slice(0, -1).trim() : normalized;

    const value = Number(numberPart);
    if (!Number.isFinite(value)) return null;

    let multiplier = 1;
    if (hasSuffix) {
      if (suffix === 'k') multiplier = 1_000;
      else if (suffix === 'm') multiplier = 1_000_000;
      else if (suffix === 'b') multiplier = 1_000_000_000;
    }

    const result = value * multiplier;
    return Number.isFinite(result) ? result : null;
  }

  private normalizeForMatching(input: string): string {
    return (input || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private matchesOfficialName(
    channelNorm: string,
    officials: string[],
  ): boolean {
    if (!channelNorm) return false;
    return officials.some((name) =>
      channelNorm === name
        ? true
        : channelNorm.includes(name) || name.includes(channelNorm),
    );
  }

  private extractSeriesInfo(text: string): {
    base: string;
    suffix: string | null;
  } {
    const normalized = this.normalizeForMatching(text);
    if (!normalized) {
      return { base: '', suffix: null };
    }
    const match = normalized.match(
      /(.+?)\s+(?:part\s+)?((?:\d+)|(?:[ivxlcdm]+))$/i,
    );
    if (!match) {
      return { base: normalized, suffix: null };
    }
    const base = match[1].trim();
    const suffix = this.canonicalizeSeriesSuffix(match[2]);
    return { base, suffix };
  }

  private canonicalizeSeriesSuffix(raw: string | null): string | null {
    if (!raw) return null;
    const numeric = raw.match(/\d+/);
    if (numeric) return String(Number(numeric[0]));
    const roman = raw.match(/([ivxlcdm]+)/i);
    if (roman) {
      const value = this.romanToNumber(roman[1]);
      return value ? String(value) : roman[1].toLowerCase();
    }
    return raw.toLowerCase();
  }

  private romanToNumber(roman: string): number | null {
    const map: Record<string, number> = {
      i: 1,
      v: 5,
      x: 10,
      l: 50,
      c: 100,
      d: 500,
      m: 1000,
    };
    const chars = roman.toLowerCase().split('');
    let total = 0;
    for (let i = 0; i < chars.length; i++) {
      const value = map[chars[i]];
      const next = map[chars[i + 1]];
      if (!value) return null;
      if (next && next > value) total -= value;
      else total += value;
    }
    return total;
  }

  private isSeriesMismatch(
    slugInfo: { base: string; suffix: string | null },
    titleInfo: { base: string; suffix: string | null },
  ): boolean {
    if (!slugInfo.suffix || !titleInfo.suffix) return false;
    if (!slugInfo.base || !titleInfo.base) return false;
    return (
      slugInfo.base === titleInfo.base && slugInfo.suffix !== titleInfo.suffix
    );
  }

  public isDurationAcceptable(seconds?: number | null): boolean {
    if (seconds == null) return false;
    return (
      seconds >= this.minDurationSeconds && seconds <= this.maxDurationSeconds
    );
  }
}
