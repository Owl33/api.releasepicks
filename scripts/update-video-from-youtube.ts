/**
 * GameDetail.video_url만 유튜브 공식 트레일러로 재갱신하는 스크립트
 *
 * 사용법:
 *   - 드라이런:           npm run update:video:dry
 *   - 일부만(예: 100개):  npx ts-node scripts/update-video-from-youtube.ts --limit 100
 *   - 비어있는 것만:      (기본값) --only-empty
 *   - 강제 덮어쓰기:      --force
 *
 * package.json 예시 스크립트:
 *   "scripts": {
 *     "update:video": "ts-node scripts/update-video-from-youtube.ts",
 *     "update:video:dry": "ts-node scripts/update-video-from-youtube.ts --dry-run"
 *   }
 */

import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { DataSource } from 'typeorm';
import { Game, GameDetail } from '../src/entities';
import { setTimeout as sleep } from 'timers/promises';

// ⚠️ 프로젝트 구조에 맞춰 import 경로 조정하세요.
// 예) '../src/youtube/youtube.service' 또는 '../src/services/youtube.service'
import { YouTubeService } from '../src/youtube/youtube.service';

const logger = new Logger('UpdateVideoFromYouTube');

interface ScriptOptions {
  dryRun: boolean;
  limit?: number;
  force: boolean; // true이면 기존 video_url 있어도 덮어씀
  onlyEmpty: boolean; // true이면 video_url이 null/빈값인 것만 대상
  minDelayMs: number; // 요청간 최소 지연
  jitterMs: number; // 지터
}

function parseArgs(): ScriptOptions {
  const args = process.argv.slice(2);
  const getFlag = (flag: string) => args.includes(flag);
  const getNum = (flag: string, def?: number) => {
    const i = args.indexOf(flag);
    if (i !== -1 && args[i + 1]) return parseInt(args[i + 1], 10);
    return def;
  };

  return {
    dryRun: getFlag('--dry-run') || getFlag('--dry'),
    limit: getNum('--limit'),
    force: getFlag('--force'),
    onlyEmpty: !getFlag('--no-only-empty'), // 기본값 true, --no-only-empty 주면 false
    minDelayMs: getNum('--minDelayMs', 80)!,
    jitterMs: getNum('--jitterMs', 40)!,
  };
}

function randJitter(ms: number) {
  return Math.floor(Math.random() * ms);
}

async function main() {
  const opt = parseArgs();

  logger.log(
    '🎬 GameDetail.video_url 재갱신 시작 (YouTube 공식 트레일러 검색)',
  );
  logger.log(
    `🔧 옵션: dryRun=${opt.dryRun}, limit=${opt.limit ?? '∞'}, onlyEmpty=${opt.onlyEmpty}, force=${opt.force}`,
  );
  logger.log(
    `⏱️  지연: minDelayMs=${opt.minDelayMs}, jitterMs=${opt.jitterMs}`,
  );

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  const dataSource = app.get(DataSource);
  const yt = app.get(YouTubeService);

  const gameRepo = dataSource.getRepository(Game);
  const detailRepo = dataSource.getRepository(GameDetail);

  // 대상 쿼리: steam/rawg id가 모두 있고, details가 있는 게임
  let qb = gameRepo
    .createQueryBuilder('g')
    .leftJoinAndSelect('g.details', 'd')
    .where('g.steam_id IS NOT NULL')
    .andWhere('d.id IS NOT NULL');

  if (opt.onlyEmpty) {
    qb = qb.andWhere("(d.video_url IS NULL OR d.video_url = '' )");
  }

  if (opt.limit) {
    qb = qb.limit(opt.limit);
  }

  const targets = await qb
    .select(['g.id', 'g.name', 'g.steam_id', 'd.id', 'd.video_url'])
    .getMany();

  if (targets.length === 0) {
    logger.warn(
      '⚠️ 대상 게임이 없습니다. (조건을 완화하려면 --no-only-empty 또는 --force 사용)',
    );
    await app.close();
    return;
  }

  logger.log(`📋 대상 게임: ${targets.length}개`);

  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const game of targets) {
    processed += 1;

    // 진행률 로그 (10개마다)
    if (processed % 10 === 0 || processed === 1) {
      logger.log(
        `📊 진행률 ${processed}/${targets.length} | 성공 ${updated} · 스킵 ${skipped} · 실패 ${failed}`,
      );
    }

    try {
      const prefix = `[#${game.id}] ${game.name}: `;
      // 기존 값이 있고 force가 아니라면 스킵 (onlyEmpty=false 인 경우 대비)
      if (!opt.onlyEmpty && !opt.force && game.details?.video_url) {
        skipped++;
        logger.debug(prefix + '기존 video_url 존재 → force 아님 → 스킵');
        continue;
      }

      const t0 = Date.now();
      // 요청 간 지연
      await sleep(opt.minDelayMs + randJitter(opt.jitterMs));

      const result = await yt.findOfficialTrailer(game.name);
      const pickedUrl: string | undefined = result?.picked?.url;

      const elapsed = ((Date.now() - t0) / 1000).toFixed(2);

      if (!pickedUrl) {
        skipped++;
        logger.warn(prefix + `유튜브 결과 없음 (⏱️ ${elapsed}s)`);
        continue;
      }

      if (!opt.dryRun) {
        await detailRepo.update(game.details!.id, {
          video_url: pickedUrl,
          updated_at: new Date(),
        });
      }

      updated++;
      logger.log(
        prefix + `✅ video_url 업데이트: ${pickedUrl} (⏱️ ${elapsed}s)`,
      );
    } catch (e: any) {
      failed++;
      logger.error(
        `❌ [#${game.id}] ${game.name} 업데이트 실패: ${e?.message ?? e}`,
      );
    }
  }

  logger.log('='.repeat(60));
  logger.log('✅ 스크립트 완료');
  logger.log(
    `총 ${targets.length} | 성공 ${updated} · 스킵 ${skipped} · 실패 ${failed}`,
  );
  logger.log('='.repeat(60));

  await app.close();
}

main().catch((e) => {
  logger.error('🚨 스크립트 실패', e);
  process.exit(1);
});
