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
  private readonly windowMs: number;
  private readonly maxEvents: number;
  private readonly rateLimiter: FixedWindowRateLimiter;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    const configuredMax = Number(
      this.configService.get<string>('STEAM_APPDETAILS_WINDOW_MAX') ?? '200',
    );
    const maxPerWindow =
      Number.isFinite(configuredMax) && configuredMax > 0
        ? Math.min(configuredMax, 200)
        : 200;
    if (Number.isFinite(configuredMax) && configuredMax > 200) {
      this.logger.warn(
        `⚠️ AppDetails 최대 호출 수(${configuredMax})가 5분 200회 제한을 초과하여 200으로 보정합니다.`,
      );
    }
    this.maxEvents = maxPerWindow;

    const configuredWindowSeconds = Number(
      this.configService.get<string>('STEAM_APPDETAILS_WINDOW_SECONDS') ??
        '300',
    );
    const windowSeconds =
      Number.isFinite(configuredWindowSeconds) && configuredWindowSeconds > 0
        ? configuredWindowSeconds
        : 300;
    const windowMs = Math.round(windowSeconds * 1000);
    this.windowMs = windowMs;
    const derivedSpacing = Math.ceil(windowMs / maxPerWindow);
    const configuredSpacing = Number(
      this.configService.get<string>('STEAM_APPDETAILS_SPACING_MS') ??
        `${derivedSpacing}`,
    );
    const spacingCandidate =
      Number.isFinite(configuredSpacing) && configuredSpacing >= 0
        ? configuredSpacing
        : derivedSpacing;
    this.spacingMs = Math.max(spacingCandidate, derivedSpacing);
    if (spacingCandidate < derivedSpacing) {
      this.logger.warn(
        `⚠️ AppDetails 최소 간격(${spacingCandidate}ms)이 5분 200회 제한을 충족하지 않아 ${this.spacingMs}ms로 보정됩니다.`,
      );
    }

    // Rate Limiter에 spacing을 통합하여 완벽한 제어
    // spacing은 Rate Limiter 내부에서 처리되므로 별도 sleep 불필요
    this.rateLimiter = new FixedWindowRateLimiter(
      this.maxEvents,
      this.windowMs,
      this.spacingMs, // 최소 간격을 Rate Limiter에 전달
    );
    this.logger.log(
      `♻️ AppDetails Rate Limit 구성: ${this.maxEvents}회/${(
        this.windowMs / 1000
      ).toFixed(0)}초, spacing=${this.spacingMs}ms`,
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
        this.globalLimiter.backoff('steam:details', 1, 30_000);

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

  async fetchAppDetailsWithLanguage(
    appId: number,
    opts: { cc: string; lang: string },
  ): Promise<SteamAppDetails | null> {
    try {
      return await this.requestAppDetails(appId, opts);
    } catch (error: any) {
      this.logger.warn(
        `⚠️ Steam AppDetails 언어별 요청 실패 - AppID ${appId} (${opts.cc}/${opts.lang}): ${error?.message ?? error}`,
      );
      return null;
    }
  }

  private async requestAppDetails(
    appId: number,
    opts: { cc: string; lang: string },
  ): Promise<SteamAppDetails | null> {
    await rateLimitMonitor.waitIfPaused('steam:details');

    // Rate Limiter가 spacing + 윈도우 제한을 모두 처리
    // 이제 별도의 sleep이 필요 없음
    await this.rateLimiter.take();

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
    // this.logger.debug(
    //   `    ⏱️  HTTP 요청(${opts.cc}/${opts.lang}): ${requestDuration}ms`,
    // );

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
    const appId = Number(data?.steam_appid ?? 0);
    const title = String(data?.name ?? '');
    const signals: string[] = [];

    // ── 필드 수집
    const notesRaw = String(data?.content_descriptors?.notes ?? '');
    const bodyRaw = [
      data?.mature_content_description ?? '', // 스팀의 경고 본문도 종종 들어오는데, 이건 body로 볼지 옵션
      data?.short_description ?? '',
      data?.detailed_description ?? '',
      data?.about_the_game ?? '',
    ].join(' ');

    const descriptorIds: number[] = Array.isArray(
      data?.content_descriptors?.ids,
    )
      ? (data.content_descriptors.ids as any[])
          .map((value) => {
            const numeric = Number(value);
            return Number.isFinite(numeric) ? numeric : null;
          })
          .filter((value): value is number => value !== null)
      : [];
    const SEXUAL_DESCRIPTOR_IDS = new Set<number>([3, 4]);
    const MATURE_DESCRIPTOR_IDS = new Set<number>([5]);
    const hasSexualDescriptor = descriptorIds.some((id) =>
      SEXUAL_DESCRIPTOR_IDS.has(id),
    );
    const hasMatureDescriptor = descriptorIds.some((id) =>
      MATURE_DESCRIPTOR_IDS.has(id),
    );

    // ── 정규화
    const textNotes = this.normalizeText(notesRaw); // ← notes는 '조건' 판정에만 사용
    const textBody = this.normalizeText(bodyRaw); // ← 본문 스코어링은 여기서만!
    const ratingsRaw = this.normalizeText(
      Object.values<any>(data?.ratings ?? {})
        .map((rating) =>
          [rating?.descriptors ?? '', rating?.rating ?? ''].join(' '),
        )
        .join(' '),
    );

    if (hasSexualDescriptor) {
      this.logSexualDecision(appId, title, true, 'descriptor_3/4', {
        score: 0,
        strongHits: 0,
        signals: ['descriptor:3/4'],
      });
      return true;
    }

    // ── (선택) AAA 감점
    const ALLOW_AAA_BIAS = false;
    let bias = 0;
    if (ALLOW_AAA_BIAS) {
      const publisher = this.arrayOrStr(
        data?.publishers ?? data?.publisher,
      ).toLowerCase();
      const developers = this.arrayOrStr(
        data?.developers ?? data?.developer,
      ).toLowerCase();
      const franchise = String(data?.franchise ?? '').toLowerCase();
      const isAAA =
        /(rockstar|atlus|bethesda|ubisoft|electronic\s*arts|ea|capcom|square\s*enix|nintendo|sony|microsoft|bandai\s*namco)/.test(
          `${publisher} ${developers} ${franchise}`,
        );
      if (isAAA) bias -= 1;
    }

    // ── 태그/카테고리 점수 (태그만으로 true는 금지)
    const tags: string[] = this.toLowerList(data?.tags);
    const categories: string[] = this.toLowerList(
      (data?.categories ?? []).map((c: any) => c?.description ?? c),
    );

    const ADULT_ONLY_TAGS = new Set([
      'hentai',
      'eroge',
      'adult only',
      'nsfw',
      'r18',
      'explicit sexual content',
      'adults only sexual content',
    ]);
    const STRONG_TAGS = new Set(['sexual content', 'nudity']); // 둘 다 있어도 총 +2

    const hasAdultOnlyTag =
      tags.some((t) => ADULT_ONLY_TAGS.has(t)) ||
      categories.some((c) => ADULT_ONLY_TAGS.has(c));
    if (hasAdultOnlyTag) {
      this.logSexualDecision(appId, title, true, '태그_AO', {
        score: 0,
        strongHits: 0,
        signals: ['tag:adult-only'],
      });
      return true;
    }

    const hasStrongTag =
      tags.some((t) => STRONG_TAGS.has(t)) ||
      categories.some((c) => STRONG_TAGS.has(c));

    // ── 2) 성인 전용 지표(트리거 A): 하나라도 있으면 즉시 true
    //     (본문만 검사. notes는 사용하지 않음)
    const adultOnlySignals: RegExp[] = [
      /\bhentai\b/,
      /\beroge\b/,
      /\buncensored\b/,
      /\bh-?cg\b/,
      /\bpornographic(?:\s+(game|games|content|material|visuals|experience))?\b/,
      /\badult\s+only\b/,
      /\br18\b/,
      /성인\s*전용/,
      /성인\s*용/,
      /(r18|성인)\s*패치/,
      /무수정|무삭제|無修正|無遮蔽|無碼/,
      /야애니/,
      /成人向け|成人向|成人ゲーム/,
      /裸露|色情|限制級|成人專用/,
      /포르노\s*(?:게임|콘텐츠|컨텐츠|물|비디오|영상|시뮬레이터|소프트|작품)/,
      /섹스\s*(?:시뮬레이터|게임|모드)/,
      /노골적(?:인)?\s*성적\s*(?:콘텐츠|컨텐츠)/,
      /성인\s*전용\s*성(?:적)?\s*(?:콘텐츠|컨텐츠)/,
      /adults?\s*only\s*sexual\s*content/,
      /에로\s*게임/,
    ];
    if (adultOnlySignals.some((rx) => rx.test(textBody))) {
      this.logSexualDecision(appId, title, true, '본문_AO', {
        score: 0,
        strongHits: 0,
        signals: ['body:adult-only'],
      });
      return true;
    }

    // ── 3) 본문 강/약 신호 (※ notes 제외!)
    const STRONG_BODY: RegExp[] = [
      /\bsexual\s+content\b/,
      /\bnudity\b/,
      /\bnudes?\b/,
      /\bsex\s*(?:scenes?|acts?)\b/,
      /\badults?\s*only\s*sexual\s*content\b/,
      /\bexplicit\s+sexual\s+content\b/,
      /\blewd\b/,
      /성(?:적)?\s*(?:콘텐츠|컨텐츠)/,
      /노출|누드/,
      /노골(?:적)?\s*노출/,
      /선정적/,
      /과도한\s*노출/,
      /성\s*행위|성\s*관계/,
      /성행위|성관계/,
      /에로|야함|에치|에찌|에로틱|에로틱한/,
      /섹스/,
      /포르노/,
      /노골적(?:인)?\s*성적/,
      /노골적(?:인)?\s*성\s*행위/,
      /성인\s*용/,
      /미성년자\s*금지/,
      /裸露|裸身|裸婦/,
      /色情|猥褻|わいせつ/,
      /エロ|エッチ|えっち/,
      /無修正|無修整|無碼/,
      /成人向け|成人向/,
      /性行為|性描写|性描寫|性愛/,
    ];
    const WEAK_BODY: RegExp[] = [
      /\bsexy\b/,
      /\bharem\b/,
      /연애\s*이벤트|하렘|섹시/,
      /미소녀|美少女/,
      /ギャル|萌え|もえ/,
    ];

    let score = 0;
    const strongHitsFromBody = STRONG_BODY.filter((rx) =>
      rx.test(textBody),
    ).length;
    if (strongHitsFromBody > 0) {
      score += 2; // 1개 이상 존재 시 +2
      signals.push(`본문_강키워드(${strongHitsFromBody})+2`);
    }
    if (WEAK_BODY.some((rx) => rx.test(textBody))) {
      score += 1;
      signals.push('본문_약키워드+1');
    }
    if (hasStrongTag) {
      score += 2;
      signals.push('태그:sexual/nudity+2');
    }

    // ── 4) 근접 강화: 성적 키워드와 cg/패치/무수정/r18 등이 80자 내 동시 등장 시 +1 (※ 본문만)
    const proxPairs: [RegExp, RegExp][] = [
      [
        /(sex|sexual|성적|에로|야함|hentai|lewd|노출|누드|섹스|포르노)/,
        /(gallery|cg|패치|uncensored|무수정|r18|콘텐츠|컨텐츠)/,
      ],
      [
        /(에로|야한|야애니|エロ|えっち|裸露|色情)/,
        /(cg|일러스트|原画|無修正|無碼|콘텐츠|컨텐츠)/,
      ],
    ];
    if (this.hasProximity(textBody, proxPairs, 80)) {
      score += 1;
      signals.push('근접강화+1');
    }

    // ── 5) 안내/면책 문구는 중립 (점수 변화 없음) — 감지만 하고 no-op
    // const disclaimers = [/성적인?\s*콘텐츠[^.]{0,40}18\s*세\s*이상/, /all\s*characters[^.]{0,40}(18\+|over\s*18)/];

    // ── 6) 비노골/예술 표현 완화 (IMMORTALITY 대응)
    //     'non-graphic|brief|partial|non-explicit|artistic' 가 sexual/nudity 주변(±60자)에 있으면 -2
    if (this.softenNearSexual(textBody, 60)) {
      score = Math.max(score - 2, 0);
      signals.push('완화-2');
    }

    // ── 7) FMV/영화형 장르 감점 (성인 전용 지표 없을 때만)
    const isFMV =
      /(fmv|interactive\s+(movie|film)|narrative\s+adventure|cinematic)/.test(
        textBody,
      );
    if (isFMV) {
      score = Math.max(score - 1, 0);
      signals.push('FMV-1');
    }

    // ── 8) AAA 바이어스
    score += bias;
    if (bias !== 0) {
      signals.push(`AAA${bias}`);
    }

    // ── 9) 트리거 B: 본문 강 신호 2개 이상이 서로 근접(≤80자)해야 true (태그/notes로는 불가)
    const triggerB =
      strongHitsFromBody >= 2 &&
      this.hasProximity(
        textBody,
        [
          [
            /sexual|성적|노출|누드|sex|nudity/,
            /content|콘텐츠|scenes?|acts?|패치|cg/,
          ],
        ],
        80,
      );
    if (triggerB) {
      this.logSexualDecision(appId, title, true, '본문_근접트리거', {
        score,
        strongHits: strongHitsFromBody,
        signals,
      });
      return true;
    }

    // ── 10) notes + 본문 결합 트리거 (네가 명시한 규칙)
    // notes에 sexual/nudity 계열이 있고, "본문 강키워드 점수 ≥ 2"면 true
    const notesHasExplicit =
      /(explicit\s+sexual\s+content|adults?\s*only\s*sexual\s*content|노골적\s*성행위|노골적\s*성적)/.test(
        textNotes,
      );
    const ratingsHasExplicit =
      /(explicit\s+sexual\s+content|adults?\s*only\s*sexual\s*content|노골적\s*성(?:적)?\s*(?:콘텐츠|컨텐츠)|노골적\s*성행위)/.test(
        ratingsRaw,
      );
    const ratingsHasGeneral =
      !ratingsHasExplicit &&
      /(sexual\s+content|sexuality|sex|성적\s*(?:콘텐츠|표현)|성행위|性描写|性行為|성인\s*용)/.test(
        ratingsRaw,
      );

    if (ratingsHasExplicit) {
      score += 3;
      signals.push('ratings_explicit+3');
    } else if (ratingsHasGeneral) {
      score += 1;
      signals.push('ratings_general+1');
    }

    if (hasMatureDescriptor) {
      score += 1;
      signals.push('descriptor:5+1');
    }

    if (notesHasExplicit && ratingsHasExplicit && strongHitsFromBody >= 1) {
      this.logSexualDecision(appId, title, true, 'notes+ratings_explicit', {
        score,
        strongHits: strongHitsFromBody,
        signals,
      });
      return true;
    }

    // ── 11) 누적 임계치
    const meetsThreshold = score >= 6 && strongHitsFromBody >= 1;
    if (meetsThreshold) {
      this.logSexualDecision(appId, title, true, '점수임계치', {
        score,
        strongHits: strongHitsFromBody,
        signals,
      });
      return true;
    }

    this.logSexualDecision(appId, title, false, '임계치미달', {
      score,
      strongHits: strongHitsFromBody,
      signals,
    });
    return false;
  }

  /** HTML/URL/파일명 제거 + 소문자화 + 공백 정리 */
  private normalizeText(html: string): string {
    return (
      String(html)
        // URL/파일 경로 제거
        .replace(/https?:\/\/\S+/gi, ' ')
        .replace(
          /\b[\w\-\/]+\.(jpg|jpeg|png|gif|webm|mp4|avif|apng|webp)\b/gi,
          ' ',
        )
        // HTML 제거
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        // 공백 정리 & 소문자
        .replace(/\s+/g, ' ')
        .toLowerCase()
        .trim()
    );
  }

  /** 배열/문자 뒤섞인 필드 → 문자열 배열(lowercase는 호출부에서) */
  private toLowerList(v: any): string[] {
    if (!v) return [];
    const arr = Array.isArray(v) ? v : [v];
    return arr
      .map((x) => (x == null ? '' : String(x)))
      .map((s) => s.toLowerCase().trim())
      .filter(Boolean);
  }

  /** 두 패턴이 maxGap 이내에 공존하는지 (본문에서만 사용) */
  private hasProximity(
    text: string,
    pairs: [RegExp, RegExp][],
    maxGap: number,
  ): boolean {
    for (const [a, b] of pairs) {
      const aGlobal = new RegExp(
        a.source,
        a.flags.includes('g') ? a.flags : a.flags + 'g',
      );
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
    const SOFTEN =
      /(non[-\s]?graphic|brief|partial|non[-\s]?explicit|artistic)/;
    const SEXUAL = /(sexual|sex|nudity|누드|노출|성적)/;
    const sexualG = new RegExp(SEXUAL.source, SEXUAL.flags + 'g');
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
    if (!v) return '';
    return Array.isArray(v) ? v.join(' ') : String(v);
  }



  /** 성인향 판정 로그 */
  private logSexualDecision(
    appId: number,
    title: string,
    result: boolean,
    reason: string,
    payload: { score: number; strongHits: number; signals: string[] },
  ) {
    const namePart = title ? ` ${title}` : '';
    const signalText = payload.signals.length
      ? payload.signals.join(', ')
      : '신호 없음';
    this.logger.debug(
      `🔍 Steam 성인향 판정${namePart} (AppID ${appId}) → ${
        result ? 'TRUE' : 'FALSE'
      } | 이유: ${reason} | 점수: ${payload.score} | 본문 강키워드: ${
        payload.strongHits
      } | 신호: ${signalText}`,
    );
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
