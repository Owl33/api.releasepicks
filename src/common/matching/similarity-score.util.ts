import { compareReleaseDates } from './date-similarity.util';
import { computeCompanyOverlap } from './company-matching.util';
import {
  MatchingInputs,
  MatchingScore,
  MatchingWeights,
} from './matching.types';

const DEFAULT_WEIGHTS: MatchingWeights = {
  name: 0.45,
  releaseDate: 0.35,
  company: 0.2,
  genre: 0.0,
  bonus: 0.05,
};

/**
 * RAWG ↔ Steam 매칭 스코어 계산 진입점
 */
export function calcMatchingScore(inputs: MatchingInputs): MatchingScore {
  const weights: MatchingWeights = {
    ...DEFAULT_WEIGHTS,
    ...inputs.weights,
  };

  const nameResult = calculateNameScore(
    inputs.rawgName,
    inputs.steamName,
    {
      rawgSlug: inputs.rawgSlug,
      rawgOgSlug: inputs.rawgOgSlug,
      steamSlug: inputs.steamSlug,
      steamOgSlug: inputs.steamOgSlug,
    },
  );
  const releaseResult = compareReleaseDates(
    inputs.rawgReleaseDate ?? null,
    inputs.steamReleaseDate ?? null,
  );
  const companyResult = computeCompanyOverlap(
    inputs.rawgCompanies,
    inputs.steamCompanies,
  );
  const genreResult = computeGenreScore(inputs.rawgGenres, inputs.steamGenres);

  const nameScore = nameResult.score * weights.name;
  const releaseDateScore = releaseResult.score * weights.releaseDate;
  const companyScore = companyResult.score * weights.company;
  const genreScore = genreResult.score * weights.genre;

  const bonusScore = inputs.pcReleaseAligned ? weights.bonus : 0;

  const total = nameScore + releaseDateScore + companyScore + genreScore + bonusScore;

  return {
    totalScore: Number(Math.min(total, 1).toFixed(4)),
    breakdown: {
      nameScore: Number(nameScore.toFixed(4)),
      releaseDateScore: Number(releaseDateScore.toFixed(4)),
      companyScore: Number(companyScore.toFixed(4)),
      genreScore: Number(genreScore.toFixed(4)),
      bonusScore: Number(bonusScore.toFixed(4)),
    },
    flags: {
      nameExactMatch: nameResult.exactMatch,
      slugMatch: nameResult.slugMatch,
      releaseDateDiffDays: releaseResult.diffDays,
      companyOverlap: companyResult.overlap,
      genreOverlap: genreResult.overlap,
    },
  };
}

/**
 * 이름에 숫자가 포함되어 있는지 확인 (속편 감지용)
 */
function hasNumberInName(name: string): boolean {
  // "2", "II", "III", "IV" 등의 숫자 패턴 감지
  return /\b(2|3|4|5|ii|iii|iv|v)\b/i.test(name);
}

function calculateNameScore(
  rawg: MatchingInputs['rawgName'],
  steam: MatchingInputs['steamName'],
  slugs?: {
    rawgSlug?: string;
    rawgOgSlug?: string;
    steamSlug?: string;
    steamOgSlug?: string;
  },
) {
  const exactMatch = rawg.lowercase === steam.lowercase;

  // ✅ 실제 DB slug 필드 비교 (우선순위 높음)
  let dbSlugMatch = false;
  if (slugs) {
    const rawgSlugs = [slugs.rawgSlug, slugs.rawgOgSlug].filter(Boolean);
    const steamSlugs = [slugs.steamSlug, slugs.steamOgSlug].filter(Boolean);

    for (const rSlug of rawgSlugs) {
      for (const sSlug of steamSlugs) {
        if (rSlug && sSlug) {
          // 정확 일치
          if (rSlug === sSlug) {
            dbSlugMatch = true;
            break;
          }

          // ✅ 개선된 숫자 suffix 처리: 속편 감지
          // "stellar-blade" vs "stellar-blade-2" → MATCH (중복 방지용)
          // "subnautica" vs "subnautica-2" → NO MATCH (속편!)
          const rMatch = rSlug.match(/^(.+?)(-\d+)?$/);
          const sMatch = sSlug.match(/^(.+?)(-\d+)?$/);

          if (rMatch && sMatch) {
            const rBase = rMatch[1]; // "stellar-blade", "subnautica"
            const sBase = sMatch[1];
            const rSuffix = rMatch[2]; // undefined, "-2"
            const sSuffix = sMatch[2]; // "-2", undefined

            if (rBase === sBase && rBase.length > 3) {
              // 케이스 1: 둘 다 suffix 없음 → MATCH (정확히 같은 게임)
              if (!rSuffix && !sSuffix) {
                dbSlugMatch = true;
                break;
              }
              // 케이스 2: 같은 suffix → MATCH (stellar-blade-2 vs stellar-blade-2)
              else if (rSuffix && sSuffix && rSuffix === sSuffix) {
                dbSlugMatch = true;
                break;
              }
              // 케이스 3: 둘 다 suffix 있지만 다름 → MATCH (중복 방지용)
              // "stellar-blade-2" vs "stellar-blade-3" → 같은 게임의 중복 항목
              else if (rSuffix && sSuffix) {
                dbSlugMatch = true;
                break;
              }
              // 케이스 4: 한쪽만 suffix 있음 → 이름으로 판단
              else if ((rSuffix && !sSuffix) || (!rSuffix && sSuffix)) {
                // 이름에 숫자가 있으면 → 속편 (NO MATCH)
                // "Subnautica 2" → "subnautica-2" (진짜 2편)
                const hasSteamNumber = hasNumberInName(steam.original);
                const hasRawgNumber = hasNumberInName(rawg.original);

                if (hasSteamNumber || hasRawgNumber) {
                  // 속편으로 판단
                  dbSlugMatch = false;
                } else {
                  // 이름에 숫자 없음 → 중복 방지용 suffix (MATCH)
                  // "Stellar Blade" → "stellar-blade-2" (TM 중복)
                  dbSlugMatch = true;
                  break;
                }
              }
            }
          }
        }
      }
      if (dbSlugMatch) break;
    }
  }

  // looseSlug 비교 (fallback)
  const looseSlugMatch =
    rawg.looseSlug.length > 0 && rawg.looseSlug === steam.looseSlug;

  const slugMatch = dbSlugMatch || looseSlugMatch;

  const tokenScore = calculateTokenScore(rawg.tokens, steam.tokens);
  const jaroScore = jaroWinkler(rawg.lowercase, steam.lowercase);
  const compactScore = jaroWinkler(rawg.compact, steam.compact);

  let combined = tokenScore * 0.5 + jaroScore * 0.3 + compactScore * 0.2;

  if (exactMatch) {
    combined = 1;
  } else if (slugMatch) {
    combined = Math.max(combined, 0.95); // 0.92 → 0.95 (slug 매칭 강화)
  }

  return {
    score: Number(Math.min(combined, 1).toFixed(3)),
    exactMatch,
    slugMatch,
  };
}

function calculateTokenScore(rawgTokens: string[], steamTokens: string[]) {
  if (!rawgTokens.length || !steamTokens.length) return 0;
  const rawgSet = new Set(rawgTokens);
  const steamSet = new Set(steamTokens);

  let overlap = 0;
  rawgSet.forEach((token) => {
    if (steamSet.has(token)) overlap += 1;
  });

  const denominator = Math.max(rawgSet.size, steamSet.size, 1);
  return Number((overlap / denominator).toFixed(3));
}

function computeGenreScore(rawg: string[] = [], steam: string[] = []) {
  if (!rawg.length || !steam.length) {
    return { score: 0, overlap: [] as string[] };
  }

  const rawgSet = new Set(
    rawg.map((g) => g.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase()),
  );
  const steamSet = new Set(
    steam.map((g) => g.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase()),
  );

  const overlap: string[] = [];
  rawgSet.forEach((value) => {
    if (steamSet.has(value)) overlap.push(value);
  });

  const denominator = Math.max(rawgSet.size, steamSet.size, 1);
  const score =
    overlap.length === 0 ? 0 : Number((overlap.length / denominator).toFixed(3));

  return { score, overlap };
}

/**
 * Jaro-Winkler 구현 (간단 버전)
 */
function jaroWinkler(a: string, b: string): number {
  if (!a.length || !b.length) return 0;
  if (a === b) return 1;

  const matchDistance = Math.floor(Math.max(a.length, b.length) / 2) - 1;
  const aMatches = new Array(a.length).fill(false);
  const bMatches = new Array(b.length).fill(false);

  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, b.length);

    for (let j = start; j < end; j++) {
      if (bMatches[j]) continue;
      if (a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches++;
      break;
    }
  }

  if (!matches) return 0;

  let k = 0;
  let transpositions = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }

  const m = matches;
  const jaro =
    (m / a.length + m / b.length + (m - transpositions / 2) / m) / 3;

  let prefix = 0;
  for (let i = 0; i < Math.min(4, a.length, b.length); i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }

  return Number((jaro + prefix * 0.1 * (1 - jaro)).toFixed(3));
}
