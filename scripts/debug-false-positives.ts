import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Game } from '../src/entities/game.entity';
import {
  calcMatchingScore,
  normalizeGameName,
} from '../src/common/matching';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const dataSource = app.get(DataSource);
  const gameRepo = dataSource.getRepository(Game);

  // False positive 케이스들
  const cases = [
    {
      name: 'Resident Evil Re:Verse vs BIOHAZARD RE:4',
      rawgId: 545033,
      steamId: 2050650,
      expectedScore: 0.5577,
    },
    {
      name: 'Subnautica vs 서브노티카 2',
      rawgId: 10419,
      steamId: 1962700,
      expectedScore: 0.5275,
    },
    {
      name: 'Persona 5 vs 페르소나 5 스크램블 더 팬텀 스트라이커즈',
      rawgId: 49,
      steamId: 1382330,
      expectedScore: 0.4544,
    },
  ];

  for (const testCase of cases) {
    console.log('\n' + '='.repeat(100));
    console.log(`🔍 FALSE POSITIVE 분석: ${testCase.name}`);
    console.log(`   (예상 스코어: ${testCase.expectedScore})`);
    console.log('='.repeat(100));

    // 1. RAWG 게임 로드
    const rawgGame = await gameRepo.findOne({
      where: { rawg_id: testCase.rawgId },
      relations: ['details', 'company_roles', 'company_roles.company'],
    });

    if (!rawgGame) {
      console.log(`❌ RAWG 게임 rawg_id=${testCase.rawgId}를 찾을 수 없습니다.`);
      continue;
    }

    // 2. Steam 게임 로드
    const steamGame = await gameRepo.findOne({
      where: { steam_id: testCase.steamId },
      relations: ['details', 'company_roles', 'company_roles.company'],
    });

    if (!steamGame) {
      console.log(`❌ Steam 게임 steam_id=${testCase.steamId}를 찾을 수 없습니다.`);
      continue;
    }

    console.log('\n📋 RAWG 게임 정보 (internal ID: ' + rawgGame.id + ')');
    console.log('-'.repeat(100));
    console.log(`name: "${rawgGame.name}"`);
    console.log(`og_name: "${rawgGame.og_name ?? 'null'}"`);
    console.log(`slug: "${rawgGame.slug}"`);
    console.log(`og_slug: "${rawgGame.og_slug ?? 'null'}"`);
    console.log(`release_date: ${rawgGame.release_date_date ?? 'null'}`);
    console.log(`rawg_id: ${rawgGame.rawg_id ?? 'null'}`);
    console.log(`steam_id: ${rawgGame.steam_id ?? 'null'}`);

    const rawgCompanies = rawgGame.company_roles?.map((r) => ({
      name: r.company?.name ?? '',
      slug: r.company?.slug ?? '',
      role: r.role,
    })) || [];
    console.log(`companies: ${rawgCompanies.length}개`);
    rawgCompanies.forEach((c) => {
      console.log(`  - ${c.role}: ${c.name} (${c.slug})`);
    });

    const rawgGenres = rawgGame.details?.genres ?? [];
    console.log(`genres: ${rawgGenres.length}개 - [${rawgGenres.join(', ')}]`);

    console.log('\n🎮 Steam 게임 정보 (internal ID: ' + steamGame.id + ')');
    console.log('-'.repeat(100));
    console.log(`name: "${steamGame.name}"`);
    console.log(`og_name: "${steamGame.og_name ?? 'null'}"`);
    console.log(`slug: "${steamGame.slug}"`);
    console.log(`og_slug: "${steamGame.og_slug ?? 'null'}"`);
    console.log(`release_date: ${steamGame.release_date_date ?? 'null'}`);
    console.log(`rawg_id: ${steamGame.rawg_id ?? 'null'}`);
    console.log(`steam_id: ${steamGame.steam_id ?? 'null'}`);

    const steamCompanies = steamGame.company_roles?.map((r) => ({
      name: r.company?.name ?? '',
      slug: r.company?.slug ?? '',
      role: r.role,
    })) || [];
    console.log(`companies: ${steamCompanies.length}개`);
    steamCompanies.forEach((c) => {
      console.log(`  - ${c.role}: ${c.name} (${c.slug})`);
    });

    const steamGenres = steamGame.details?.genres ?? [];
    console.log(`genres: ${steamGenres.length}개 - [${steamGenres.join(', ')}]`);

    // 3. 이름 정규화
    console.log('\n📝 이름 정규화');
    console.log('-'.repeat(100));

    const rawgNameToNormalize = rawgGame.og_name || rawgGame.name;
    console.log(`RAWG 정규화 대상: "${rawgNameToNormalize}"`);
    const rawgNormalized = normalizeGameName(rawgNameToNormalize);
    console.log(`RAWG 정규화 결과:`);
    console.log(`  - original: "${rawgNormalized.original}"`);
    console.log(`  - lowercase: "${rawgNormalized.lowercase}"`);
    console.log(`  - tokens: [${rawgNormalized.tokens.join(', ')}]`);
    console.log(`  - compact: "${rawgNormalized.compact}"`);
    console.log(`  - looseSlug: "${rawgNormalized.looseSlug}"`);

    const steamNameToNormalize = steamGame.og_name || steamGame.name;
    console.log(`\nSteam 정규화 대상: "${steamNameToNormalize}"`);
    const steamNormalized = normalizeGameName(steamNameToNormalize);
    console.log(`Steam 정규화 결과:`);
    console.log(`  - original: "${steamNormalized.original}"`);
    console.log(`  - lowercase: "${steamNormalized.lowercase}"`);
    console.log(`  - tokens: [${steamNormalized.tokens.join(', ')}]`);
    console.log(`  - compact: "${steamNormalized.compact}"`);
    console.log(`  - looseSlug: "${steamNormalized.looseSlug}"`);

    // 4. Slug 비교
    console.log('\n🔗 Slug 비교');
    console.log('-'.repeat(100));
    console.log(`RAWG slug vs Steam slug: "${rawgGame.slug}" vs "${steamGame.slug}"`);
    console.log(`RAWG slug vs Steam og_slug: "${rawgGame.slug}" vs "${steamGame.og_slug ?? 'null'}"`);
    console.log(`RAWG og_slug vs Steam slug: "${rawgGame.og_slug ?? 'null'}" vs "${steamGame.slug}"`);
    console.log(`RAWG og_slug vs Steam og_slug: "${rawgGame.og_slug ?? 'null'}" vs "${steamGame.og_slug ?? 'null'}"`);
    console.log(`RAWG looseSlug vs Steam looseSlug: "${rawgNormalized.looseSlug}" vs "${steamNormalized.looseSlug}"`);

    const slugMatch =
      rawgGame.slug === steamGame.slug ||
      rawgGame.slug === steamGame.og_slug ||
      rawgGame.og_slug === steamGame.slug ||
      rawgGame.og_slug === steamGame.og_slug ||
      rawgNormalized.looseSlug === steamNormalized.looseSlug;
    console.log(`\nSlug 매칭 결과: ${slugMatch ? '✅ 일치' : '❌ 불일치'}`);

    // 5. 출시일 비교
    console.log('\n📅 출시일 비교');
    console.log('-'.repeat(100));
    const rawgDate = rawgGame.release_date_date;
    const steamDate = steamGame.release_date_date;
    console.log(`RAWG: ${rawgDate ?? 'null'}`);
    console.log(`Steam: ${steamDate ?? 'null'}`);

    let dateDiff: number | null = null;
    if (rawgDate && steamDate) {
      const diff = Math.abs(
        new Date(rawgDate).getTime() - new Date(steamDate).getTime(),
      );
      dateDiff = Math.floor(diff / (1000 * 60 * 60 * 24));
      console.log(`차이: ${dateDiff}일`);
    } else {
      console.log('차이: 계산 불가 (null 값 존재)');
    }

    // 6. 회사 비교
    console.log('\n🏢 회사 비교');
    console.log('-'.repeat(100));
    const rawgCompanySlugs = new Set(rawgCompanies.map((c) => c.slug).filter(Boolean));
    const steamCompanySlugs = new Set(steamCompanies.map((c) => c.slug).filter(Boolean));
    const companyOverlap = [...rawgCompanySlugs].filter((slug) =>
      steamCompanySlugs.has(slug),
    );
    console.log(`RAWG 회사: [${[...rawgCompanySlugs].join(', ')}]`);
    console.log(`Steam 회사: [${[...steamCompanySlugs].join(', ')}]`);
    console.log(`중복: [${companyOverlap.join(', ')}]`);
    console.log(`중복 회사: ${companyOverlap.length}개`);

    // 7. 장르 비교
    console.log('\n🎯 장르 비교');
    console.log('-'.repeat(100));
    const rawgGenreSet = new Set(rawgGenres.map((g) => g.toLowerCase()));
    const steamGenreSet = new Set(steamGenres.map((g) => g.toLowerCase()));
    const genreOverlap = [...rawgGenreSet].filter((g) => steamGenreSet.has(g));
    console.log(`RAWG 장르: [${[...rawgGenreSet].join(', ')}]`);
    console.log(`Steam 장르: [${[...steamGenreSet].join(', ')}]`);
    console.log(`중복: [${genreOverlap.join(', ')}]`);
    console.log(`중복 장르: ${genreOverlap.length}개`);

    // 8. 매칭 스코어 계산
    console.log('\n🎲 매칭 스코어 계산');
    console.log('-'.repeat(100));

    const score = calcMatchingScore({
      rawgName: rawgNormalized,
      steamName: steamNormalized,
      rawgSlug: rawgGame.slug,
      rawgOgSlug: rawgGame.og_slug,
      steamSlug: steamGame.slug,
      steamOgSlug: steamGame.og_slug,
      rawgReleaseDate: rawgDate ? new Date(rawgDate) : null,
      steamReleaseDate: steamDate ? new Date(steamDate) : null,
      rawgCompanies,
      steamCompanies,
      rawgGenres,
      steamGenres,
    });

    console.log(`\n최종 스코어: ${score.totalScore.toFixed(4)} (예상: ${testCase.expectedScore})`);
    console.log('세부 점수 (breakdown):');
    console.log(`  - nameScore: ${score.breakdown.nameScore.toFixed(4)} (가중치 45%)`);
    console.log(`  - releaseDateScore: ${score.breakdown.releaseDateScore.toFixed(4)} (가중치 35%)`);
    console.log(`  - companyScore: ${score.breakdown.companyScore.toFixed(4)} (가중치 20%)`);
    console.log(`  - genreScore: ${score.breakdown.genreScore.toFixed(4)} (가중치 0%)`);
    console.log(`  - bonusScore: ${score.breakdown.bonusScore.toFixed(4)}`);

    console.log('\nFlags:');
    console.log(`  - slugMatch: ${score.flags.slugMatch}`);
    console.log(`  - nameExactMatch: ${score.flags.nameExactMatch}`);
    console.log(`  - releaseDateDiffDays: ${score.flags.releaseDateDiffDays ?? 'null'}`);
    console.log(`  - companyOverlap: [${score.flags.companyOverlap.join(', ')}]`);
    console.log(`  - genreOverlap: [${score.flags.genreOverlap.join(', ')}]`);

    // 9. 토큰 분석
    console.log('\n🔤 토큰 분석 (FALSE POSITIVE 원인 파악)');
    console.log('-'.repeat(100));
    const rawgTokenSet = new Set(rawgNormalized.tokens);
    const steamTokenSet = new Set(steamNormalized.tokens);
    const commonTokens = [...rawgTokenSet].filter((t) => steamTokenSet.has(t));
    const rawgOnlyTokens = [...rawgTokenSet].filter((t) => !steamTokenSet.has(t));
    const steamOnlyTokens = [...steamTokenSet].filter((t) => !rawgTokenSet.has(t));

    console.log(`공통 토큰 (${commonTokens.length}개): [${commonTokens.join(', ')}]`);
    console.log(`RAWG 전용 토큰 (${rawgOnlyTokens.length}개): [${rawgOnlyTokens.join(', ')}]`);
    console.log(`Steam 전용 토큰 (${steamOnlyTokens.length}개): [${steamOnlyTokens.join(', ')}]`);

    const tokenOverlap = commonTokens.length / Math.max(rawgTokenSet.size, steamTokenSet.size);
    console.log(`\n토큰 중복률: ${(tokenOverlap * 100).toFixed(2)}%`);
    console.log(`→ 이것이 nameScore ${score.breakdown.nameScore.toFixed(4)}의 주요 원인`);

    // 10. FALSE POSITIVE 판정
    console.log('\n⚠️ FALSE POSITIVE 분석 결과');
    console.log('-'.repeat(100));

    if (score.totalScore >= 0.5) {
      console.log(`❌ AUTO_MATCH로 처리됨 (임계값 0.5 이상)`);
    } else if (score.totalScore >= 0.3) {
      console.log(`⚠️ PENDING으로 처리됨 (임계값 0.3-0.5)`);
    } else {
      console.log(`✅ REJECTED로 올바르게 처리됨`);
    }

    console.log('\n원인 분석:');
    if (commonTokens.length > 0) {
      console.log(`  1. 프랜차이즈 이름 공유: "${commonTokens.join(', ')}"`);
    }
    if (score.breakdown.releaseDateScore > 0) {
      console.log(`  2. 출시일 유사성: ${dateDiff}일 차이로 ${score.breakdown.releaseDateScore.toFixed(4)}점 획득`);
    }
    if (companyOverlap.length > 0) {
      console.log(`  3. 제작사 일치: ${companyOverlap.join(', ')}`);
    }
    if (genreOverlap.length > 0) {
      console.log(`  4. 장르 일치: ${genreOverlap.join(', ')}`);
    }
  }

  console.log('\n' + '='.repeat(100));
  console.log('✅ 모든 FALSE POSITIVE 케이스 분석 완료');
  console.log('='.repeat(100));

  await app.close();
}

void main().catch((error) => {
  console.error('스크립트 실행 중 오류:', error);
  process.exitCode = 1;
});
