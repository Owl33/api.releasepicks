/**
 * 인기도 재계산 스크립트 (followers_cache 기반)
 *
 * 대상: games.followers_cache IS NOT NULL 인 모든 레코드
 * 로직: PopularityCalculator.calculateSteamPopularity(followers_cache)
 *      (RAWG 혼합 없이, 요청대로 followers 기준만 반영)
 *
 * 실행:
 *  - Dry Run:       npx ts-node scripts/update-popularity-from-followers.ts --dry-run
 *  - 실제 업데이트: npx ts-node scripts/update-popularity-from-followers.ts
 *  - 제한 처리:     npx ts-node scripts/update-popularity-from-followers.ts --limit 1000
 *  - 배치 크기:     기본 500(옵션 --batch 1000 으로 변경 가능)
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { DataSource, Repository, MoreThan } from 'typeorm';
import { Game } from '../src/entities';
import { PopularityCalculator } from '../src/common/utils/popularity-calculator.util'; // 경로 맞게 수정

type ScriptOptions = {
  dryRun: boolean;
  limit?: number;
  batch?: number;
};

function parseArgs(): ScriptOptions {
  const args = process.argv.slice(2);
  const getArg = (flag: string) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };

  return {
    dryRun: args.includes('--dry-run'),
    limit: getArg('--limit') ? parseInt(getArg('--limit')!, 10) : undefined,
    batch: getArg('--batch') ? parseInt(getArg('--batch')!, 10) : 500,
  };
}

const logger = new Logger('UpdatePopularityFromFollowers');

async function main() {
  const options = parseArgs();
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  const dataSource = app.get(DataSource);
  const gameRepo: Repository<Game> = dataSource.getRepository(Game);

  logger.log('🚀 인기도 재계산 시작 (followers_cache 기반)');
  if (options.dryRun) logger.warn('🔍 DRY RUN 모드: DB 업데이트는 이루어지지 않습니다.');
  if (options.limit) logger.log(`📌 처리 상한(limit): ${options.limit}`);
  logger.log(`📦 배치 크기(batch): ${options.batch}`);

  // 총 대상 수 파악
  const total = await gameRepo
    .createQueryBuilder('g')
    .where('g.followers_cache IS NOT NULL')
    .getCount();

  const totalToProcess = options.limit ? Math.min(total, options.limit) : total;
  if (totalToProcess === 0) {
    logger.warn('⚠️ followers_cache가 있는 게임이 없습니다. 종료합니다.');
    await app.close();
    return;
  }

  logger.log(`✅ 총 대상: ${totalToProcess} / 전체(${total})`);

  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  // 커서 기반 배치 처리 (id ASC)
  let lastId = 0;
  while (processed < totalToProcess) {
    const remain = totalToProcess - processed;
    const take = Math.min(options.batch!, remain);

    const batch = await gameRepo.find({
      where: {
        id: MoreThan(lastId),
        // followers_cache IS NOT NULL 은 find 옵션에서 표현 불가 → 쿼리빌더로 대체
      } as any,
      order: { id: 'ASC' },
      take,
      select: ['id', 'name', 'followers_cache', 'popularity_score'],
    });

    // followers_cache IS NOT NULL 조건 보장 위해 쿼리 빌더로 다시 가져오기
    // (TypeORM find에서 IS NOT NULL 직표현 불가해서 안전하게 한 번 더 필터)
    const ids = batch.map((g) => g.id);
    if (ids.length === 0) break;

    const rows = await gameRepo
      .createQueryBuilder('g')
      .where('g.id IN (:...ids)', { ids })
      .andWhere('g.followers_cache IS NOT NULL')
      .orderBy('g.id', 'ASC')
      .select(['g.id', 'g.name', 'g.followers_cache', 'g.popularity_score'])
      .getMany();

    if (rows.length === 0) {
      lastId = batch[batch.length - 1].id;
      continue;
    }

    // 처리
    for (const g of rows) {
      processed++;
      lastId = g.id;

      try {
        const followers = Number(g.followers_cache);
        if (!Number.isFinite(followers) || followers < 0) {
          skipped++;
          if (processed % 200 === 0) {
            logger.warn(
              `⏭️ 스킵(id=${g.id}): followers_cache가 유효하지 않음 (${g.followers_cache})`,
            );
          }
          continue;
        }

        // 새 점수 계산 (followers 기반만)
        const newScore =
          PopularityCalculator.calculateSteamPopularity(followers);

        // 점수가 동일하면 스킵 (불필요 업데이트 방지)
        if (g.popularity_score === newScore) {
          skipped++;
        } else {
          if (!options.dryRun) {
            await gameRepo.update(g.id, { popularity_score: newScore });
          }
          updated++;
        }
      } catch (e: any) {
        failed++;
        logger.error(
          `❌ 실패(id=${g.id}, name="${g.name}") - ${e?.message || e}`,
        );
      }

      // 진행률 로그
      if (processed % 200 === 0 || processed === totalToProcess) {
        const pct = Math.round((processed / totalToProcess) * 100);
        logger.log(
          `📊 진행률: ${processed}/${totalToProcess} (${pct}%) | ✅ 업데이트 ${updated} ⏭️ 스킵 ${skipped} ❌ 실패 ${failed}`,
        );
      }

      if (processed >= totalToProcess) break;
    }
  }

  // 요약
  logger.log('='.repeat(48));
  logger.log('✅ 인기도 재계산 완료 (followers_cache 기반)');
  logger.log('='.repeat(48));
  logger.log(`총 대상:     ${totalToProcess}`);
  logger.log(`처리 완료:   ${processed}`);
  logger.log(`업데이트:    ${updated}`);
  logger.log(`스킵:        ${skipped}`);
  logger.log(`실패:        ${failed}`);
  logger.log(options.dryRun ? '🔍 DRY RUN: 실제 DB 변경 없음' : '📝 실제 DB 업데이트 수행');

  await app.close();
  process.exit(0);
}

main().catch((err) => {
  logger.error('🚨 스크립트 실행 실패:', err);
  process.exit(1);
});
