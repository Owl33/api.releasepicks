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
  const rawgGameId = 173591;
  const steamGameId = 161941;

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const dataSource = app.get(DataSource);
  const gameRepo = dataSource.getRepository(Game);

  console.log('\n' + '='.repeat(80));
  console.log('🔍 특정 게임 매칭 디버그');
  console.log('='.repeat(80));

  // 1. RAWG 게임 로드
  const rawgGame = await gameRepo.findOne({
    where: { id: rawgGameId },
    relations: ['details', 'company_roles', 'company_roles.company'],
  });

  if (!rawgGame) {
    console.log(`❌ RAWG 게임 ID ${rawgGameId}를 찾을 수 없습니다.`);
    await app.close();
    return;
  }

  // 2. Steam 게임 로드
  const steamGame = await gameRepo.findOne({
    where: { id: steamGameId },
    relations: ['details', 'company_roles', 'company_roles.company'],
  });

  if (!steamGame) {
    console.log(`❌ Steam 게임 ID ${steamGameId}를 찾을 수 없습니다.`);
    await app.close();
    return;
  }

  console.log('\n📋 RAWG 게임 정보 (ID: ' + rawgGameId + ')');
  console.log('-'.repeat(80));
  console.log(`name: "${rawgGame.name}"`);
  console.log(`og_name: "${rawgGame.og_name ?? 'null'}"`);
  console.log(`slug: "${rawgGame.slug}"`);
  console.log(`og_slug: "${rawgGame.og_slug ?? 'null'}"`);
  console.log(`release_date: ${rawgGame.release_date_date ?? 'null'}`);
  console.log(`popularity_score: ${rawgGame.popularity_score}`);
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

  console.log('\n🎮 Steam 게임 정보 (ID: ' + steamGameId + ')');
  console.log('-'.repeat(80));
  console.log(`name: "${steamGame.name}"`);
  console.log(`og_name: "${steamGame.og_name ?? 'null'}"`);
  console.log(`slug: "${steamGame.slug}"`);
  console.log(`og_slug: "${steamGame.og_slug ?? 'null'}"`);
  console.log(`release_date: ${steamGame.release_date_date ?? 'null'}`);
  console.log(`popularity_score: ${steamGame.popularity_score}`);
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
  console.log('-'.repeat(80));

  const rawgNameToNormalize = rawgGame.og_name || rawgGame.name;
  console.log(`RAWG 정규화 대상: "${rawgNameToNormalize}"`);
  const rawgNormalized = normalizeGameName(rawgNameToNormalize);
  console.log(`RAWG 정규화 결과:`);
  console.log(`  - original: "${rawgNormalized.original}"`);
  console.log(`  - lowercase: "${rawgNormalized.lowercase}"`);
  console.log(`  - tokens: [${rawgNormalized.tokens.join(', ')}]`);
  console.log(`  - compact: "${rawgNormalized.compact}"`);
  console.log(`  - looseSlug: "${rawgNormalized.looseSlug}"`);

  // ✅ Steam도 og_name 우선 사용 (영문 기준)
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
  console.log('-'.repeat(80));
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
  console.log('-'.repeat(80));
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
  console.log('-'.repeat(80));
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
  console.log('-'.repeat(80));
  const rawgGenreSet = new Set(rawgGenres.map((g) => g.toLowerCase()));
  const steamGenreSet = new Set(steamGenres.map((g) => g.toLowerCase()));
  const genreOverlap = [...rawgGenreSet].filter((g) => steamGenreSet.has(g));
  console.log(`RAWG 장르: [${[...rawgGenreSet].join(', ')}]`);
  console.log(`Steam 장르: [${[...steamGenreSet].join(', ')}]`);
  console.log(`중복: [${genreOverlap.join(', ')}]`);
  console.log(`중복 장르: ${genreOverlap.length}개`);

  // 8. 매칭 스코어 계산
  console.log('\n🎲 매칭 스코어 계산');
  console.log('-'.repeat(80));

  const score = calcMatchingScore({
    rawgName: rawgNormalized,
    steamName: steamNormalized,
    // ✅ 실제 DB slug 필드 전달
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

  console.log(`\n최종 스코어: ${score.totalScore.toFixed(4)}`);
  console.log('\n세부 점수 (breakdown):');
  console.log(`  - nameScore: ${score.breakdown.nameScore.toFixed(4)}`);
  console.log(`  - releaseDateScore: ${score.breakdown.releaseDateScore.toFixed(4)}`);
  console.log(`  - companyScore: ${score.breakdown.companyScore.toFixed(4)}`);
  console.log(`  - genreScore: ${score.breakdown.genreScore.toFixed(4)}`);
  console.log(`  - bonusScore: ${score.breakdown.bonusScore.toFixed(4)}`);

  console.log('\nFlags:');
  console.log(`  - slugMatch: ${score.flags.slugMatch}`);
  console.log(`  - nameExactMatch: ${score.flags.nameExactMatch}`);
  console.log(`  - releaseDateDiffDays: ${score.flags.releaseDateDiffDays ?? 'null'}`);
  console.log(`  - companyOverlap: [${score.flags.companyOverlap.join(', ')}]`);
  console.log(`  - genreOverlap: [${score.flags.genreOverlap.join(', ')}]`);

  // 9. 시그널 평가
  console.log('\n📡 강한 시그널 평가');
  console.log('-'.repeat(80));

  const strongSignals = [
    { name: 'slugMatch', value: score.flags.slugMatch },
    { name: 'nameExactMatch', value: score.flags.nameExactMatch },
    {
      name: 'releaseDateWithin1Year',
      value:
        score.flags.releaseDateDiffDays !== null &&
        score.flags.releaseDateDiffDays <= 365,
    },
    {
      name: 'companyOverlap',
      value: score.flags.companyOverlap.length > 0,
    },
  ];

  strongSignals.forEach((signal) => {
    console.log(`  ${signal.value ? '✅' : '❌'} ${signal.name}: ${signal.value}`);
  });

  const signalCount = strongSignals.filter((s) => s.value).length;
  console.log(`\n강한 시그널 개수: ${signalCount}/4`);

  // 10. 매칭 결정
  console.log('\n⚖️ 매칭 결정');
  console.log('-'.repeat(80));

  let outcome = 'rejected';
  let reason = 'SCORE_REJECTED';

  // 필터링 로직
  const passesFilter =
    (score.breakdown.nameScore >= 0.35 && signalCount >= 1) ||
    signalCount >= 2;

  console.log(`\n필터링 통과 여부:`);
  console.log(`  - nameScore >= 0.35: ${score.breakdown.nameScore >= 0.35}`);
  console.log(`  - signalCount >= 1: ${signalCount >= 1}`);
  console.log(`  - signalCount >= 2: ${signalCount >= 2}`);
  console.log(`  → 필터링 ${passesFilter ? '✅ 통과' : '❌ 실패'}`);

  if (passesFilter) {
    if (score.totalScore >= 0.3) {
      outcome = 'matched';
      reason = 'AUTO_MATCH';
    } else if (score.totalScore >= 0.01) {
      outcome = 'pending';
      reason = 'SCORE_THRESHOLD_PENDING';
    }
  } else {
    reason = 'INSUFFICIENT_SIGNALS';
  }

  console.log(`\n최종 결과: ${outcome.toUpperCase()}`);
  console.log(`사유: ${reason}`);

  console.log('\n' + '='.repeat(80));

  await app.close();
}

void main().catch((error) => {
  console.error('스크립트 실행 중 오류:', error);
  process.exitCode = 1;
});
