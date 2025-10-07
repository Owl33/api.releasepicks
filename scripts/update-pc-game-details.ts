/**
 * PC 게임 Description 업데이트 스크립트
 *
 * 목적: platform_type이 'pc'인 모든 게임의 description을 Steam에서 가져와 무조건 덮어쓰기
 * 이유: 기존 description이 잘못 저장되어 있어 전체 재수집 필요
 *
 * 실행 방법:
 *   - Dry Run (실제 업데이트 안 함): npm run update:pc-details:dry
 *   - Dry Run 테스트 (10개): npm run update:pc-details:test
 *   - 실제 업데이트: npm run update:pc-details
 *   - 특정 개수만 처리: npx ts-node scripts/update-pc-game-details.ts --limit 100
 */

import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { DataSource } from 'typeorm';
import { Game, GameDetail } from '../src/entities';
import { SteamAppDetailsService } from '../src/steam/services/steam-appdetails.service';
import { setTimeout as sleep } from 'timers/promises';

const logger = new Logger('UpdatePcGameDetails');

interface UpdateStats {
  total: number;
  processed: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: Array<{ gameId: number; steamId: number; error: string }>;
}

interface ScriptOptions {
  dryRun: boolean;
  limit?: number;
}

function parseArgs(): ScriptOptions {
  const args = process.argv.slice(2);
  const options: ScriptOptions = {
    dryRun: args.includes('--dry-run'),
    limit: undefined,
  };

  const limitIndex = args.indexOf('--limit');
  if (limitIndex !== -1 && args[limitIndex + 1]) {
    options.limit = parseInt(args[limitIndex + 1], 10);
  }

  return options;
}

async function main() {
  const options = parseArgs();

  logger.log('🚀 PC 게임 header_image 업데이트 시작...');
  logger.log('⚠️ 주의: 기존 header_image 무조건 덮어씁니다!');
  logger.log('📝 업데이트 대상: platform_type = "pc"인 모든 게임');
  if (options.dryRun) {
    logger.warn('🔍 DRY RUN 모드: 실제로 업데이트하지 않습니다.');
  }
  if (options.limit) {
    logger.log(`📊 제한: 최대 ${options.limit}개 게임만 처리합니다.`);
  }

  // NestJS 앱 초기화
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  const dataSource = app.get(DataSource);
  const steamAppDetailsService = app.get(SteamAppDetailsService);

  const stats: UpdateStats = {
    total: 0,
    processed: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  try {
    // 1. platform_type이 'pc'이고 steam_id가 있는 게임들 조회
    logger.log('📋 업데이트 대상 게임 조회 중...');

    let query = dataSource
      .getRepository(Game)
      .createQueryBuilder('g')
      .leftJoinAndSelect('g.details', 'd')
      .where('d.platform_type = :platformType', { platformType: 'pc' })
      .andWhere('g.steam_id IS NOT NULL')
      .select(['g.id', 'g.steam_id', 'g.name', 'd.id']);

    if (options.limit) {
      query = query.limit(options.limit);
    }

    const games = await query.getMany();

    stats.total = games.length;
    logger.log(`✅ 총 ${stats.total}개의 PC 게임 발견`);

    if (stats.total === 0) {
      logger.warn('⚠️ 업데이트할 게임이 없습니다.');
      return;
    }

    // 사용자 확인 및 예상 시간 계산
    const RATE_LIMIT_WINDOW_SECONDS = 310; // 310초
    const RATE_LIMIT_MAX = 200; // 200개
    const estimatedWindows = Math.ceil(stats.total / RATE_LIMIT_MAX);
    const estimatedMinutes = Math.ceil((estimatedWindows * RATE_LIMIT_WINDOW_SECONDS) / 60);

    logger.log('\n⚠️ 주의: 이 작업은 Steam API Rate Limit으로 인해 시간이 오래 걸립니다.');
    logger.log(`   - 총 ${stats.total}개 게임 처리 예정`);
    logger.log(`   - Rate Limit: 310초당 200개 호출`);
    logger.log(`   - 예상 윈도우: ${estimatedWindows}개`);
    logger.log(`   - 예상 소요 시간: 약 ${estimatedMinutes}분`);
    logger.log('\n계속하려면 5초 기다립니다...\n');
    await sleep(5000);

    // 2. Rate Limit 설정 (310초에 200개)
    const RATE_LIMIT_WINDOW_MS = 310 * 1000; // 310초
    const RATE_LIMIT_MAX_CALLS = 200; // 최대 200개 호출
    let windowStartTime = Date.now();
    let callsInCurrentWindow = 0;

    // 3. 각 게임의 상세 정보 업데이트
    const gameDetailRepo = dataSource.getRepository(GameDetail);

    for (let i = 0; i < games.length; i++) {
      const game = games[i];
      stats.processed++;

      try {
        // 진행률 표시
        if (i % 10 === 0) {
          const elapsed = Math.floor((Date.now() - windowStartTime) / 1000);
          logger.log(
            `📊 진행률: ${stats.processed}/${stats.total} (${Math.round((stats.processed / stats.total) * 100)}%) | ` +
            `성공: ${stats.updated} | 스킵: ${stats.skipped} | 실패: ${stats.failed} | ` +
            `Rate Limit: ${callsInCurrentWindow}/${RATE_LIMIT_MAX_CALLS} (${elapsed}초 경과)`
          );
        }

        // Rate Limit 체크 및 대기
        if (callsInCurrentWindow >= RATE_LIMIT_MAX_CALLS) {
          const elapsedTime = Date.now() - windowStartTime;
          const remainingTime = RATE_LIMIT_WINDOW_MS - elapsedTime;

          if (remainingTime > 0) {
            const waitSeconds = Math.ceil(remainingTime / 1000);
            logger.warn(
              `⏸️ Rate Limit 도달 (${RATE_LIMIT_MAX_CALLS}개 호출) - ${waitSeconds}초 대기 중...`
            );
            await sleep(remainingTime);
          }

          // 윈도우 리셋
          windowStartTime = Date.now();
          callsInCurrentWindow = 0;
          logger.log('🔄 Rate Limit 윈도우 리셋 - 다시 시작합니다.');
        }

        // Steam AppDetails 조회
        const steamDetails = await steamAppDetailsService.fetchAppDetails(game.steam_id!);
        callsInCurrentWindow++; // 호출 카운트 증가

        if (!steamDetails) {
          logger.warn(`⚠️ Steam 데이터 없음: ${game.name} (${game.steam_id})`);
          stats.skipped++;
          continue;
        }

        // GameDetail 업데이트
        const detailId = game.details?.id;
        if (!detailId) {
          logger.warn(`⚠️ GameDetail 레코드 없음: ${game.name} (game_id: ${game.id})`);
          stats.skipped++;
          continue;
        }

        // description 가져오기 (무조건 덮어쓰기)
        const header_image = steamDetails.header_image;

        // Steam에 description이 없으면 스킵
        if (!header_image) {
          logger.warn(`⚠️ Steam에 description 없음: ${game.name}`);
          stats.skipped++;
          continue;
        }

        // 무조건 덮어쓰기 (기존 값이 잘못되어 있음)
        const updateData: Partial<GameDetail> = {
          header_image,
        };

        // Dry Run 모드가 아닐 때만 실제 업데이트
        if (!options.dryRun) {
          await gameDetailRepo.update(detailId, updateData);
        } else {
          logger.debug(`[DRY RUN] ${game.name} 업데이트 시뮬레이션 완료`);
        }

        stats.updated++;

      } catch (error) {
        stats.failed++;
        const errorMsg = error.message || String(error);
        stats.errors.push({
          gameId: game.id,
          steamId: game.steam_id!,
          error: errorMsg,
        });
        logger.error(`❌ 실패: ${game.name} (${game.steam_id}) - ${errorMsg}`);
      }
    }

    // 최종 결과
    logger.log('\n' + '='.repeat(60));
    logger.log('✅ PC 게임 header_image 업데이트 완료!');
    logger.log('='.repeat(60));
    logger.log(`📊 총 처리: ${stats.total}개`);
    logger.log(`   ✅ 업데이트 성공: ${stats.updated}개`);
    logger.log(`   ⏭️ 스킵 (이미 있음/데이터 없음): ${stats.skipped}개`);
    logger.log(`   ❌ 실패: ${stats.failed}개`);

    if (stats.errors.length > 0) {
      logger.log('\n❌ 실패한 게임 목록:');
      stats.errors.forEach((err, idx) => {
        logger.error(
          `   ${idx + 1}. Game ID: ${err.gameId}, Steam ID: ${err.steamId} - ${err.error}`
        );
      });
    }

  } catch (error) {
    logger.error('🚨 치명적 오류 발생:', error);
    throw error;
  } finally {
    await app.close();
  }
}

// 스크립트 실행
main()
  .then(() => {
    logger.log('✅ 스크립트 정상 종료');
    process.exit(0);
  })
  .catch((error) => {
    logger.error('🚨 스크립트 실행 실패:', error);
    process.exit(1);
  });
