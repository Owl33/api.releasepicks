import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { MultiPlatformMatchingService } from '../src/pipeline/persistence/services/multi-platform-matching.service';
import { ProcessedGameData } from '@pipeline/contracts';

async function run() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const matching = app.get(MultiPlatformMatchingService);
  const dataSource = app.get(DataSource);

  const data: ProcessedGameData = {
    name: 'Titan Quest 2',
    ogName: 'Titan Quest 2',
    slug: 'titan-quest-2',
    ogSlug: 'titan-quest-2',
    rawgId: 469645,
    steamId: undefined,
    gameType: 'game',
    parentRawgId: undefined,
    parentSteamId: undefined,
    releaseDate: new Date('2025-08-01'),
    releaseDateRaw: '2025-08-01',
    releaseStatus: 'released',
    comingSoon: false,
    popularityScore: 53,
    details: undefined,
    companies: undefined,
    releases: [],
    matchingContext: {
      source: 'rawg',
      normalizedName: {
        lowercase: 'titan quest 2',
        tokens: ['titan', 'quest', '2'],
        compact: 'titanquest2',
        looseSlug: 'titan-quest-2',
      },
      releaseDateIso: '2025-08-01',
      candidateSlugs: ['titan-quest-2', 'titan-quest-ii'],
    },
  } as any;

  const manager = dataSource.manager;
  const result = await matching.evaluate(data, manager);
  console.log(result);
  await app.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
