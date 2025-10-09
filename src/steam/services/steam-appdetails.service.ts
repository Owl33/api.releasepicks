import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { setTimeout as sleep } from 'timers/promises';
import { SteamReleaseDateRaw } from '../../entities/enums';
import { getGlobalRateLimiter } from '../../common/concurrency/global-rate-limiter';
import {
  rateLimitMonitor,
  RateLimitExceededError,
} from '../../common/concurrency/rate-limit-monitor';
import { FixedWindowRateLimiter } from '../../common/concurrency/fixed-window-rate-limiter';

/**
 * Steam AppDetails 서비스
 * FINAL-ARCHITECTURE-DESIGN Phase 1 구현
 *
 * 역할: Steam Store API를 통한 개별 게임 상세정보 수집
 * 특징: Rate Limit 적용, 가격/출시일/스크린샷 등 수집
 */
@Injectable()
export class SteamAppDetailsService {
  private readonly logger = new Logger(SteamAppDetailsService.name);
  private readonly steamStoreUrl = 'https://store.steampowered.com/api';
  private readonly globalLimiter = getGlobalRateLimiter();
  private readonly spacingMs: number;
  private readonly rateLimiter: FixedWindowRateLimiter;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.spacingMs = Number(
      this.configService.get<string>('STEAM_APPDETAILS_SPACING_MS') ?? '150',
    );
    const maxPerWindow = Number(
      this.configService.get<string>('STEAM_APPDETAILS_WINDOW_MAX') ?? '200',
    );
    const windowSeconds = Number(
      this.configService.get<string>('STEAM_APPDETAILS_WINDOW_SECONDS') ??
        '310',
    );
    this.rateLimiter = new FixedWindowRateLimiter(
      maxPerWindow,
      windowSeconds * 1000,
    );
  }

  /**
   * Steam AppDetails 조회
   * API: https://store.steampowered.com/api/appdetails?appids={appid}
   *
   * @param appId Steam AppID
   * @returns Steam 게임 상세정보
   */
  async fetchAppDetails(appId: number): Promise<SteamAppDetails | null> {
    try {
      // Rate Limiting
      const primary = await this.requestAppDetails(appId, {
        cc: 'kr',
        lang: 'korean',
      });

      if (primary) {
        rateLimitMonitor.reportSuccess('steam:details');
        return primary;
      }

      return null;
    } catch (error: any) {
      // 429 에러 (Rate Limit) 특별 처리
      if (error.response?.status === 429) {
        this.logger.error(
          `🚨 AppDetails Rate Limit 초과 (429) - AppID ${appId}`,
        );
        // 429 발생 시 더 긴 지연 적용 (1초 추가 대기)
        await sleep(1000);
        this.globalLimiter.backoff('steam:details', 0.5, 30_000);

        const { pauseMs, exceeded } = rateLimitMonitor.report429(
          'steam:details',
          30_000,
        );
        this.logger.warn(`⏸️ AppDetails 429 → ${pauseMs}ms 대기`);
        await sleep(pauseMs);

        if (exceeded) {
          throw new RateLimitExceededError('steam:details');
        }
        return null;
      }

      if (error.response?.status === 403) {
        this.logger.warn(
          `🚧 AppDetails 403 (Access Denied) - AppID ${appId} → fallback en-US`,
        );
        try {
          const fallback = await this.requestAppDetails(appId, {
            cc: 'us',
            lang: 'english',
          });
          if (fallback) {
            rateLimitMonitor.reportSuccess('steam:details');
            return fallback;
          }
        } catch (fallbackError: any) {
          this.logger.error(
            `❌ AppDetails fallback 실패 - AppID ${appId}: ${fallbackError?.message ?? fallbackError}`,
          );
        }
      }

      this.logger.error(
        `❌ Steam AppDetails 실패 - AppID ${appId}: ${error.message}`,
      );
      return null;
    }
  }

  private async requestAppDetails(
    appId: number,
    opts: { cc: string; lang: string },
  ): Promise<SteamAppDetails | null> {
    await rateLimitMonitor.waitIfPaused('steam:details');
    await this.rateLimiter.take();
    if (this.spacingMs > 0) {
      const jitter = Math.floor(
        Math.random() * Math.max(1, this.spacingMs / 2),
      );
      await sleep(this.spacingMs + jitter);
    }
    const url = `${this.steamStoreUrl}/appdetails`;
    const requestStart = Date.now();
    const response = await firstValueFrom(
      this.httpService.get(url, {
        params: {
          appids: appId,
          cc: opts.cc,
          l: opts.lang,
        },
        timeout: 10000,
        headers: this.buildRequestHeaders(opts.lang),
      }),
    );

    const requestDuration = Date.now() - requestStart;
    this.logger.debug(
      `    ⏱️  HTTP 요청(${opts.cc}/${opts.lang}): ${requestDuration}ms`,
    );

    const appData = response.data?.[appId];
    if (!appData?.success || !appData?.data) {
      this.logger.warn(`⚠️ Steam AppDetails 없음: AppID ${appId}`);
      return null;
    }

    const data = appData.data;

    if (!this.isGameType(data)) {
      this.logger.debug(`📋 게임이 아님: AppID ${appId} (${data.type})`);
      return null;
    }

    return this.parseAppDetails(data);
  }

  private buildRequestHeaders(lang: string) {
    const language =
      lang === 'korean'
        ? 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
        : 'en-US,en;q=0.9';
    return {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
      'Accept-Language': language,
      Accept: 'application/json, */*;q=0.8',
    };
  }

  /**
   * Steam 데이터를 파싱하여 구조화
   */
  private parseAppDetails(data: any): SteamAppDetails {
    const sexual = this.detectSexual(data);

    return {
      steam_appid: data.steam_appid,
      name: data.name,
      type: data.type,
      fullgame: data.fullgame || {},

      // 출시 정보
      release_date: data.release_date,
      coming_soon: data.release_date?.coming_soon || false,

      // 기본 정보
      short_description: data.short_description,
      detailed_description: data.detailed_description,
      website: data.website || null,

      // 미디어
      header_image: data.header_image ?? data.capsule_image,
      screenshots:
        data.screenshots?.slice(0, 5).map((s: any) => s.path_full) || [],
      movies: data.movies?.slice(0, 1).map((m: any) => m.mp4?.max) || [],

      // 분류
      genres: data.genres?.map((g: any) => g.description) || [],
      categories: data.categories?.map((c: any) => c.description) || [],

      // 회사 정보
      developers: data.developers || [],
      publishers: data.publishers || [],

      // 가격 정보
      price_overview: this.parsePriceOverview(data.price_overview),
      is_free: data.is_free || false,

      // 플랫폼 지원
      platforms: this.parsePlatforms(data.platforms),

      // 지원 언어
      supported_languages: this.parseLanguages(data.supported_languages),

      // 메타크리틱 점수
      metacritic: data.metacritic?.score || null,

      // 🔸 성인향(섹스 중심) 판정
      sexual,
    };
  }

/**
 * 성인향(섹스 중심) 판정 로직
 * - AO 표현은 즉시 true
 * - notes에 sexual/nudity 계열이 있고, 본문 강한 키워드 점수가 2점 이상이면 true
 * - 나이등급/경고(notes)는 본문 스코어에서 완전 배제 (IMMORTALITY, GTA V 오탐 방지)
 */

  /** 메인 판별 함수 */
  private detectSexual(data: any): boolean {
    // ── 필드 수집
    const notesRaw = String(data?.content_descriptors?.notes ?? "");
    const bodyRaw = [
      data?.mature_content_description ?? "", // 스팀의 경고 본문도 종종 들어오는데, 이건 body로 볼지 옵션
      data?.short_description ?? "",
      data?.detailed_description ?? "",
      data?.about_the_game ?? "",
    ].join(" ");

    // ── 정규화
    const textNotes = this.normalizeText(notesRaw); // ← notes는 '조건' 판정에만 사용
    const textBody = this.normalizeText(bodyRaw);   // ← 본문 스코어링은 여기서만!

    // ── (선택) AAA 감점
    const ALLOW_AAA_BIAS = false;
    let bias = 0;
    if (ALLOW_AAA_BIAS) {
      const publisher = this.arrayOrStr(data?.publishers ?? data?.publisher).toLowerCase();
      const developers = this.arrayOrStr(data?.developers ?? data?.developer).toLowerCase();
      const franchise = String(data?.franchise ?? "").toLowerCase();
      const isAAA = /(rockstar|atlus|bethesda|ubisoft|electronic\s*arts|ea|capcom|square\s*enix|nintendo|sony|microsoft|bandai\s*namco)/.test(
        `${publisher} ${developers} ${franchise}`,
      );
      if (isAAA) bias -= 1;
    }

    // ── 태그/카테고리 점수 (태그만으로 true는 금지)
    const tags: string[] = this.toLowerList(data?.tags);
    const categories: string[] = this.toLowerList(
      (data?.categories ?? []).map((c: any) => c?.description ?? c),
    );

    const DECISIVE_TAGS = new Set(["hentai", "eroge", "adult only", "nsfw", "r18"]); // +3
    const STRONG_TAGS = new Set(["sexual content", "nudity"]); // 둘 다 있어도 총 +2

    let score = 0;

    const hasDecisiveTag =
      tags.some((t) => DECISIVE_TAGS.has(t)) ||
      categories.some((c) => DECISIVE_TAGS.has(c));
    if (hasDecisiveTag) score += 3;

    const hasStrongTag =
      tags.some((t) => STRONG_TAGS.has(t)) ||
      categories.some((c) => STRONG_TAGS.has(c));
    if (hasStrongTag) score += 2;

    // ── 2) 성인 전용 지표(트리거 A): 하나라도 있으면 즉시 true
    //     (본문만 검사. notes는 사용하지 않음)
    const adultOnlySignals: RegExp[] = [
      /\bhentai\b/,
      /\beroge\b/,
      /\buncensored\b/,
      /\bh-?cg\b/,
      /\bpornographic?\b/,
      /\badult\s+only\b/,
      /\br18\b/,
      /성인\s*전용/,
      /(r18|성인)\s*패치/,
      /무수정|무삭제/,
      /야애니/,
    ];
    if (adultOnlySignals.some((rx) => rx.test(textBody))) return true;

    // ── 3) 본문 강/약 신호 (※ notes 제외!)
    const STRONG_BODY: RegExp[] = [
      /\bsexual\s+content\b/,
      /\bnudity\b/,
      /\bnudes?\b/,
      /\bsex\s*(?:scenes?|acts?)\b/,
      /\blewd\b/,
      /성(?:적)?\s*콘텐츠/,
      /노출|누드/,
      /에로|야함|에치|에찌/,
    ];
    const WEAK_BODY: RegExp[] = [
      /\bsexy\b/,
      /\bharem\b/,
      /연애\s*이벤트|하렘|섹시/,
    ];

    const strongHitsFromBody = STRONG_BODY.filter((rx) => rx.test(textBody)).length;
    if (strongHitsFromBody > 0) score += 2; // 1개 이상 존재 시 +2
    if (WEAK_BODY.some((rx) => rx.test(textBody))) score += 1;

    // ── 4) 근접 강화: 성적 키워드와 cg/패치/무수정/r18 등이 80자 내 동시 등장 시 +1 (※ 본문만)
    const proxPairs: [RegExp, RegExp][] = [
      [
        /(sex|sexual|성적|에로|야함|hentai|lewd|노출|누드)/,
        /(gallery|cg|패치|uncensored|무수정|r18)/,
      ],
    ];
    if (this.hasProximity(textBody, proxPairs, 80)) score += 1;

    // ── 5) 안내/면책 문구는 중립 (점수 변화 없음) — 감지만 하고 no-op
    // const disclaimers = [/성적인?\s*콘텐츠[^.]{0,40}18\s*세\s*이상/, /all\s*characters[^.]{0,40}(18\+|over\s*18)/];

    // ── 6) 비노골/예술 표현 완화 (IMMORTALITY 대응)
    //     'non-graphic|brief|partial|non-explicit|artistic' 가 sexual/nudity 주변(±60자)에 있으면 -2
    if (this.softenNearSexual(textBody, 60)) score -= 2;

    // ── 7) FMV/영화형 장르 감점 (성인 전용 지표 없을 때만)
    const isFMV =
      /(fmv|interactive\s+(movie|film)|narrative\s+adventure|cinematic)/.test(textBody);
    if (isFMV) score -= 1;

    // ── 8) AAA 바이어스
    score += bias;

    // ── 9) 트리거 B: 본문 강 신호 2개 이상이 서로 근접(≤80자)해야 true (태그/notes로는 불가)
    const triggerB =
      strongHitsFromBody >= 2 &&
      this.hasProximity(
        textBody,
        [[/sexual|성적|노출|누드|sex|nudity/, /content|콘텐츠|scenes?|acts?|패치|cg/]],
        80,
      );
    if (triggerB) return true;

    // ── 10) notes + 본문 결합 트리거 (네가 명시한 규칙)
    // notes에 sexual/nudity 계열이 있고, "본문 강키워드 점수 ≥ 2"면 true
    const notesHasSexual =
      /(sexual\s*content|nudity|노출|누드|성(?:적)?\s*콘텐츠)/.test(textNotes);
    // strongHitsFromBody>0 일 때 +2를 이미 부여했으므로, 여기선 "강키워드가 1개 이상"이면 true로 봄
    if (notesHasSexual && strongHitsFromBody >= 1) return true;

    // ── 11) 누적 임계치
    return score >= 4;
  }

  /** HTML/URL/파일명 제거 + 소문자화 + 공백 정리 */
  private normalizeText(html: string): string {
    return String(html)
      // URL/파일 경로 제거
      .replace(/https?:\/\/\S+/gi, " ")
      .replace(/\b[\w\-\/]+\.(jpg|jpeg|png|gif|webm|mp4|avif|apng|webp)\b/gi, " ")
      // HTML 제거
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      // 공백 정리 & 소문자
      .replace(/\s+/g, " ")
      .toLowerCase()
      .trim();
  }

  /** 배열/문자 뒤섞인 필드 → 문자열 배열(lowercase는 호출부에서) */
  private toLowerList(v: any): string[] {
    if (!v) return [];
    const arr = Array.isArray(v) ? v : [v];
    return arr
      .map((x) => (x == null ? "" : String(x)))
      .map((s) => s.toLowerCase().trim())
      .filter(Boolean);
  }

  /** 두 패턴이 maxGap 이내에 공존하는지 (본문에서만 사용) */
  private hasProximity(text: string, pairs: [RegExp, RegExp][], maxGap: number): boolean {
    for (const [a, b] of pairs) {
      const aGlobal = new RegExp(a.source, a.flags.includes("g") ? a.flags : a.flags + "g");
      let m: RegExpExecArray | null;
      while ((m = aGlobal.exec(text))) {
        const aIdx = m.index;
        const start = Math.max(0, aIdx - maxGap);
        const end = Math.min(text.length, aIdx + maxGap);
        const slice = text.slice(start, end);
        if (b.test(slice)) return true;
      }
    }
    return false;
  }

  /** 'non-graphic|brief|partial|non-explicit|artistic' 가 sexual/nudity 주변(±gap)에 존재하면 true */
  private softenNearSexual(text: string, gap = 60): boolean {
    const SOFTEN = /(non[-\s]?graphic|brief|partial|non[-\s]?explicit|artistic)/;
    const SEXUAL = /(sexual|sex|nudity|누드|노출|성적)/;
    const sexualG = new RegExp(SEXUAL.source, SEXUAL.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = sexualG.exec(text))) {
      const idx = m.index;
      const start = Math.max(0, idx - gap);
      const end = Math.min(text.length, idx + gap);
      if (SOFTEN.test(text.slice(start, end))) return true;
    }
    return false;
  }

  /** 문자열/문자열배열을 공백으로 연결 */
  private arrayOrStr(v: any): string {
    if (!v) return "";
    return Array.isArray(v) ? v.join(" ") : String(v);
  }


  private htmlToText(html: string): string {
    return html
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  private countHits(text: string, patterns: string[]): number {
    let n = 0;
    for (const p of patterns) {
      if (text.includes(p)) n++;
    }
    return n;
  }

  /**
   * 출시일 정보 파싱 (현재 미사용: 필요 시 교체)
   */
  private parseReleaseDate(releaseDate: any): Date | null {
    if (!releaseDate?.date) return null;
    try {
      const dateStr = releaseDate.date.replace(/,/g, '');
      return new Date(dateStr);
    } catch {
      return null;
    }
  }

  /**
   * 가격 정보 파싱
   */
  private parsePriceOverview(priceOverview: any) {
    if (!priceOverview) return null;

    return {
      initial: priceOverview.initial,
      final: priceOverview.final,
      discount_percent: priceOverview.discount_percent,
      initial_formatted: priceOverview.initial_formatted,
      final_formatted: priceOverview.final_formatted,
    };
  }

  /**
   * 플랫폼 지원 정보 파싱
   */
  private parsePlatforms(platforms: any): string[] {
    if (!platforms) return [];

    const supportedPlatforms: string[] = [];
    if (platforms.windows) supportedPlatforms.push('pc');
    if (platforms.mac) supportedPlatforms.push('mac');
    if (platforms.linux) supportedPlatforms.push('linux');

    return supportedPlatforms;
  }

  /**
   * 지원 언어 파싱
   */
  private parseLanguages(languages?: string): string[] {
    if (!languages) return [];

    // 1) <br> 이후의 각주/설명은 잘라낸다
    const beforeBreak = languages.split(/<br\s*\/?>/i)[0] ?? languages;

    // 2) 남은 HTML 태그 제거
    const plain = beforeBreak.replace(/<[^>]+>/g, '');

    // 3) 콤마로 분리 후 공백 제거
    const parts = plain
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    // 4) 언어 토큰 끝에 붙은 각주(*) 제거
    const cleaned = parts.map((s) => s.replace(/\*+$/g, '').trim());

    // 5) 중복 제거, 최대 10개 제한
    const dedup: string[] = [];
    for (const lang of cleaned) {
      if (!dedup.includes(lang)) dedup.push(lang);
    }
    return dedup.slice(0, 10);
  }

  /**
   * 게임 타입 여부 확인
   */
  private isGameType(data: any): boolean {
    const validTypes = ['game', 'dlc'];
    return validTypes.includes((data.type ?? '').toLowerCase());
  }
}

/**
 * Steam AppDetails 인터페이스
 */
export interface SteamAppDetails {
  fullgame: any;
  steam_appid: number;
  name: string;
  type: string;

  // 출시 정보
  release_date: SteamReleaseDateRaw;
  coming_soon: boolean;

  // 기본 정보
  short_description?: string;
  detailed_description?: string;
  website?: string | null;

  // 미디어
  header_image: string;
  screenshots: string[];
  movies: string[];

  // 분류
  genres: string[];
  categories: string[];

  // 회사 정보
  developers: string[];
  publishers: string[];

  // 가격 정보
  price_overview: any;
  is_free: boolean;

  // 플랫폼
  platforms: string[];

  // 지원 언어
  supported_languages: string[];

  // 메타크리틱
  metacritic: number | null;

  // 🔸 성인향(섹스 중심) 플래그
  sexual: boolean;
}
