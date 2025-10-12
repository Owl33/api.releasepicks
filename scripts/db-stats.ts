import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DataSource, IsNull, Not } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Game } from '../src/entities/game.entity';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const dataSource = app.get(DataSource);
  const gameRepo = dataSource.getRepository(Game);

  console.log('\n📊 데이터베이스 통계');
  console.log('='.repeat(80));

  // 전체 게임 수
  const totalGames = await gameRepo.count();
  console.log(`\n전체 게임: ${totalGames.toLocaleString()}개`);

  // Steam 게임 (rawg_id 있음/없음)
  const steamWithRawg = await gameRepo.count({
    where: { steam_id: Not(IsNull()), rawg_id: Not(IsNull()) },
  });
  const steamOnlyCount = await gameRepo.count({
    where: { steam_id: Not(IsNull()), rawg_id: IsNull() },
  });
  const steamTotal = steamWithRawg + steamOnlyCount;

  console.log(`\nSteam 게임:`);
  console.log(`  - 전체: ${steamTotal.toLocaleString()}개`);
  console.log(`  - RAWG 매칭됨: ${steamWithRawg.toLocaleString()}개`);
  console.log(`  - RAWG 미매칭: ${steamOnlyCount.toLocaleString()}개`);

  // RAWG 게임 (steam_id 있음/없음)
  const rawgWithSteam = steamWithRawg; // 같은 수
  const rawgOnlyCount = await gameRepo.count({
    where: { rawg_id: Not(IsNull()), steam_id: IsNull() },
  });
  const rawgTotal = rawgWithSteam + rawgOnlyCount;

  console.log(`\nRAWG 게임:`);
  console.log(`  - 전체: ${rawgTotal.toLocaleString()}개`);
  console.log(`  - Steam 매칭됨: ${rawgWithSteam.toLocaleString()}개`);
  console.log(`  - Steam 미매칭: ${rawgOnlyCount.toLocaleString()}개`);

  // 인기도별 Steam 게임 분포
  console.log(`\nSteam 게임 인기도 분포 (RAWG 미매칭):`);
  const popularityCounts = await dataSource.query(`
    SELECT
      CASE
        WHEN popularity_score >= 80 THEN '80+'
        WHEN popularity_score >= 70 THEN '70-79'
        WHEN popularity_score >= 60 THEN '60-69'
        WHEN popularity_score >= 50 THEN '50-59'
        WHEN popularity_score >= 40 THEN '40-49'
        ELSE '< 40'
      END AS popularity_range,
      COUNT(*) as count
    FROM games
    WHERE steam_id IS NOT NULL
      AND rawg_id IS NULL
    GROUP BY popularity_range
    ORDER BY popularity_range DESC
  `);

  popularityCounts.forEach((row: any) => {
    console.log(`  ${row.popularity_range}: ${Number(row.count).toLocaleString()}개`);
  });

  // 매칭률 계산
  const matchRate = ((steamWithRawg / steamTotal) * 100).toFixed(2);
  console.log(`\n매칭률: ${matchRate}%`);
  console.log('='.repeat(80));

  await app.close();
}

void main().catch((error) => {
  console.error('스크립트 실행 중 오류:', error);
  process.exitCode = 1;
});
