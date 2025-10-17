import { Injectable, Logger } from '@nestjs/common';
import { Brackets, EntityManager } from 'typeorm';

import {
  ProcessedGameData,
  CompanyData,
  MatchingContextData,
  MatchingDecisionData,
} from '@pipeline/contracts';

import { Game } from '../../../entities/game.entity';
import { normalizeSlugCandidate } from '../../../common/slug/slug-normalizer.util';
import {
  MatchingScore,
  calcMatchingScore,
  normalizeGameName,
  MatchingReportWriter,
  MatchingLogKind,
} from '../../../common/matching';
import type { NormalizedNameResult } from '../../../common/matching';

type MatchOutcome = 'matched' | 'pending' | 'rejected' | 'no_candidate';

interface MatchDecision {
  outcome: MatchOutcome;
  game?: Game;
  score?: MatchingScore;
  signals?: number;
  logPath?: string | null;
  reason?: string;
}

/**
 * RAWG 전용 데이터와 기존 Steam 기반 게임의 매칭을 담당한다.
 */
@Injectable()
export class MultiPlatformMatchingService {
  private readonly logger = new Logger(MultiPlatformMatchingService.name);
  private writer: MatchingReportWriter | null = null;
  private logQueue = Promise.resolve();

  async evaluate(
    data: ProcessedGameData,
    manager: EntityManager,
  ): Promise<MatchDecision> {
    const context = data.matchingContext;
    if (data.steamId || !data.rawgId) {
      return { outcome: 'no_candidate' };
    }

    const candidates = await this.loadCandidates(data, context, manager);

    if (!candidates.length) {
      await this.applyDecision(data, {
        outcome: 'rejected',
        reason: 'NO_CANDIDATE',
        logPath: await this.recordLog(
          'rejected',
          data,
          null,
          'NO_CANDIDATE',
          0,
        ),
      });
      return { outcome: 'no_candidate' };
    }

    const rawgName = this.buildNormalizedName(data);
    const rawgReleaseDate = this.resolveReleaseDate(data);
    const rawgCompanies = this.resolveCompanies(data);
    const rawgGenres = this.resolveGenres(data);

    const scored = candidates
      .map((candidate) => {
        // ✅ Steam 게임도 og_name 우선 사용 (영문 기준)
        const steamName = normalizeGameName(
          candidate.og_name || candidate.name,
        );
        const steamReleaseDate = this.toDate(candidate.release_date_date);
        const steamCompanies = this.extractCompanyData(candidate);
        const steamGenres = candidate.details?.genres ?? [];

        const score = calcMatchingScore({
          rawgName,
          steamName,
          // ✅ 실제 DB slug 필드 전달 (정확한 매칭을 위해)
          rawgSlug: data.slug,
          rawgOgSlug: data.ogSlug,
          steamSlug: candidate.slug,
          steamOgSlug: candidate.og_slug,
          rawgReleaseDate,
          steamReleaseDate,
          rawgCompanies,
          steamCompanies,
          rawgGenres,
          steamGenres,
        });

        // 강한 시그널: PC 포팅 고려하여 조건 완화
        const strongSignals = [
          score.flags.slugMatch, // Slug 일치
          score.flags.nameExactMatch, // 이름 정확히 일치
          score.flags.releaseDateDiffDays !== null &&
            score.flags.releaseDateDiffDays <= 365, // 7일 → 1년 (PC 포팅)
          score.flags.companyOverlap.length > 0, // 회사 중복
        ];
        const signalCount = strongSignals.filter(Boolean).length;

        return { candidate, score, signalCount };
      })
      .filter(({ score, signalCount }) => {
        // 이름 유사도가 높으면 시그널 1개로도 허용
        if (score.breakdown.nameScore >= 0.35) return signalCount >= 1;
        // 그 외에는 시그널 2개 필요
        return signalCount >= 2;
      })
      .sort((a, b) => b.score.totalScore - a.score.totalScore);

    if (!scored.length) {
      await this.recordLog(
        'rejected',
        data,
        candidates[0],
        'INSUFFICIENT_SIGNALS',
        0,
      );
      return { outcome: 'rejected' };
    }

    const best = scored[0];
    let outcome: MatchOutcome = 'rejected';
    let reason = 'SCORE_REJECTED';

    // PC 포팅 고려: 임계값 완화
    if (best.score.totalScore >= 0.6) {
      outcome = 'matched';
      reason = 'AUTO_MATCH';
    } else if (best.score.totalScore >= 0.4) {
      outcome = 'pending';
      reason = 'SCORE_THRESHOLD_PENDING';
    }
    if (outcome == 'pending') {
      console.log(`   📤보류 게임 (Source):`);
      console.log(`      - 게임 ID: #${best.candidate.id}`);
      console.log(`      - 게임 이름: "${best.candidate.name}"`);
      console.log(`      - 슬러그: ${best.candidate.slug}`);
      console.log(`      - steam ID: ${best.candidate.steam_id}`);
      console.log(`      - 출시일: ${best.candidate.release_date_date}`);
    }

    const hasSteamConflict =
      data.steamId &&
      best.candidate.steam_id &&
      Number(best.candidate.steam_id) !== Number(data.steamId);

    if (hasSteamConflict) {
      this.logger.warn(
        `⚠️ [멀티 매칭] Steam ID 충돌 – existing=${best.candidate.steam_id} incoming=${data.steamId} slug=${data.slug ?? data.ogSlug ?? data.name}`,
      );
      outcome = 'rejected';
      reason = 'STEAM_ID_CONFLICT';
    }

    const logPath = await this.recordLog(
      outcome === 'matched'
        ? 'matched'
        : outcome === 'pending'
          ? 'pending'
          : 'rejected',
      data,
      best.candidate,
      reason,
      best.score.totalScore,
      best.score,
      best.signalCount,
    );

    await this.applyDecision(data, {
      outcome,
      score: best.score,
      signals: best.signalCount,
      game: best.candidate,
      logPath,
      reason,
    });

    return {
      outcome,
      score: best.score,
      signals: best.signalCount,
      logPath,
      reason,
    };
  }

  private async loadCandidates(
    data: ProcessedGameData,
    context: MatchingContextData | undefined,
    manager: EntityManager,
  ): Promise<Game[]> {
    const slugCandidates = this.buildSlugCandidates(data, context);
    const releaseDate = this.resolveReleaseDate(data);
    // ✅ ogName 우선 사용 (영문 기준 토큰 추출)
    const nameTokens =
      context?.normalizedName?.tokens?.slice(0, 3) ??
      normalizeGameName(data.ogName || data.name).tokens.slice(0, 3);
    const candidateSteamIds = context?.candidateSteamIds ?? [];

    const qb = manager
      .createQueryBuilder(Game, 'game')
      .leftJoinAndSelect('game.details', 'details')
      .leftJoinAndSelect('game.company_roles', 'role')
      .leftJoinAndSelect('role.company', 'company')
      .where('game.steam_id IS NOT NULL')
      .andWhere('game.rawg_id IS NULL')
      .andWhere("game.game_type != 'dlc'"); // Steam DLC 제외 (중요!)

    // candidateSteamIds가 있으면 제한하되, 다른 조건도 함께 적용
    if (candidateSteamIds.length > 0) {
      qb.andWhere('game.steam_id IN (:...steamIds)', {
        steamIds: candidateSteamIds,
      });
    }

    // Slug OR 이름 토큰 검색 (멀티플랫폼 매칭의 핵심)
    if (slugCandidates.length || nameTokens.length) {
      qb.andWhere(
        new Brackets((main) => {
          // 1. Slug 후보 검색 (우선순위 높음)
          if (slugCandidates.length) {
            main.where(
              new Brackets((slugSub) => {
                slugSub.where('game.slug IN (:...slugs)', {
                  slugs: slugCandidates,
                });
                slugSub.orWhere('game.og_slug IN (:...slugs)', {
                  slugs: slugCandidates,
                });
              }),
            );
          }

          // 2. 이름 토큰 검색 (fallback, 필수 토큰만 AND 조건)
          if (nameTokens.length) {
            // 년도 토큰과 일반 토큰 분리 (멀티플랫폼 고려)
            const yearTokens = nameTokens.filter((t) => /^\d{4}$/.test(t));
            const textTokens = nameTokens.filter((t) => !/^\d{4}$/.test(t));

            const tokenCondition = new Brackets((nameSub) => {
              // 텍스트 토큰: 필수 (AND)
              // ✅ Steam의 name 또는 og_name 중 하나라도 매칭되면 후보로 조회
              textTokens.forEach((token, idx) => {
                nameSub.andWhere(
                  new Brackets((tokenSub) => {
                    tokenSub.where(`LOWER(game.name) LIKE :textToken${idx}`, {
                      [`textToken${idx}`]: `%${token.toLowerCase()}%`,
                    });
                    tokenSub.orWhere(
                      `LOWER(COALESCE(game.og_name, '')) LIKE :ogTextToken${idx}`,
                      {
                        [`ogTextToken${idx}`]: `%${token.toLowerCase()}%`,
                      },
                    );
                  }),
                );
              });

              // 년도 토큰: 선택적 (있으면 보너스 점수, 없어도 OK)
              // 여기서는 조건에 포함하지 않고, 스코어링에서만 활용
            });

            if (slugCandidates.length) {
              main.orWhere(tokenCondition);
            } else {
              main.where(tokenCondition);
            }
          }
        }),
      );
    }

    // 출시일 범위 확대 (PC 포팅 고려: 1년 → 5년)
    if (releaseDate) {
      const range = this.buildDateRange(releaseDate, 1825); // 5년 = 365 * 5
      qb.andWhere(
        new Brackets((sub) => {
          sub.where('game.release_date_date BETWEEN :start AND :end', range);
          sub.orWhere('game.release_date_date IS NULL');
        }),
      );
      qb.setParameters(range);
    }

    qb.orderBy('game.popularity_score', 'DESC').take(50); // 25 → 50 (더 많은 후보)

    return qb.getMany();
  }

  private buildSlugCandidates(
    data: ProcessedGameData,
    context: MatchingContextData | undefined,
  ): string[] {
    const set = new Set<string>();
    const push = (value?: string | null) => {
      const normalized = normalizeSlugCandidate(value);
      if (normalized) set.add(normalized);
    };

    // ✅ 우선순위: ogSlug → ogName → slug → name (영문 우선)
    push(data.ogSlug);
    push(data.ogName);
    push(data.slug);
    push(data.name);
    context?.candidateSlugs?.forEach((slug) => push(slug));

    // ✅ ogName 우선 사용 (영문 기준)
    const normalized = normalizeGameName(data.ogName || data.name);
    if (normalized.looseSlug) set.add(normalized.looseSlug);

    return [...set];
  }

  private resolveReleaseDate(data: ProcessedGameData): Date | null {
    const contextDate = data.matchingContext?.releaseDateIso;
    if (contextDate) {
      const parsed = new Date(`${contextDate}T00:00:00Z`);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }

    if (data.releaseDate instanceof Date) {
      return data.releaseDate;
    }

    if (data.releaseDate) {
      const parsed = new Date(data.releaseDate);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }

    return null;
  }

  private buildNormalizedName(data: ProcessedGameData): NormalizedNameResult {
    const context = data.matchingContext?.normalizedName;
    if (context) {
      return {
        original: data.ogName || data.name, // ✅ ogName 우선
        lowercase:
          context.lowercase ?? (data.ogName || data.name).toLowerCase(),
        tokens: context.tokens ?? [],
        compact:
          context.compact ??
          (data.ogName || data.name).replace(/\s+/g, '').toLowerCase(),
        looseSlug:
          context.looseSlug ?? normalizeSlugCandidate(data.ogName || data.name),
      };
    }

    // ✅ ogName 우선 사용 (영문 기준)
    return normalizeGameName(data.ogName || data.name);
  }

  private resolveCompanies(data: ProcessedGameData): CompanyData[] {
    if (data.companies?.length) {
      return data.companies;
    }

    const slugs = data.matchingContext?.companySlugs;
    if (!slugs?.length) return [];

    return slugs.map((slug) => ({
      name: slug,
      slug,
      role: 'developer',
    })) as CompanyData[];
  }

  private resolveGenres(data: ProcessedGameData): string[] {
    if (data.details?.genres?.length) return data.details.genres;
    const tokens = data.matchingContext?.genreTokens ?? [];
    return tokens;
  }

  private async applyDecision(
    data: ProcessedGameData,
    decision: MatchDecision,
  ): Promise<void> {
    if (!decision.reason && decision.outcome !== 'matched') {
      decision.reason =
        decision.outcome === 'pending' ? 'SCORE_THRESHOLD_PENDING' : 'NO_MATCH';
    }

    if (!decision.score && data.matchingDecision?.matchedScore) {
      decision.score = {
        totalScore: data.matchingDecision.matchedScore,
        breakdown: {
          nameScore: 0,
          releaseDateScore: 0,
          companyScore: 0,
          genreScore: 0,
          bonusScore: 0,
        },
        flags: {
          nameExactMatch: false,
          slugMatch: false,
          releaseDateDiffDays: null,
          companyOverlap: [],
          genreOverlap: [],
        },
      };
    }

    const context: MatchingContextData = data.matchingContext
      ? { ...data.matchingContext }
      : { source: decision.game ? 'steam' : 'rawg' };
    if (decision.game?.steam_id) {
      data.matchingContext = {
        ...context,
        canonicalSteamId: decision.game.steam_id ?? undefined,
      };
    } else if (!data.matchingContext) {
      data.matchingContext = context;
    }

    const mapped: MatchingDecisionData = {
      status:
        decision.outcome === 'matched'
          ? 'auto'
          : decision.outcome === 'pending'
            ? 'pending'
            : 'rejected',
      matchedGameId: decision.game?.id,
      matchedScore: decision.score?.totalScore,
      reason: decision.reason,
      logPath: decision.logPath ?? data.matchingDecision?.logPath,
    };

    data.matchingDecision = mapped;
  }

  private buildDateRange(date: Date, days: number) {
    const start = new Date(date);
    start.setUTCDate(start.getUTCDate() - days);
    const end = new Date(date);
    end.setUTCDate(end.getUTCDate() + days);
    return {
      start: start.toISOString().slice(0, 10),
      end: end.toISOString().slice(0, 10),
    };
  }

  private extractCompanyData(game: Game): CompanyData[] {
    if (!game.company_roles?.length) return [];
    return game.company_roles
      .map((role) => ({
        name: role.company?.name ?? '',
        slug: role.company?.slug ?? undefined,
        role: role.role,
      }))
      .filter((company) => company.name);
  }

  private toDate(value: unknown): Date | null {
    if (!value) return null;
    if (value instanceof Date) return value;
    const str = typeof value === 'string' ? value : String(value);
    if (!str) return null;
    const parsed = new Date(`${str}T00:00:00Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private async recordLog(
    outcome: 'matched' | 'pending' | 'rejected',
    data: ProcessedGameData,
    candidate: Game | null,
    reason: string,
    score: number,
    breakdown?: MatchingScore,
    signals?: number,
  ): Promise<string | null> {
    const task = this.logQueue.then(async () => {
      const writer = await this.getWriter();

      if (outcome === 'matched') {
        writer.recordResult('matched', Number(score.toFixed(4)), reason);
        await writer.flushSummary();
        return writer.getSummaryPath();
      }

      const kind: MatchingLogKind =
        outcome === 'pending' ? 'pending' : 'rejected';

      await writer.append(kind, {
        rawgId: data.rawgId ?? -1,
        rawgName: data.name,
        steamCandidateId: candidate?.id ?? null,
        steamName: candidate?.name ?? null,
        score: Number(score.toFixed(4)),
        reason,
        overlap: breakdown
          ? {
              companies: breakdown.flags.companyOverlap,
              genres: breakdown.flags.genreOverlap,
            }
          : undefined,
        diff: breakdown
          ? {
              releaseDays: breakdown.flags.releaseDateDiffDays,
            }
          : undefined,
        slugCollision: breakdown?.flags.slugMatch ?? false,
        meta: {
          signals,
        },
      });

      writer.recordResult(
        outcome === 'pending' ? 'pending' : 'failed',
        Number(score.toFixed(4)),
        reason,
      );
      await writer.flushSummary();
      return writer.getLogPath(kind);
    });

    const normalizedTask = task.catch((error) => {
      this.logger.error(
        `⚠️ [멀티 매칭] 로그 기록 실패: ${(error as Error).message}`,
      );
      return null;
    });

    this.logQueue = normalizedTask.then(() => undefined);
    return normalizedTask;
  }

  private async getWriter(): Promise<MatchingReportWriter> {
    if (!this.writer) {
      this.writer = new MatchingReportWriter();
    }
    return this.writer;
  }
}
