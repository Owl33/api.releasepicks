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

  const nameResult = calculateNameScore(inputs.rawgName, inputs.steamName);
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

function calculateNameScore(
  rawg: MatchingInputs['rawgName'],
  steam: MatchingInputs['steamName'],
) {
  const exactMatch = rawg.lowercase === steam.lowercase;
  const slugMatch =
    rawg.looseSlug.length > 0 && rawg.looseSlug === steam.looseSlug;

  const tokenScore = calculateTokenScore(rawg.tokens, steam.tokens);
  const jaroScore = jaroWinkler(rawg.lowercase, steam.lowercase);
  const compactScore = jaroWinkler(rawg.compact, steam.compact);

  let combined = tokenScore * 0.5 + jaroScore * 0.3 + compactScore * 0.2;

  if (exactMatch) {
    combined = 1;
  } else if (slugMatch) {
    combined = Math.max(combined, 0.92);
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
