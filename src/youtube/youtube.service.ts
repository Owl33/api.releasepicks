import { Injectable, Logger } from '@nestjs/common';
import {
  YouTubeSearchItem,
  YouTubeSearchFilters,
  GameTrailerResult,
  ConfidenceLevel,
} from './youtube.types';
import * as https from 'https';

// ---------- 네트워크 안정화: IPv4 우선 + undici 글로벌 디스패처 ----------
try {
  // Node 18+: IPv4 우선
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dns = require('node:dns');
  if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
  }
} catch {}
try {
  // undici 글로벌 디스패처 (fetch 안정화)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Agent, setGlobalDispatcher } = require('undici');
  const dispatcher = new Agent({
    keepAliveTimeout: 15_000,
    keepAliveMaxTimeout: 7_500,
    headersTimeout: 8_000,
    bodyTimeout: 10_000,
    connectTimeout: 3_000,
    connections: 20,
  });
  setGlobalDispatcher(dispatcher);
} catch {}

// youtube-sr (quota-free)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const YouTube = require('youtube-sr').default;

type CacheEntry<T> = { data: T; at: number };
type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

const TTL_MS = 15 * 60 * 1000; // 성공/실패(실제 검색 시도 후)의 일반 캐시 TTL
const MAX_CACHE_SIZE = 200;

@Injectable()
export class YouTubeService {
  private readonly logger = new Logger(YouTubeService.name);

  /** 간단 TTL 캐시 (slug+filters → 결과/부재) */
  private cache = new Map<string, CacheEntry<GameTrailerResult | null>>();

  /** 재시도/실패 제어 (환경변수로 조절 가능) */
  // ➜ 요청 1건당 타임아웃(기본 3초). 많은 게임을 빠르게 훑어야 하므로 공격적으로 짧게.
  private readonly perRequestTimeoutMs = Number(
    process.env.YT_TIMEOUT_MS ?? 4_000,
  );
  // ➜ 전체 지연을 줄이기 위해 재시도 2회(총 2~3회 시도)
  private readonly maxRetries = Math.max(
    1,
    Number(process.env.YT_MAX_RETRIES ?? 2),
  );

  /** 서킷 브레이커 */
  private breakerState: BreakerState = 'CLOSED';
  private consecutiveFailures = 0;
  private breakerOpenUntil = 0; // epoch ms

  /** 연결 관리 (연속 실패 시 keepAlive 끄고 소켓 종료) */
  private agent: https.Agent = this.createAgent(true);
  private agentKeepAlive = true;

  /** 타이틀/행사/언어 키워드 (EN+KR) */
  private trailerKeywords = [
    // EN
    'official trailer',
    'trailer',
    'gameplay trailer',
    'launch trailer',
    'announcement trailer',
    'reveal trailer',
    'story trailer',
    'teaser',
    // KR
    '공식 트레일러',
    '트레일러',
    '게임플레이',
    '런치 트레일러',
    '발표 트레일러',
    '티저',
    // 이벤트/쇼케이스
    'state of play',
    'nintendo direct',
    'xbox showcase',
    'the game awards',
  ];

  /** 리뷰/실황/가이드 등 제외 키워드 */
  private excludeKeywords = [
    'review',
    'reaction',
    'walkthrough',
    'guide',
    'tips',
    'mod',
    'fan made',
    'speedrun',
    "let's play",
    'cutscene',
    'ending',
    'soundtrack',
    'ost',
    'analysis',
    'breakdown',
    'comparison',
    'remix',
    'meme',
    'parody',
    // 한국어
    '리뷰',
    '반응',
    '공략',
    '가이드',
    '모드',
    '실황',
    '속공략',
    '분석',
    '해설',
    '요약',
  ];

  /** 공식 채널 힌트 확장/정규화 */
  private officialChannelHints = [
    // 플랫폼/퍼스트파티
    'playstation',
    'ps',
    'xbox',
    'nintendo',
    // 퍼블리셔/개발사
    'bandai namco',
    'capcom',
    'ea',
    'electronic arts',
    'ubisoft',
    'square enix',
    'bethesda',
    'sega',
    'konami',
    'warner bros',
    'wb games',
    '2k',
    'take-two',
    'riot games',
    'blizzard',
    'cd projekt',
    'cd projekt red',
    'rockstar',
    'focus entertainment',
    'paradox',
    'koei tecmo',
    '505 games',
    'devolver',
    'tinybuild',
    'embracer',
    'gearbox',
    'thq nordic',
    // 인디/약칭
    'team cherry',
    'supergiant',
    'fromsoftware',
    'arc system works',
  ];

  // ============== Public API ==============

  /** 게임 슬러그(혹은 이름 비슷한 값)로 트레일러 1건 탐색 */
  async findOfficialTrailer(
    slug: string,
    filters: YouTubeSearchFilters = {},
  ): Promise<GameTrailerResult | null> {
    const startTime = Date.now(); // ✅ 전체 시작 시간
    const cacheKey = this.cacheKey(slug, filters);
    const cached = this.fromCache(cacheKey);
    if (cached !== undefined) return cached;

    // 브레이커 열려 있으면 즉시 스킵 (❗ 스킵 결과는 캐시하지 않음)
    if (this.isBreakerOpen()) {
      this.logger.warn(
        `[CB:OPEN] skip YouTube for '${slug}' until ${new Date(
          this.breakerOpenUntil,
        ).toISOString()}`,
      );
      return { slug, queryTried: [], picked: null };
    }

    const normalized = this.normalizeSlug(slug);
    const gameNames = this.buildNameVariants(normalized); // 쿼리 후보군

    const maxPerQuery = filters.maxResults ?? 5;
    const stopOnHighConfidence = true;
    const HIGH_CUTOFF = 0.85;

    // ✅ 추가: 호출 간 최소 지연 (기본 500ms, 필터로 오버라이드 가능)
    const MIN_DELAY_MS = 700;
    const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

    const seen = new Set<string>();
    let best: { score: number; item: YouTubeSearchItem } | null = null;

    const tried: string[] = [];
    try {
      // ✅ 변경: 쿼리 variant를 배열로 고정해 인덱스를 알 수 있게 함
      const queries = Array.from(this.buildQueryVariants(gameNames, filters));

      // ✅ 상세 로깅: 쿼리 개수 및 예상 시간
      this.logger.debug(
        `🔍 [YouTube:${slug}] 총 ${queries.length}개 쿼리 생성 (예상 시간: ${queries.length * 0.7}초)`,
      );

      let totalQueryTime = 0;
      let totalDelayTime = 0;

      // ✅ 점수 개선 추적 (연속 N번 개선 없으면 조기 종료)
      let lastBestScore = 0;
      let noImprovementCount = 0;
      const MAX_NO_IMPROVEMENT = 3; // 연속 3번 개선 없으면 종료

      for (let i = 0; i < queries.length; i++) {
        const q = queries[i];
        tried.push(q);

        // ✅ 쿼리 시작 시간
        const queryStartTime = Date.now();
        this.logger.debug(
          `  ⏱️  [${i + 1}/${queries.length}] 쿼리: "${q.substring(0, 50)}${q.length > 50 ? '...' : ''}"`,
        );

        const items = await this.searchYouTube(q, maxPerQuery);
        const queryDuration = Date.now() - queryStartTime;
        totalQueryTime += queryDuration;

        // ✅ 쿼리 결과 로깅
        this.logger.debug(
          `  ✅ [${i + 1}/${queries.length}] 완료: ${items.length}개 결과 (소요: ${queryDuration}ms)`,
        );

        for (const raw of items) {
          if (!raw.videoId || seen.has(raw.videoId)) continue;
          seen.add(raw.videoId);

          const score = this.scoreItemWithName(raw as any, normalized);
          if (!best || score > best.score) {
            best = { score, item: raw };
            // ✅ 베스트 업데이트 로깅
            this.logger.debug(
              `    🎯 새로운 최고 점수: ${score.toFixed(3)} - "${raw.title.substring(0, 40)}..."`,
            );
          }

          // 충분히 신뢰 가능하면 즉시 종료(불필요한 추가 호출 방지)
          if (stopOnHighConfidence && score >= HIGH_CUTOFF) {
            // ✅ 하이컨피던스 조기 종료 로깅
            this.logger.debug(
              `    ⚡ High confidence (${score.toFixed(3)} >= ${HIGH_CUTOFF}) 발견! 조기 종료 (${i + 1}/${queries.length} 쿼리 시도)`,
            );
            i = queries.length; // 바깥 for 탈출 유도
            break;
          }
        }

        // ✅ 점수 개선 체크 (연속 N번 개선 없으면 조기 종료)
        const currentBestScore = best?.score ?? 0;
        if (currentBestScore > lastBestScore) {
          // 점수 개선됨
          lastBestScore = currentBestScore;
          noImprovementCount = 0;
        } else {
          // 점수 개선 없음
          noImprovementCount++;
          if (noImprovementCount >= MAX_NO_IMPROVEMENT && best) {
            this.logger.debug(
              `    ⏹️  점수 개선 없음 (연속 ${noImprovementCount}번) - 조기 종료 (최고: ${best.score.toFixed(3)}, ${i + 1}/${queries.length} 쿼리 시도)`,
            );
            i = queries.length; // 바깥 for 탈출 유도
            break;
          }
        }

        // ✅ 다음 쿼리를 시도할 예정이면 호출 간 0.5초(기본) 대기
        if (
          i < queries.length - 1 &&
          !(stopOnHighConfidence && best && best.score >= HIGH_CUTOFF)
        ) {
          const delayStartTime = Date.now();
          await sleep(MIN_DELAY_MS);
          const delayDuration = Date.now() - delayStartTime;
          totalDelayTime += delayDuration;
        }
      }

      let picked = best ? this.toPicked(best.item, best.score) : null;
      // 최소 1건 보장(루프 중간 실패로 빠져도 best가 있으면 픽)
      if (!picked && best) picked = this.toPicked(best.item, best.score);

      const totalDuration = Date.now() - startTime;

      // ✅ 최종 요약 로깅
      this.logger.debug(
        `📊 [YouTube:${slug}] 완료 - 총 ${totalDuration}ms (쿼리: ${totalQueryTime}ms, 딜레이: ${totalDelayTime}ms, 기타: ${totalDuration - totalQueryTime - totalDelayTime}ms)`,
      );

      const result: GameTrailerResult = {
        slug,
        queryTried: tried,
        picked,
      };

      // 실제 검색을 시도한 결과는 캐시에 저장
      this.toCache(cacheKey, result);
      return result;
    } catch (e: any) {
      this.logger.error(
        `findOfficialTrailer failed for '${slug}': ${e?.message || e}`,
      );
      const result: GameTrailerResult = {
        slug,
        queryTried: tried,
        picked: null,
      };
      // 에러도 시도 결과이므로 네거티브 캐시(짧게 하고 싶으면 TTL_MS를 분리)
      this.toCache(cacheKey, result);
      return result;
    }
  }

  // ============== Internals ==============

  private normalizeSlug(s: string): string {
    let t = s.replace(/[-_]+/g, ' ').trim();
    // edition, remaster 등의 잡음 제거 (과한 제거 방지 위해 일부만)
    t = t
      .replace(
        /\b(remastered|definitive edition|ultimate edition|complete edition)\b/gi,
        '',
      )
      .trim();
    t = t.replace(/\s{2,}/g, ' ');
    return t;
  }

  private buildNameVariants(name: string): string[] {
    const opts = new Set<string>([name]);
    // ": Subtitle" → 공백으로
    opts.add(name.replace(/:\s+/g, ' '));
    // 괄호 제거/여백 정리
    opts.add(
      name
        .replace(/\(.*?\)/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim(),
    );
    return [...opts];
  }

  /** 한국어/행사/연도/부제 대응 쿼리 빌드 (✅ 최대 20개 제한) */
  private buildQueryVariants(
    names: string[],
    filters: YouTubeSearchFilters,
  ): string[] {
    const out: string[] = [];
    const langs = [filters.lang?.toLowerCase()].filter(Boolean) as string[];
    const regions = [filters.region?.toLowerCase()].filter(Boolean) as string[];
    const strict = !!filters.strictOfficial;

    // 이름 변형과 연도 추출
    const variants = new Set<string>();
    for (const n of names) {
      variants.add(n);
      variants.add(n.replace(/:\s+.*/, '')); // "X: Subtitle" → "X"
      variants.add(n.replace(/\(.*?\)/g, '').trim()); // 괄호 제거
      variants.add(n.replace(/\s{2,}/g, ' '));
    }

    const yearSet = new Set<number>();
    for (const v of variants) {
      const m = v.match(/\b(20\d{2}|19\d{2})\b/);
      if (m) yearSet.add(Number(m[1]));
    }

    // ✅ 우선순위 기반 쿼리 생성 (가장 효과적인 조합 우선)
    const EN_PRIORITY = [
      'official trailer',
      'gameplay trailer',
      'launch trailer',
      'announcement trailer',
    ];
    const KR_PRIORITY = [
      '공식 트레일러',
      '트레일러',
      '게임플레이',
    ];

    // ✅ Priority 1: 메인 이름 + 핵심 키워드만 (최대 8개)
    const mainName = Array.from(variants)[0]; // 가장 원본에 가까운 이름
    for (const kw of EN_PRIORITY) out.push(`${mainName} ${kw}`);
    for (const kw of KR_PRIORITY) out.push(`${mainName} ${kw}`);

    // ✅ Priority 2: 행사/쇼케이스 (최대 4개)
    out.push(`${mainName} state of play`);
    out.push(`${mainName} nintendo direct`);
    out.push(`${mainName} xbox showcase`);
    out.push(`${mainName} the game awards`);

    // ✅ Priority 3: 연도 조합 (최대 4개, 있을 때만)
    if (yearSet.size > 0) {
      const latestYear = Math.max(...Array.from(yearSet));
      out.push(`${mainName} ${latestYear} official trailer`);
      out.push(`${mainName} ${latestYear} 트레일러`);
    }

    // ✅ Priority 4: 언어/지역 힌트 (최대 4개)
    for (const L of langs) out.push(`${mainName} official trailer ${L}`);
    for (const R of regions) out.push(`${mainName} official trailer ${R}`);

    if (strict) out.push(`${mainName} "official trailer"`);

    // ✅ 최대 20개로 제한 (딜레이 0.7s × 20 = 14초 최대)
    return Array.from(new Set(out)).slice(0, 20);
  }

  /** youtube-sr 검색 + 재시도 + 타임아웃 + 브레이커 반영 */
  private async searchYouTube(
    query: string,
    max: number,
  ): Promise<YouTubeSearchItem[]> {
    if (this.isBreakerOpen()) {
      this.logger.warn(`[CircuitBreaker:OPEN] skip query='${query}'`);
      return [];
    }

    let lastErr: any = null;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        // 제네릭 any로 명시해 '{}' 추론 방지
        const raw: any = await this.runWithTimeout<any>(
          YouTube.search(query, { type: 'video', limit: max * 2 }),
          this.perRequestTimeoutMs,
        );

        this.onBreakerSuccess();

        // 배열 보장 (+ 버전에 따른 videos/results 경로도 점검)
        let list: any[] = [];
        if (Array.isArray(raw)) {
          list = raw;
        } else if (raw && typeof raw === 'object') {
          if (Array.isArray(raw.videos)) list = raw.videos;
          else if (Array.isArray(raw.results)) list = raw.results;
        }

        const mapped: YouTubeSearchItem[] = list.map((v: any) => ({
          videoId: v?.id,
          title: String(v?.title ?? ''),
          description: String(v?.description ?? ''),
          thumbnailUrl: v?.thumbnails?.[0]?.url ?? '',
          publishedAt: this.toIsoDate(v?.uploadedAt, v?.uploadedTimestamp),
          channelId: v?.channel?.id ?? '',
          channelTitle: v?.channel?.name ?? '',
          durationSec:
            typeof v?.duration === 'number'
              ? v.duration
              : typeof v?.duration?.seconds === 'number'
                ? v.duration.seconds
                : undefined,
          // (옵션) 조회수 필드가 있으면 사용
          // @ts-ignore
          ...(typeof v?.views === 'number' ? { views: v.views } : {}),
          url:
            v?.url ?? (v?.id ? `https://www.youtube.com/watch?v=${v.id}` : ''),
        }));

        return mapped.slice(0, max);
      } catch (e: any) {
        lastErr = e;
        this.onBreakerFailure(e);

        const msg = e?.message || String(e);
        this.logger.warn(
          `YouTube.search failed (attempt ${attempt}/${this.maxRetries}): ${msg}`,
        );

        if (attempt < this.maxRetries) {
          const delay = this.backoffDelay(attempt);
          await this.sleep(delay);
        }
      }
    }

    throw lastErr ?? new Error('YouTube.search failed');
  }

  /** 간단한 정규화 */
  private normalize(text: string): string {
    return (text || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  private jaccard(a: string, b: string): number {
    const A = new Set(
      this.normalize(a)
        .split(' ')
        .filter((w) => w.length > 1),
    );
    const B = new Set(
      this.normalize(b)
        .split(' ')
        .filter((w) => w.length > 1),
    );
    if (A.size === 0 || B.size === 0) return 0;
    let inter = 0;
    for (const w of A) if (B.has(w)) inter++;
    return inter / (A.size + B.size - inter);
  }

  /** 기본 스코어(키워드/채널/시점/길이/조회수/제외패널티) */
  private scoreItem(
    v: YouTubeSearchItem & { durationSec?: number; views?: number },
  ): number {
    let score = 0;

    const title = this.normalize(v.title);
    const channel = this.normalize(v.channelTitle);

    // 1) 키워드 매칭 (EN/KR 모두)
    for (const kw of this.trailerKeywords) {
      if (title.includes(this.normalize(kw))) score += 0.25;
    }
    if (/\btrailer\b/.test(title)) score += 0.15;
    if (title.includes('official') || title.includes('공식')) score += 0.15;

    // 2) 제외 키워드 패널티(강함)
    for (const bad of this.excludeKeywords) {
      if (title.includes(this.normalize(bad))) {
        score -= 0.5;
        break;
      }
    }

    // 3) 공식 채널 힌트
    for (const hint of this.officialChannelHints) {
      if (channel.includes(this.normalize(hint))) {
        score += 0.25;
        break;
      }
    }

    // 4) 업로드 시점 (최근 가점/과거 감점)
    const ts = Date.parse(v.publishedAt);
    if (!isNaN(ts)) {
      const ageDays = (Date.now() - ts) / 86_400_000;
      if (ageDays < 365 * 3) score += 0.1;
      if (ageDays > 365 * 8) score -= 0.1;
    }

    // 5) 길이/조회수 휴리스틱 (있을 때만)
    if (typeof v.durationSec === 'number') {
      if (v.durationSec >= 30 && v.durationSec <= 360)
        score += 0.1; // 0:30~6:00
      else score -= 0.05;
    }
    if (typeof (v as any).views === 'number') {
      const views = (v as any).views as number;
      if (views > 1_000_000) score += 0.1;
      else if (views > 100_000) score += 0.05;
    }

    return Math.min(1, Math.max(0, score));
  }

  /** 게임명 유사도 가중까지 포함한 스코어 */
  private scoreItemWithName(
    v: YouTubeSearchItem & { durationSec?: number; views?: number },
    gameName: string,
  ): number {
    const base = this.scoreItem(v);
    const sim = this.jaccard(v.title, gameName); // 0~1
    const bonus =
      sim >= 0.6 ? 0.25 : sim >= 0.4 ? 0.15 : sim >= 0.25 ? 0.08 : 0;
    return Math.min(1, Math.max(0, base + bonus));
  }

  private toPicked(
    v: YouTubeSearchItem,
    score: number,
  ): GameTrailerResult['picked'] {
    const isOfficial =
      /official/.test((v.title || '').toLowerCase()) ||
      (v.title || '').includes('공식') ||
      this.officialChannelHints.some((h) =>
        (v.channelTitle || '').toLowerCase().includes(h),
      );

    const confidence: ConfidenceLevel =
      score >= 0.85 ? 'high' : score >= 0.6 ? 'medium' : 'low';

    return {
      videoId: v.videoId,
      url: v.url,
      title: v.title,
      description: v.description,
      thumbnailUrl: v.thumbnailUrl,
      publishedAt: v.publishedAt,
      channelTitle: v.channelTitle,
      isOfficialTrailer: !!isOfficial,
      confidence,
      score,
    };
  }

  // ---------- Circuit breaker helpers ----------

  private isBreakerOpen(): boolean {
    if (this.breakerState === 'OPEN') {
      if (Date.now() >= this.breakerOpenUntil) {
        // HALF_OPEN으로 전환 (시험 요청 1회 허용)
        this.breakerState = 'HALF_OPEN';
        this.logger.warn('[CircuitBreaker] transition OPEN -> HALF_OPEN');
        return false;
      }
      return true;
    }
    return false;
  }

  private onBreakerFailure(err: any) {
    this.consecutiveFailures += 1;

    // 네트워크/타임아웃류만 브레이커 카운트
    const msg = (err?.message || '').toLowerCase();
    const isNetError =
      msg.includes('fetch failed') ||
      msg.includes('timeout') ||
      msg.includes('network') ||
      msg.includes('socket hang up') ||
      msg.includes('getaddrinfo') ||
      msg.includes('tls');

    if (!isNetError) return;

    if (this.consecutiveFailures >= 5 && this.breakerState !== 'OPEN') {
      this.breakerState = 'OPEN';
      this.breakerOpenUntil = Date.now() + 2 * 60 * 1000; // 2분
      this.logger.error(
        '[CircuitBreaker] OPEN (failures >= 5). Pausing YouTube calls for 2m.',
      );

      try {
        this.agent.destroy();
      } catch {}
      // keepAlive 끈 에이전트로 교체
      this.agentKeepAlive = false;
      this.agent = this.createAgent(false);
    }
  }

  private onBreakerSuccess() {
    if (this.breakerState !== 'CLOSED') {
      this.logger.log(`[CircuitBreaker] ${this.breakerState} -> CLOSED`);
    }
    this.breakerState = 'CLOSED';
    this.consecutiveFailures = 0;

    // 정상화 → keepAlive 재활성
    if (!this.agentKeepAlive) {
      try {
        this.agent.destroy();
      } catch {}
      this.agentKeepAlive = true;
      this.agent = this.createAgent(true);
    }
  }

  // ---------- Cache helpers ----------

  private cacheKey(slug: string, filters: YouTubeSearchFilters): string {
    return JSON.stringify({
      slug: slug.toLowerCase(),
      max: filters.maxResults ?? 5,
      lang: filters.lang ?? '',
      region: filters.region ?? '',
      strict: !!filters.strictOfficial,
    });
  }

  private fromCache(key: string): GameTrailerResult | null | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at > TTL_MS) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.data; // null도 캐싱(negative caching)
  }

  private toCache(key: string, data: GameTrailerResult | null): void {
    if (this.cache.size > MAX_CACHE_SIZE) {
      const first = this.cache.keys().next().value;
      if (first) this.cache.delete(first);
    }
    this.cache.set(key, { data, at: Date.now() });
  }

  // ---------- Utils ----------

  private toIsoDate(_uploadedAtText?: string, uploadedTs?: number): string {
    if (
      typeof uploadedTs === 'number' &&
      Number.isFinite(uploadedTs) &&
      uploadedTs > 0
    ) {
      return new Date(uploadedTs).toISOString();
    }
    // youtube-sr의 uploadedAt("2 years ago") 같은 상대값은 정확 파싱이 어려우므로 현재시각으로 대체
    return new Date().toISOString();
  }

  private runWithTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout;
    return new Promise<T>((resolve, reject) => {
      const onTimeout = () => reject(new Error(`timeout of ${ms}ms exceeded`));
      timer = setTimeout(onTimeout, ms);
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  private backoffDelay(attempt: number): number {
    // 짧은 전체 지연을 위해 소형 백오프: 0.3s, 0.6s, 1.2s
    const base = 300 * Math.pow(2, attempt - 1);
    const jitter = Math.floor(Math.random() * 200) - 100;
    return Math.max(150, base + jitter);
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }

  private createAgent(keepAlive: boolean) {
    return new https.Agent({
      keepAlive,
      maxSockets: 20,
    });
  }
}
