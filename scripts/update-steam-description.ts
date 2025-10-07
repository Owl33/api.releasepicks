/**
 * Steam 상세 설명(description)만 갱신 스크립트
 *
 * 목적:
 *   - games.steam_id가 존재하는 모든 게임의 game_details.description만
 *     Steam 상세 설명(detailed_description)으로 업데이트
 *
 * 실행:
 *   - Dry Run: npx ts-node scripts/update-steam-description.ts --dry-run
 *   - 개수 제한: npx ts-node scripts/update-steam-description.ts --limit 200
 *   - 실제 실행: npx ts-node scripts/update-steam-description.ts
 *
 * 주의:
 *   - description 이외의 필드는 절대 변경하지 않습니다.
 *   - game_details 레코드가 없거나 Steam 데이터가 없으면 건너뜁니다.
 */

import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { DataSource } from 'typeorm';
import { Game, GameDetail } from '../src/entities';
import { SteamAppDetailsService } from '../src/steam/services/steam-appdetails.service';

const logger = new Logger('UpdateSteamDescription');

interface ScriptOptions {
  dryRun: boolean;
  limit?: number;
}

interface Stats {
  total: number;
  processed: number;
  updated: number;
  skippedNoDetail: number;
  skippedNoSteamData: number;
  skippedNoChange: number;
  failed: number;
  errors: Array<{ gameId: number; steamId: number | null; error: string }>;
}

function parseArgs(): ScriptOptions {
  const args = process.argv.slice(2);
  const options: ScriptOptions = {
    dryRun: args.includes('--dry-run'),
    limit: undefined,
  };
  const limitIdx = args.indexOf('--limit');
  if (limitIdx !== -1 && args[limitIdx + 1]) {
    const n = Number(args[limitIdx + 1]);
    if (!Number.isNaN(n) && n > 0) options.limit = n;
  }
  return options;
}

/** 문자열 정규화: null/빈문자 → null, 줄바꿈/공백 차이 최소화 비교용 */
function normalizeDesc(s: string | null | undefined): string | null {
  if (s == null) return null;
  const trimmed = s.replace(/\r\n/g, '\n').trim();
  return trimmed.length ? trimmed : null;
}

async function main() {
  const options = parseArgs();

  logger.log('🚀 Steam 상세 설명(description) 일괄 갱신 시작');
  if (options.dryRun) logger.warn('🔍 DRY RUN 모드: 실제 DB 업데이트 없음');
  if (options.limit) logger.log(`📌 최대 ${options.limit}개만 처리`);

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  const dataSource = app.get(DataSource);
  const steamDetailsSvc = app.get(SteamAppDetailsService);
  const detailRepo = dataSource.getRepository(GameDetail);

  const stats: Stats = {
    total: 0,
    processed: 0,
    updated: 0,
    skippedNoDetail: 0,
    skippedNoSteamData: 0,
    skippedNoChange: 0,
    failed: 0,
    errors: [],
  };

  try {
    // 대상: steam_id가 존재 & 1:1 관계의 details가 조인되는 게임들
    let qb = dataSource
      .getRepository(Game)
      .createQueryBuilder('g')
      .leftJoinAndSelect('g.details', 'd')
      .where('g.steam_id IS NOT NULL')
      .select([
        'g.id',
        'g.name',
        'g.steam_id',
        'd.id',
        'd.description',
      ])
      .orderBy('g.id', 'ASC');

    if (options.limit) qb = qb.limit(options.limit);

    const games = await qb.getMany();
    stats.total = games.length;

    if (!stats.total) {
      logger.warn('⚠️ 대상 게임이 없습니다 (steam_id 존재 조건).');
      return;
    }

    logger.log(`✅ 대상: ${stats.total}개 게임 (steam_id 존재)`);

    for (let i = 0; i < games.length; i++) {
      const game = games[i];
      stats.processed++;

      try {
        if (!game.details?.id) {
          stats.skippedNoDetail++;
          if (stats.processed % 25 === 1) {
            logger.warn(
              `⏭️ game_details 없음 → 스킵: ${game.name} (game_id=${game.id})`,
            );
          }
          continue;
        }

        // Steam 앱 상세 가져오기
        const steamId = game.steam_id!;
        const steam = await steamDetailsSvc.fetchAppDetails(steamId);

        if (!steam) {
          stats.skippedNoSteamData++;
          if (stats.processed % 25 === 1) {
            logger.warn(
              `⏭️ Steam 상세 없음 → 스킵: ${game.name} (steam_id=${steamId})`,
            );
          }
          continue;
        }

        const currentDesc = game.details.description;
        const newDesc = steam.detailed_description;

        // 변경 없음 → 스킵
        // if (currentDesc === newDesc) {
        //   stats.skippedNoChange++;
        //   if (stats.processed % 50 === 1) {
        //     logger.log(
        //       `= 동일 → 스킵: ${game.name} (steam_id=${steamId})`,
        //     );
        //   }
        //   continue;
        // }

        // 업데이트 실행 (description만!)
        if (!options.dryRun) {
          await detailRepo.update(game.details.id, {
            description: newDesc, // 나머지 필드는 전혀 건드리지 않음
          });
        }

        stats.updated++;
        if (stats.processed % 10 === 0 || i === games.length - 1) {
          logger.log(
            `📊 진행 ${stats.processed}/${stats.total} | ✅ 업데이트 ${stats.updated} | ⏭️ 동일 ${stats.skippedNoChange} | ndetail ${stats.skippedNoDetail} | nsteam ${stats.skippedNoSteamData} | ❌ ${stats.failed}`,
          );
        }
      } catch (e: any) {
        stats.failed++;
        const msg = e?.message ?? String(e);
        stats.errors.push({ gameId: game.id, steamId: game.steam_id ?? null, error: msg });
        logger.error(
          `❌ 실패: ${game.name} (id=${game.id}, steam_id=${game.steam_id}) - ${msg}`,
        );
      }
    }

    // 결과 요약
    logger.log('\n' + '-'.repeat(60));
    logger.log('✅ 완료: Steam 상세 설명(description) 갱신');
    logger.log('-'.repeat(60));
    logger.log(`총 대상: ${stats.total}`);
    logger.log(`처리됨: ${stats.processed}`);
    logger.log(`업데이트됨: ${stats.updated}`);
    logger.log(`스킵(동일): ${stats.skippedNoChange}`);
    logger.log(`스킵(details 없음): ${stats.skippedNoDetail}`);
    logger.log(`스킵(Steam 데이터 없음): ${stats.skippedNoSteamData}`);
    logger.log(`실패: ${stats.failed}`);

    if (stats.errors.length) {
      logger.warn('\n❌ 실패 목록:');
      stats.errors.forEach((er, i) => {
        logger.warn(
          `  ${i + 1}. game_id=${er.gameId}, steam_id=${er.steamId} → ${er.error}`,
        );
      });
    }
  } catch (err) {
    logger.error('🚨 스크립트 치명적 오류', err);
    throw err;
  } finally {
    await app.close();
  }
}

main()
  .then(() => {
    logger.log('✅ 스크립트 정상 종료');
    process.exit(0);
  })
  .catch((err) => {
    logger.error('🚨 스크립트 실패 종료', err);
    process.exit(1);
  });
