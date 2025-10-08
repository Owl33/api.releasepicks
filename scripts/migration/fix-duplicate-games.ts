/**
 * 마이그레이션 스크립트: 특수 문자로 인한 중복 게임 제거
 *
 * 목적:
 * - 그리스 문자(Δ, Ω 등), 로마 숫자(Ⅶ, Ⅲ 등) 표기 차이로 중복 생성된 게임 정리
 * - 예시: Metal Gear Solid Δ (Steam) vs Metal Gear Solid Delta (RAWG)
 *
 * 실행 방법:
 * ```bash
 * npx ts-node scripts/migration/fix-duplicate-games.ts [--dry-run] [--verbose]
 * ```
 *
 * 작성일: 2025-10-08
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { DataSource } from 'typeorm';
import { Game } from '../../src/entities/game.entity';
import { GameDetail } from '../../src/entities/game-detail.entity';
import { GameRelease } from '../../src/entities/game-release.entity';
import { GameCompanyRole } from '../../src/entities/game-company-role.entity';
import { normalizeGameName } from '../../src/common/utils/game-name-normalizer.util';

interface DuplicateGroup {
  normalizedSlug: string;
  games: Game[];
  keepGame: Game; // 유지할 게임
  removeGames: Game[]; // 삭제할 게임들
}

interface MigrationStats {
  totalGames: number;
  duplicateGroups: number;
  gamesRemoved: number;
  gamesUpdated: number;
  errors: string[];
}

// CLI 인자 파싱
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isVerbose = args.includes('--verbose');

// Logger 생성
const logger = new Logger('FixDuplicateGames');

/**
 * 중복 게임 그룹 식별
 */
function identifyDuplicateGroups(games: Game[]): DuplicateGroup[] {
  // 정규화된 slug로 그룹화
  const slugMap = new Map<string, Game[]>();

  for (const game of games) {
    const normalizedSlug = normalizeGameName(game.name);
    if (!slugMap.has(normalizedSlug)) {
      slugMap.set(normalizedSlug, []);
    }
    slugMap.get(normalizedSlug)!.push(game);
  }

  // 중복이 있는 그룹만 필터링
  const duplicateGroups: DuplicateGroup[] = [];

  for (const [normalizedSlug, groupGames] of slugMap.entries()) {
    if (groupGames.length > 1) {
      // 유지할 게임 선정 (우선순위: Steam ID > RAWG ID > 팔로워 수 > 최신)
      const sortedGames = [...groupGames].sort((a, b) => {
        // 1. Steam ID 있는 게임 우선
        if (a.steam_id && !b.steam_id) return -1;
        if (!a.steam_id && b.steam_id) return 1;

        // 2. RAWG ID 있는 게임 우선
        if (a.rawg_id && !b.rawg_id) return -1;
        if (!a.rawg_id && b.rawg_id) return 1;

        // 3. 팔로워 수 많은 게임 우선
        const aFollowers = a.followers_cache || 0;
        const bFollowers = b.followers_cache || 0;
        if (aFollowers !== bFollowers) return bFollowers - aFollowers;

        // 4. 최신 데이터 우선
        return b.updated_at.getTime() - a.updated_at.getTime();
      });

      const keepGame = sortedGames[0];
      const removeGames = sortedGames.slice(1);

      duplicateGroups.push({
        normalizedSlug,
        games: groupGames,
        keepGame,
        removeGames,
      });
    }
  }

  return duplicateGroups;
}

/**
 * 게임 데이터 병합
 */
async function mergeGameData(
  dataSource: DataSource,
  group: DuplicateGroup,
): Promise<void> {
  const { keepGame, removeGames } = group;

  // ⚠️ 주의: slug 업데이트는 삭제 후 수행 (unique constraint 위반 방지)

  // 관련 테이블 데이터 이동
  const gameRepo = dataSource.getRepository(Game);
  const detailRepo = dataSource.getRepository(GameDetail);
  const releaseRepo = dataSource.getRepository(GameRelease);
  const companyRoleRepo = dataSource.getRepository(GameCompanyRole);

  for (const removeGame of removeGames) {
    // GameDetail 이동 (유지할 게임에 없을 경우에만)
    const keepDetail = await detailRepo.findOne({
      where: { game_id: keepGame.id },
    });

    if (!keepDetail) {
      const removeDetail = await detailRepo.findOne({
        where: { game_id: removeGame.id },
      });

      if (removeDetail) {
        removeDetail.game_id = keepGame.id;
        await detailRepo.save(removeDetail);
      }
    }

    // GameRelease 이동 (Unique constraint 고려)
    const removeReleases = await releaseRepo.find({
      where: { game_id: removeGame.id },
    });

    for (const release of removeReleases) {
      // 동일한 (platform, store, store_app_id) 조합이 이미 존재하는지 확인
      const exists = await releaseRepo.findOne({
        where: {
          game_id: keepGame.id,
          platform: release.platform,
          store: release.store,
          store_app_id: release.store_app_id,
        },
      });

      if (!exists) {
        // 중복 없으면 이동
        release.game_id = keepGame.id;
        await releaseRepo.save(release);
      } else {
        // 중복이면 더 완전한 데이터로 병합
        let needsUpdate = false;

        // followers는 최대값 선택
        if (release.followers && (!exists.followers || release.followers > exists.followers)) {
          exists.followers = release.followers;
          needsUpdate = true;
        }

        // reviews_total은 최대값 선택
        if (release.reviews_total && (!exists.reviews_total || release.reviews_total > exists.reviews_total)) {
          exists.reviews_total = release.reviews_total;
          needsUpdate = true;
        }

        // release_date는 더 정확한 것 선택 (null이 아닌 것 우선)
        if (release.release_date_date && !exists.release_date_date) {
          exists.release_date_date = release.release_date_date;
          exists.release_date_raw = release.release_date_raw;
          exists.release_status = release.release_status;
          exists.coming_soon = release.coming_soon;
          needsUpdate = true;
        }

        // 가격 정보가 없으면 추가
        if (release.current_price_cents && !exists.current_price_cents) {
          exists.current_price_cents = release.current_price_cents;
          exists.is_free = release.is_free;
          needsUpdate = true;
        }

        if (needsUpdate) {
          exists.updated_at = new Date();
          await releaseRepo.save(exists);
        }

        // 삭제할 게임의 release는 제거 (CASCADE로 자동 삭제되지만 명시적으로 처리)
        await releaseRepo.remove(release);
      }
    }

    // GameCompanyRole 이동 (중복 방지)
    const removeCompanyRoles = await companyRoleRepo.find({
      where: { game_id: removeGame.id },
    });

    for (const role of removeCompanyRoles) {
      // 같은 회사+역할이 이미 존재하는지 확인
      const exists = await companyRoleRepo.findOne({
        where: {
          game_id: keepGame.id,
          company_id: role.company_id,
          role: role.role,
        },
      });

      if (!exists) {
        role.game_id = keepGame.id;
        await companyRoleRepo.save(role);
      } else {
        // 중복이면 삭제
        await companyRoleRepo.remove(role);
      }
    }
  }
}

/**
 * 중복 게임 삭제
 */
async function removeDuplicateGames(
  dataSource: DataSource,
  group: DuplicateGroup,
): Promise<void> {
  const gameRepo = dataSource.getRepository(Game);

  for (const removeGame of group.removeGames) {
    await gameRepo.remove(removeGame);
  }
}

/**
 * 유지할 게임 업데이트 (삭제 후 실행)
 * - slug 정규화
 - 외부 ID 병합
 * - 팔로워/인기도 병합
 */
async function updateKeepGame(
  dataSource: DataSource,
  group: DuplicateGroup,
): Promise<void> {
  const { keepGame, removeGames } = group;
  const gameRepo = dataSource.getRepository(Game);

  let needsUpdate = false;

  // 삭제된 게임들로부터 데이터 병합
  for (const removeGame of removeGames) {
    // Steam ID 병합
    if (!keepGame.steam_id && removeGame.steam_id) {
      keepGame.steam_id = removeGame.steam_id;
      needsUpdate = true;
    }

    // RAWG ID 병합
    if (!keepGame.rawg_id && removeGame.rawg_id) {
      keepGame.rawg_id = removeGame.rawg_id;
      needsUpdate = true;
    }

    // 팔로워 수는 최대값 선택
    const removeFollowers = removeGame.followers_cache || 0;
    const keepFollowers = keepGame.followers_cache || 0;
    if (removeFollowers > keepFollowers) {
      keepGame.followers_cache = removeFollowers;
      needsUpdate = true;
    }

    // 인기도 점수는 최대값 선택
    if (removeGame.popularity_score > keepGame.popularity_score) {
      keepGame.popularity_score = removeGame.popularity_score;
      needsUpdate = true;
    }
  }

  // slug를 정규화된 값으로 업데이트
  const normalizedSlug = normalizeGameName(keepGame.name);
  if (keepGame.slug !== normalizedSlug) {
    keepGame.slug = normalizedSlug;
    needsUpdate = true;
  }

  // 업데이트 수행
  if (needsUpdate) {
    keepGame.updated_at = new Date();
    await gameRepo.save(keepGame);
  }
}

/**
 * 모든 게임의 slug를 정규화된 값으로 업데이트
 */
async function normalizeAllSlugs(dataSource: DataSource): Promise<number> {
  const gameRepo = dataSource.getRepository(Game);
  const allGames = await gameRepo.find();

  let updatedCount = 0;

  for (const game of allGames) {
    const normalizedSlug = normalizeGameName(game.name);
    if (game.slug !== normalizedSlug) {
      game.slug = normalizedSlug;
      game.updated_at = new Date();
      await gameRepo.save(game);
      updatedCount++;
    }
  }

  return updatedCount;
}

/**
 * 메인 마이그레이션 실행
 */
async function runMigration(): Promise<void> {
  logger.log('🚀 중복 게임 정리 마이그레이션 시작');

  if (isDryRun) {
    logger.warn('⚠️  DRY RUN 모드: 실제 변경은 수행되지 않습니다.');
  }

  const stats: MigrationStats = {
    totalGames: 0,
    duplicateGroups: 0,
    gamesRemoved: 0,
    gamesUpdated: 0,
    errors: [],
  };

  // NestJS 앱 부트스트랩
  logger.log('📡 NestJS 앱 초기화 중...');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  const dataSource = app.get(DataSource);

  try {
    logger.log('✅ 데이터베이스 연결 성공');

    // 2. 모든 게임 조회
    logger.log('📥 게임 데이터 조회 중...');
    const gameRepo = dataSource.getRepository(Game);
    const allGames = await gameRepo.find();
    stats.totalGames = allGames.length;
    logger.log(`✅ 총 ${stats.totalGames}개 게임 조회 완료`);

    // 3. 중복 게임 그룹 식별
    logger.log('🔍 중복 게임 그룹 식별 중...');
    const duplicateGroups = identifyDuplicateGroups(allGames);
    stats.duplicateGroups = duplicateGroups.length;

    if (duplicateGroups.length === 0) {
      logger.log('✅ 중복 게임이 없습니다!');
      await app.close();
      return;
    }

    logger.warn(`⚠️  ${duplicateGroups.length}개 중복 그룹 발견`);

    // 4. 중복 게임 상세 정보 출력
    logger.log('📋 중복 게임 목록:');
    for (const group of duplicateGroups) {
      logger.log(`  ▪️ ${group.normalizedSlug}`);
      logger.log(`    - 유지: ID ${group.keepGame.id} | ${group.keepGame.name}`);
      logger.log(
        `      (Steam: ${group.keepGame.steam_id || 'X'}, RAWG: ${group.keepGame.rawg_id || 'X'}, Followers: ${group.keepGame.followers_cache || 0})`,
      );

      for (const removeGame of group.removeGames) {
        logger.log(
          `    - 삭제: ID ${removeGame.id} | ${removeGame.name}`,
        );
        logger.log(
          `      (Steam: ${removeGame.steam_id || 'X'}, RAWG: ${removeGame.rawg_id || 'X'}, Followers: ${removeGame.followers_cache || 0})`,
        );
      }
    }

    if (isDryRun) {
      logger.warn('⚠️  DRY RUN 모드이므로 실제 변경은 수행되지 않습니다.');
      await app.close();
      return;
    }

    // 5. 사용자 확인
    logger.warn('⚠️  위의 게임들을 병합하고 삭제하시겠습니까?');
    logger.warn('   계속하려면 Ctrl+C를 누르지 말고 기다리세요 (5초 후 진행)...');

    await new Promise((resolve) => setTimeout(resolve, 5000));

    // 6. 중복 게임 병합 및 삭제
    logger.log('🔄 중복 게임 병합 및 삭제 진행 중...');

    for (const group of duplicateGroups) {
      try {
        if (isVerbose) {
          logger.log(`  처리 중: ${group.normalizedSlug}`);
        }

        // 1. 관련 데이터 이동 (GameDetail, GameRelease, GameCompanyRole)
        await mergeGameData(dataSource, group);

        // 2. 중복 게임 삭제 (slug unique constraint 해제)
        await removeDuplicateGames(dataSource, group);

        // 3. 유지할 게임 업데이트 (slug 정규화 + 외부 ID 병합)
        await updateKeepGame(dataSource, group);

        stats.gamesRemoved += group.removeGames.length;
        stats.gamesUpdated++;

        if (isVerbose) {
          logger.log(`  ✅ 완료: ${group.removeGames.length}개 게임 삭제`);
        }
      } catch (error) {
        const errorMsg = `${group.normalizedSlug}: ${(error as Error).message}`;
        stats.errors.push(errorMsg);
        logger.error(`  ❌ 오류: ${errorMsg}`);
      }
    }

    // 7. 나머지 게임의 slug 정규화
    logger.log('🔄 모든 게임의 slug 정규화 중...');
    const normalizedCount = await normalizeAllSlugs(dataSource);
    logger.log(`✅ ${normalizedCount}개 게임의 slug 업데이트 완료`);

    // 8. 최종 검증
    logger.log('🔍 최종 검증 중...');
    const finalGames = await gameRepo.find();
    const finalDuplicates = identifyDuplicateGroups(finalGames);

    if (finalDuplicates.length === 0) {
      logger.log('✅ 중복 게임 없음 확인!');
    } else {
      logger.warn(
        `⚠️  여전히 ${finalDuplicates.length}개 중복 그룹이 존재합니다.`,
      );
    }

    // 9. 결과 요약
    logger.log('📊 마이그레이션 완료 요약:');
    logger.log(`  - 총 게임 수: ${stats.totalGames}`);
    logger.log(`  - 중복 그룹 수: ${stats.duplicateGroups}`);
    logger.log(`  - 삭제된 게임: ${stats.gamesRemoved}`);
    logger.log(`  - 업데이트된 게임: ${stats.gamesUpdated + normalizedCount}`);
    logger.log(`  - 오류 발생: ${stats.errors.length}`);

    if (stats.errors.length > 0) {
      logger.error('❌ 오류 목록:');
      stats.errors.forEach((err) => logger.error(`  - ${err}`));
    }

    logger.log('✅ 마이그레이션 성공!');
  } catch (error) {
    logger.error('❌ 마이그레이션 실패:', (error as Error).message);
    logger.error((error as Error).stack);
    await app.close();
    process.exit(1);
  } finally {
    await app.close();
    logger.log('📡 NestJS 앱 종료');
  }
}

// 실행
runMigration().catch((error) => {
  logger.error('💥 치명적 오류:', error);
  process.exit(1);
});
