import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DataSource, IsNull } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Game } from '../src/entities/game.entity';

async function main() {
  const rawgIds = [321226, 42370, 52390, 42236];

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const dataSource = app.get(DataSource);

  for (const rawgId of rawgIds) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`🔍 RAWG ID: ${rawgId}`);
    console.log('='.repeat(80));

    const rawgGame = await dataSource.getRepository(Game).findOne({
      where: { rawg_id: rawgId, steam_id: IsNull() },
    });

    if (!rawgGame) {
      console.log('❌ RAWG 게임을 찾을 수 없습니다.');
      continue;
    }

    console.log(`\n📋 RAWG 게임 정보:`);
    console.log(`   - ID: ${rawgGame.id}`);
    console.log(`   - name: "${rawgGame.name}"`);
    console.log(`   - og_name: "${rawgGame.og_name ?? 'null'}"`);
    console.log(`   - slug: "${rawgGame.slug}"`);
    console.log(`   - og_slug: "${rawgGame.og_slug ?? 'null'}"`);
    console.log(`   - release_date: ${rawgGame.release_date_date ?? 'null'}`);
    console.log(`   - popularity: ${rawgGame.popularity_score}`);

    // 유사한 이름의 Steam 게임 검색
    const nameQuery = rawgGame.og_name || rawgGame.name;
    const steamCandidates = await dataSource
      .getRepository(Game)
      .createQueryBuilder('game')
      .where('game.steam_id IS NOT NULL')
      .andWhere('game.rawg_id IS NULL')
      .andWhere(
        `(
          LOWER(game.name) LIKE LOWER(:pattern)
          OR LOWER(game.og_name) LIKE LOWER(:pattern)
          OR game.slug LIKE LOWER(:slug)
          OR game.og_slug LIKE LOWER(:slug)
        )`,
        {
          pattern: `%${nameQuery.slice(0, 10)}%`,
          slug: `%${rawgGame.slug?.slice(0, 15) ?? ''}%`,
        },
      )
      .orderBy('game.popularity_score', 'DESC')
      .take(3)
      .getMany();

    if (steamCandidates.length === 0) {
      console.log(`\n❓ 유사한 Steam 게임 후보를 찾지 못했습니다.`);
    } else {
      console.log(`\n🎮 Steam 후보 (${steamCandidates.length}개):`);
      steamCandidates.forEach((candidate, idx) => {
        console.log(`\n   [${idx + 1}] Steam ID: ${candidate.steam_id}`);
        console.log(`       - name: "${candidate.name}"`);
        console.log(`       - og_name: "${candidate.og_name ?? 'null'}"`);
        console.log(`       - slug: "${candidate.slug}"`);
        console.log(`       - og_slug: "${candidate.og_slug ?? 'null'}"`);
        console.log(
          `       - release_date: ${candidate.release_date_date ?? 'null'}`,
        );
        console.log(`       - popularity: ${candidate.popularity_score}`);
      });
    }
  }

  await app.close();
}

void main().catch((error) => {
  console.error('스크립트 실행 중 오류:', error);
  process.exitCode = 1;
});
