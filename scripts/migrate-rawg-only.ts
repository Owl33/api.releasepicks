import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { DataSource, EntityManager, In } from 'typeorm';

import { AppModule } from '../src/app.module';
import { Game } from '../src/entities/game.entity';
import { GameDetail } from '../src/entities/game-detail.entity';
import { GameRelease } from '../src/entities/game-release.entity';
import { MultiPlatformMatchingService } from '../src/pipeline/persistence/services/multi-platform-matching.service';
import { MatchingContextData, ProcessedGameData } from '@pipeline/contracts';
import {
  GameType,
  ReleaseStatus,
  Store,
  Platform,
} from '../src/entities/enums';
import { normalizeGameName as normalizeMatchingName } from '../src/common/matching';
import { normalizeSlugCandidate } from '../src/common/slug/slug-normalizer.util';

type CliOptions = {
  limit: number;
  offset: number;
  dryRun: boolean;
};

type Summary = {
  processed: number;
  matched: number;
  pending: number;
  rejected: number;
  failed: number;
};

async function main() {
  const options = parseArgs(process.argv);

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const dataSource = app.get(DataSource);
  const matchingService = app.get(MultiPlatformMatchingService);

  const gameRepo = dataSource.getRepository(Game);

  // 1단계: 게임 ID만 먼저 조회 (조인 없이 순수하게)
  const candidateIds = await gameRepo
    .createQueryBuilder('game')
    .select('game.id')
    .where('game.steam_id IS NULL')
    .andWhere('game.rawg_id IS NOT NULL')
    .orderBy('game.popularity_score', 'DESC')
    .offset(options.offset)
    .limit(options.limit)
    .getMany();

  if (!candidateIds.length) {
    console.log('대상 RAWG 전용 레코드를 찾지 못했습니다.');
    await app.close();
    return;
  }

  // 2단계: 관계 포함해서 실제 게임 데이터 조회
  const candidates = await gameRepo.find({
    where: { id: In(candidateIds.map((g) => g.id)) },
    relations: [
      'details',
      'releases',
      'company_roles',
      'company_roles.company',
    ],
    order: { popularity_score: 'DESC' },
  });

  if (!candidates.length) {
    console.log('대상 RAWG 전용 레코드를 찾지 못했습니다.');
    await app.close();
    return;
  }

  console.log(
    `🎯 RAWG 전용 후보 ${candidates.length}건을 ${
      options.dryRun ? '드라이런' : '실행 모드'
    }로 처리합니다.`,
  );

  const summary: Summary = {
    processed: 0,
    matched: 0,
    pending: 0,
    rejected: 0,
    failed: 0,
  };

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    try {
      await dataSource.transaction(async (manager) => {
        const sourceGame = await manager.findOne(Game, {
          where: { id: candidate.id },
          relations: [
            'details',
            'releases',
            'company_roles',
            'company_roles.company',
          ],
        });

        if (!sourceGame || !sourceGame.rawg_id) {
          summary.failed += 1;
          return;
        }

        const processed = buildProcessedGameData(sourceGame);
        const decision = await matchingService.evaluate(processed, manager);
        summary.processed += 1;
        if (decision.outcome === 'matched' && decision.game) {
          summary.matched += 1;
          console.log(
            `\n🤝 [${index + 1}/${candidates.length}] 매칭 성공 (매칭 점수: ${
              decision.score?.totalScore ?? 0
            })`,
          );
          console.log(`   📤 원본 게임 (Source):`);
          console.log(`      - 게임 ID: #${sourceGame.id}`);
          console.log(`      - 게임 이름: "${sourceGame.name}"`);
          console.log(`      - 슬러그: ${sourceGame.slug}`);
          console.log(`      - RAWG ID: ${sourceGame.rawg_id}`);

          console.log(`   📥 대상 게임 (Target):`);
          console.log(`      - 게임 ID: #${decision.game.id}`);
          console.log(`      - 게임 이름: "${decision.game.name}"`);
          console.log(`      - 슬러그: ${decision.game.slug}`);
          console.log(`      - Steam ID: ${decision.game.steam_id}`);

          if (!options.dryRun) {
            await mergeGames(manager, sourceGame, decision.game);
          } else {
            console.log(`   ℹ️  드라이런 모드: 실제 병합은 수행되지 않습니다.`);
          }
          return;
        }

        if (decision.outcome === 'pending') {
          summary.pending += 1;
          console.log('스코어점수', decision.score?.totalScore);
          console.log('------------------보류---------------');

          console.log(`   📤 원본 게임 (Source):`);
          console.log(`      - 게임 ID: #${sourceGame.id}`);
          console.log(`      - 게임 이름: "${sourceGame.name}"`);
          console.log(`      - 슬러그: ${sourceGame.slug}`);
          console.log(`      - RAWG ID: ${sourceGame.rawg_id}`);
          console.log(`      - 출시일: ${sourceGame.release_date_date}`);
          return;
        }

        if (decision.outcome === 'rejected') {
          summary.rejected += 1;
          console.log(
            `🚫 [${index + 1}/${candidates.length}] rawg_id=${
              sourceGame.rawg_id
            } 매칭 실패 (score=${decision.score?.totalScore ?? 0}, reason=${
              processed.matchingDecision?.reason ?? 'SCORE_REJECTED'
            })`,
          );
          return;
        }

        if (decision.outcome === 'no_candidate') {
          summary.rejected += 1;
          console.log(
            `❓ [${index + 1}/${candidates.length}] rawg_id=${
              sourceGame.rawg_id
            } 일치 후보 없음`,
          );
          return;
        }
      });
    } catch (error) {
      summary.failed += 1;
      console.error(
        `❌ rawg_id=${candidate.rawg_id ?? 'unknown'} 처리 실패:`,
        (error as Error).message ?? error,
      );
    }
  }

  console.log('\n=== 실행 요약 ===');
  console.log(`총 처리: ${summary.processed}`);
  console.log(`자동 병합: ${summary.matched}`);
  console.log(`보류: ${summary.pending}`);
  console.log(`미매칭: ${summary.rejected}`);
  console.log(`실패: ${summary.failed}`);

  await app.close();
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    limit: 50,
    offset: 0,
    dryRun: true,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--limit' && argv[i + 1]) {
      options.limit = Number(argv[++i]) || options.limit;
    } else if (arg.startsWith('--limit=')) {
      options.limit = Number(arg.split('=')[1]) || options.limit;
    } else if (arg === '--offset' && argv[i + 1]) {
      options.offset = Number(argv[++i]) || options.offset;
    } else if (arg.startsWith('--offset=')) {
      options.offset = Number(arg.split('=')[1]) || options.offset;
    } else if (arg === '--apply') {
      options.dryRun = false;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    }
  }

  return options;
}

function buildProcessedGameData(game: Game): ProcessedGameData {
  const normalized = normalizeMatchingName(game.name);
  const candidateSlugs = new Set<string>();
  [game.slug, game.og_slug, game.name, game.og_name]
    .filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    )
    .forEach((value) => {
      const normalizedSlug = normalizeSlugCandidate(value);
      if (normalizedSlug) candidateSlugs.add(normalizedSlug);
    });

  const companies =
    game.company_roles?.map<
      NonNullable<ProcessedGameData['companies']>[number]
    >((role) => ({
      name: role.company?.name ?? 'Unknown',
      slug: role.company?.slug ?? undefined,
      role: role.role,
    })) ?? [];

  const detailsEntity =
    (game as Game & { details?: GameDetail | null }).details ?? null;
  const releasesEntity =
    (game as Game & { releases?: GameRelease[] | null }).releases ?? [];

  const releases = releasesEntity.map<
    NonNullable<ProcessedGameData['releases']>[number]
  >((release) => ({
    platform: release.platform ?? Platform.PC,
    store: release.store ?? Store.STEAM,
    storeAppId: release.store_app_id ?? undefined,
    storeUrl: release.store_url ?? undefined,
    releaseDateDate: toDate(release.release_date_date) ?? undefined,
    releaseDateRaw: release.release_date_raw ?? undefined,
    releaseStatus: release.release_status ?? ReleaseStatus.TBA,
    comingSoon: release.coming_soon ?? false,
    currentPriceCents: release.current_price_cents ?? undefined,
    isFree: release.is_free ?? false,
    followers: release.followers ?? undefined,
    reviewsTotal: release.reviews_total ?? undefined,
    reviewScoreDesc: release.review_score_desc ?? undefined,
    dataSource: 'rawg',
  }));

  const details = detailsEntity
    ? {
        screenshots: detailsEntity.screenshots ?? undefined,
        videoUrl: detailsEntity.video_url ?? undefined,
        description: detailsEntity.description ?? undefined,
        website: detailsEntity.website ?? undefined,
        genres: detailsEntity.genres ?? undefined,
        tags: detailsEntity.tags ?? undefined,
        supportLanguages: detailsEntity.support_languages ?? undefined,
        sexual: detailsEntity.sexual ?? false,
        headerImage: detailsEntity.header_image,
        metacriticScore: detailsEntity.metacritic_score ?? undefined,
        opencriticScore: detailsEntity.opencritic_score ?? undefined,
        rawgAdded: detailsEntity.rawg_added ?? undefined,
        totalReviews: detailsEntity.total_reviews ?? undefined,
        reviewScoreDesc: detailsEntity.review_score_desc ?? undefined,
      }
    : undefined;

  const releaseDate = toDate(game.release_date_date);

  const matchingContext: MatchingContextData = {
    source: 'rawg',
    normalizedName: {
      lowercase: normalized.lowercase,
      tokens: normalized.tokens,
      compact: normalized.compact,
      looseSlug: normalized.looseSlug,
    },
    releaseDateIso: releaseDate
      ? releaseDate.toISOString().slice(0, 10)
      : (game.release_date_raw ?? null),
    companySlugs: companies
      .map((company) => company.slug)
      .filter((slug): slug is string => Boolean(slug)),
    genreTokens: details?.genres?.map((genre) =>
      genre.normalize('NFKC').toLowerCase(),
    ),
    candidateSlugs: candidateSlugs.size ? [...candidateSlugs] : undefined,
  };

  const releaseStatus = game.release_status ?? ReleaseStatus.TBA;

  const processed: ProcessedGameData = {
    name: game.name,
    slug: game.slug ?? undefined,
    ogName: game.og_name,
    ogSlug: game.og_slug ?? undefined,
    steamId: game.steam_id ?? undefined,
    rawgId: game.rawg_id ?? undefined,
    gameType: game.game_type ?? GameType.GAME,
    parentSteamId: game.parent_steam_id ?? undefined,
    parentRawgId: game.parent_rawg_id ?? undefined,
    releaseDate: releaseDate ?? undefined,
    releaseDateRaw: game.release_date_raw ?? undefined,
    releaseStatus,
    comingSoon: game.coming_soon ?? false,
    popularityScore: game.popularity_score ?? 0,
    followersCache: game.followers_cache ?? undefined,
    companies,
    details,
    releases,
    matchingContext,
  };

  return processed;
}

function toDate(value?: Date | string | null): Date | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return undefined;
}

async function mergeGames(
  manager: EntityManager,
  sourceGame: Game,
  targetGame: Game,
): Promise<void> {
  const sourceGameId = sourceGame.id;
  const targetGameId = targetGame.id;

  console.log(`\n   🔄 병합 프로세스 시작:`);
  console.log(
    `      원본 게임 (Source): 게임 ID #${sourceGameId}, 게임 이름 "${sourceGame.name}", 슬러그 "${sourceGame.slug}", RAWG ID ${sourceGame.rawg_id}`,
  );
  console.log(
    `      대상 게임 (Target): 게임 ID #${targetGameId}, 게임 이름 "${targetGame.name}", 슬러그 "${targetGame.slug}", Steam ID ${targetGame.steam_id}`,
  );

  // 락 획득
  await manager.query(
    'SELECT id FROM public.games WHERE id IN ($1, $2) FOR UPDATE',
    [sourceGameId, targetGameId],
  );

  // 기존 릴리즈 로깅(정보 표시용)
  const sourceReleases = await manager.find(GameRelease, {
    where: { game_id: sourceGameId },
  });
  const targetReleases = await manager.find(GameRelease, {
    where: { game_id: targetGameId },
  });

  console.log(`\n   📦 릴리즈 정보:`);
  console.log(`      원본 게임 (Source) 릴리즈: ${sourceReleases.length}건`);
  sourceReleases.forEach((r) => {
    console.log(
      `         - 플랫폼: ${r.platform ?? 'N/A'}, 스토어: ${r.store ?? 'N/A'}, 스토어 앱 ID: ${
        r.store_app_id || 'N/A'
      }`,
    );
  });
  console.log(`      대상 게임 (Target) 릴리즈: ${targetReleases.length}건`);
  targetReleases.forEach((r) => {
    console.log(
      `         - 플랫폼: ${r.platform ?? 'N/A'}, 스토어: ${r.store ?? 'N/A'}, 스토어 앱 ID: ${
        r.store_app_id || 'N/A'
      }`,
    );
  });

  // === 안전/명시적 중복 판정 & 이동 ===

  // 1) 타깃 릴리즈 스냅샷 (중복 키셋)
  const targetRows = await manager.query(
    `
    SELECT id,
           COALESCE(platform::text, '')   AS platform,
           COALESCE(store::text, '')      AS store,
           COALESCE(store_app_id, '')     AS store_app_id
    FROM public.game_releases
    WHERE game_id = $1
    `,
    [targetGameId],
  );
  const targetKey = new Set(
    targetRows.map((r: any) => `${r.platform}|${r.store}|${r.store_app_id}`),
  );

  // 2) 소스 릴리즈 스냅샷
  const sourceRows = await manager.query(
    `
    SELECT id,
           COALESCE(platform::text, '')   AS platform,
           COALESCE(store::text, '')      AS store,
           COALESCE(store_app_id, '')     AS store_app_id
    FROM public.game_releases
    WHERE game_id = $1
    `,
    [sourceGameId],
  );

  // 3) 중복/이동 대상을 JS에서 분리
  const duplicateIds: number[] = [];
  const moveIds: number[] = [];
  for (const r of sourceRows) {
    const key = `${r.platform}|${r.store}|${r.store_app_id}`;
    if (targetKey.has(key)) duplicateIds.push(r.id);
    else moveIds.push(r.id);
  }

  // 4) 중복만 정확히 지우기 (id 기반)
  let deleted: any[] = [];
  if (duplicateIds.length) {
    deleted = await manager.query(
      `
      DELETE FROM public.game_releases
    WHERE id = ANY($1::bigint[])            
      RETURNING
        id AS id,
        COALESCE(platform::text, '') AS platform,
        COALESCE(store::text, '')    AS store,
        COALESCE(store_app_id, '')   AS store_app_id
      `,
      [duplicateIds],
    );
    console.log(`\n   🗑️  중복 릴리즈 삭제: ${deleted.length}건`);
    for (const r of deleted) {
      console.log(
        `         - 플랫폼: ${r.platform || 'N/A'}, 스토어: ${r.store || 'N/A'}, 스토어 앱 ID: ${
          r.store_app_id || 'N/A'
        } (중복으로 삭제됨)`,
      );
    }
  } else {
    console.log(`\n   ℹ️  중복 릴리즈 없음`);
  }

  // 5) 나머지만 이동 (id 기반)
  let moved: any[] = [];
  if (moveIds.length) {
    moved = await manager.query(
      `
    UPDATE public.game_releases
    SET game_id = $2
    WHERE id = ANY($1::bigint[])               -- ✅ int[] -> bigint[]
    RETURNING
      id AS id,
      COALESCE(platform::text, '') AS platform,
      COALESCE(store::text, '')    AS store,
      COALESCE(store_app_id, '')   AS store_app_id
    `,
      [moveIds, targetGameId],
    );
    console.log(
      `\n   ➡️  릴리즈 이동: 예상=${moveIds.length}건 / 실제=${moved.length}건`,
    );
    for (const r of moved) {
      console.log(
        `         - 플랫폼: ${r.platform || 'N/A'}, 스토어: ${r.store || 'N/A'}, 스토어 앱 ID: ${r.store_app_id || 'N/A'} → 대상 게임 ID #${targetGameId}로 이동`,
      );
    }

    // 예상/실제 불일치 시, 어떤 id가 못 옮겨졌는지 즉시 추적
    if (moved.length !== moveIds.length) {
      const movedIds = new Set(moved.map((r: any) => Number(r.id)));
      const notMoved = moveIds.filter((id) => !movedIds.has(Number(id)));
      console.warn(`   ⚠️  이동되지 않은 id: [${notMoved.join(', ')}]`);
      // 디버그: 현재 행 상태 덤프
      if (notMoved.length) {
        const dump = await manager.query(
          `
        SELECT id, game_id,
               platform::text AS platform,
               store::text    AS store,
               store_app_id
        FROM public.game_releases
        WHERE id = ANY($1::bigint[])
        `,
          [notMoved],
        );
        console.warn('   ⚠️  이동 실패 행 덤프:', dump);
      }
    }
  } else {
    console.log(`\n   ℹ️  이동할 릴리즈 없음 (모두 중복 삭제됨)`);
  }

  // 디테일 삭제
  const sourceDetail = await manager.findOne(GameDetail, {
    where: { game_id: sourceGameId },
  });

  if (sourceDetail) {
    console.log(`\n   🗑️  원본 게임 (Source) 디테일 삭제:`);
    console.log(`         - 디테일 아이디: ${sourceDetail.id}`);
    console.log(
      `         - 디테일이 바라보던 아이디 ${sourceDetail.game_id}개`,
    );

    await manager.delete(GameDetail, { game_id: sourceGameId });
  } else {
    console.log(`\n   ℹ️  원본 게임 (Source) 디테일 없음`);
  }

  // rawg_id 이관
  console.log(
    `\n   🔄 RAWG ID 이관: ${sourceGame.rawg_id} → 대상 게임 (Target) ID #${targetGameId}로 이관`,
  );

  await manager
    .createQueryBuilder()
    .update(Game)
    .set({ rawg_id: null })
    .where('id = :id', { id: sourceGameId })
    .execute();

  await manager
    .createQueryBuilder()
    .update(Game)
    .set({ rawg_id: sourceGame.rawg_id })
    .where('id = :id', { id: targetGameId })
    .execute();

  // Source 게임 삭제
  await manager.delete(Game, { id: sourceGameId });
  console.log(
    `\n   ✅ 원본 게임 (Source) 삭제 완료: 게임 ID #${sourceGameId}, 게임 이름 "${sourceGame.name}"`,
  );
  console.log(
    `   ✅ 병합 완료: 대상 게임 (Target) 게임 ID #${targetGameId}, 게임 이름 "${targetGame.name}", RAWG ID ${sourceGame.rawg_id}, Steam ID ${targetGame.steam_id}\n`,
  );
}

void main().catch((error) => {
  console.error('스크립트 실행 중 오류가 발생했습니다:', error);
  process.exitCode = 1;
});
