/**
 * update-from-steam-details.overwrite.ts
 *
 * 목적(무조건 덮어쓰기):
 *  - games.name/slug/og_name/og_slug  = SteamAppDetailsService.fetchAppDetails().name 기반으로 덮어쓰기
 *  - game_details.sexual              = 서비스 계산값으로 덮어쓰기
 *  - ⚠️ description 은 업데이트하지 않음(제거)
 *
 * 실행:
 *  - Dry run:  npx ts-node scripts/migration/update-from-steam-details.overwrite.ts --dry-run
 *  - 제한:     npx ts-node scripts/migration/update-from-steam-details.overwrite.ts --limit 200
 *  - 로그:     --verbose
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { DataSource } from 'typeorm';
import { Game } from '../../src/entities/game.entity';
import { GameDetail } from '../../src/entities/game-detail.entity';
import { SteamAppDetailsService } from '../../src/steam/services/steam-appdetails.service';
import { normalizeGameName } from '../../src/common/utils/game-name-normalizer.util';

const logger = new Logger('OverwriteFromSteam');

type Opts = { dryRun: boolean; limit?: number; verbose: boolean };
function parseArgs(): Opts {
  const args = process.argv.slice(2);
  const getNum = (flag: string) => {
    const i = args.indexOf(flag);
    if (i >= 0 && args[i + 1]) {
      const n = Number(args[i + 1]);
      return Number.isFinite(n) ? n : undefined;
    }
  };
  return {
    dryRun: args.includes('--dry-run'),
    limit: getNum('--limit'),
    verbose: args.includes('--verbose'),
  };
}

async function run() {
  const opts = parseArgs();

  logger.log('🚀 Overwrite from Steam details 시작');
  if (opts.dryRun) logger.warn('🔍 DRY RUN: 실제 DB 변경 없음');
  if (opts.limit) logger.log(`📌 최대 ${opts.limit}건만 처리`);
  logger.log(`옵션: verbose=${opts.verbose}`);

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const dataSource = app.get(DataSource);
  const gameRepo = dataSource.getRepository(Game);
  const detailRepo = dataSource.getRepository(GameDetail);
  const steamSvc = app.get(SteamAppDetailsService);

  // 대상: steam_id 있고 1:1 details 조인
  const qb = gameRepo
    .createQueryBuilder('g')
    .innerJoinAndSelect('g.details', 'd') // ✅ details 없는 게임 제외
    .where('g.steam_id IS NOT NULL')
    .select([
      'g.id',
      'g.name',
      'g.slug',
      'g.og_name',
      'g.og_slug',
      'g.steam_id',
      'd.id',
      'd.sexual',
      'd.game_id',
    ])
    .orderBy('g.id', 'ASC');

  if (opts.limit) qb.limit(opts.limit); // 필요시 유지

  const games = await qb.getMany();
  logger.log(`📥 대상: ${games.length}개`);

  let processed = 0;
  let updatedGames = 0;
  let updatedDetails = 0;
  let skippedNoDetail = 0;
  let skippedNoSteam = 0;
  let failed = 0;

  for (const g of games) {
    processed++;
    try {
      if (!g.details?.id) {
        skippedNoDetail++;
        if (opts.verbose) logger.warn(`⏭️ details 없음: #${g.id} ${g.name}`);
        continue;
      }

      const steam = await steamSvc.fetchAppDetails(g.steam_id!);
      if (!steam) {
        skippedNoSteam++;
        if (opts.verbose)
          logger.warn(
            `⏭️ Steam 없음: #${g.id}번
             ${g.name} 
             (steam_id=${g.steam_id})`,
          );
        continue;
      }

      // 무조건 덮어쓰기용 값 계산
      const finalName = steam.name ?? g.name; // 이름이 비어올 일은 드묾
      const finalSlug = normalizeGameName(finalName);
      const finalOgName = g.name;
      const finalOgSlug = normalizeGameName(g.name);

      // sexual: 서비스 계산값을 무조건 반영 (없으면 false로 강제)
      const svcSexual = (steam as any).sexual;
      const finalSexual = typeof svcSexual === 'boolean' ? svcSexual : false;

      if (opts.verbose) {
        logger.log(
          `#${g.id}번 
          "기존 ${g.name}" → 신규  name="${finalName}",
           slug="${finalSlug}", 
          og_name="${finalOgName}",
          og_slug="${finalOgSlug}", 
          sexual=${finalSexual}`,
        );
      }

      if (!opts.dryRun) {
        await dataSource.transaction(async (manager) => {
          // games 덮어쓰기
          g.name = finalName;
          g.slug = finalSlug;
          (g as any).og_name = finalOgName;
          (g as any).og_slug = finalOgSlug;
          g.updated_at = new Date();
          await manager.getRepository(Game).save(g);
          updatedGames++;

          // game_details 존재할 때만 덮어쓰기 (생성 X)
          const dRepo = manager.getRepository(GameDetail);
          if (!g.details?.id) {
            // 존재 안 하면 스킵
            skippedNoDetail++;
            if (opts.verbose) {
              logger.warn(
                `⏭️ details 없음: #${g.id} ${g.name} — sexual 업데이트 스킵`,
              );
            }
            return; // 트랜잭션 블록 종료
          }

          await dRepo.update(g.details.id, {
            // 컬럼명이 오타(sexaul)라면 아래 라인만 교체하세요.
            sexual: finalSexual,
            // sexaul: finalSexual,
            updated_at: new Date(),
          } as any);
          updatedDetails++;
        });
      }

      if (processed % 25 === 0 || processed === games.length) {
        logger.log(
          `📊 ${processed}/${games.length} | game↑ ${updatedGames} | detail↑ ${updatedDetails} | ndetail ${skippedNoDetail} | nsteam ${skippedNoSteam} | ❌ ${failed}`,
        );
      }
    } catch (e: any) {
      failed++;
      logger.error(`❌ 실패: #${g.id} ${g.name} → ${e?.message ?? e}`);
    }
  }

  logger.log('—'.repeat(60));
  logger.log('✅ 완료 요약');
  logger.log(`처리: ${processed}`);
  logger.log(`games 업데이트: ${updatedGames}`);
  logger.log(`details 업데이트: ${updatedDetails}`);
  logger.log(`스킵(details 없음): ${skippedNoDetail}`);
  logger.log(`스킵(Steam 없음): ${skippedNoSteam}`);
  logger.log(`실패: ${failed}`);
  logger.log('—'.repeat(60));

  await app.close();
}

run().catch((err) => {
  logger.error('🚨 스크립트 실패 종료', err);
  process.exit(1);
});
