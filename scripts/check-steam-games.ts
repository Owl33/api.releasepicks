import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Game } from '../src/entities/game.entity';

async function main() {
  // 실제 Steam AppID들 (RAWG와 매칭되어야 할 게임들)
  const steamApps = [
    { appId: 703860, name: 'GRID', rawgName: 'GRID (2019)' },
    { appId: 269190, name: 'Edge of Eternity', rawgName: 'Edge of Eternity' },
    { appId: 613760, name: 'Garage', rawgName: 'Garage' },
    { appId: 250680, name: 'BELOW', rawgName: 'Below' },
  ];

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const dataSource = app.get(DataSource);

  for (const app of steamApps) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`🎮 Steam AppID: ${app.appId} (${app.name})`);
    console.log(`   RAWG 이름: ${app.rawgName}`);
    console.log('='.repeat(80));

    const steamGame = await dataSource.getRepository(Game).findOne({
      where: { steam_id: app.appId },
    });

    if (!steamGame) {
      console.log(`❌ DB에 Steam 게임이 없습니다.`);
      continue;
    }

    console.log(`\n✅ Steam 게임 발견:`);
    console.log(`   - ID: ${steamGame.id}`);
    console.log(`   - name: "${steamGame.name}"`);
    console.log(`   - og_name: "${steamGame.og_name ?? 'null'}"`);
    console.log(`   - slug: "${steamGame.slug}"`);
    console.log(`   - og_slug: "${steamGame.og_slug ?? 'null'}"`);
    console.log(`   - rawg_id: ${steamGame.rawg_id ?? 'null'}`);
    console.log(`   - release_date: ${steamGame.release_date_date ?? 'null'}`);

    if (steamGame.rawg_id) {
      console.log(`\n⚠️ 이미 RAWG ID ${steamGame.rawg_id}로 매칭되어 있습니다.`);
    }
  }

  await app.close();
}

void main().catch((error) => {
  console.error('스크립트 실행 중 오류:', error);
  process.exitCode = 1;
});
