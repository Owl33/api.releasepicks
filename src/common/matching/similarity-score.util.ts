import { compareReleaseDates } from './date-similarity.util';
import { computeCompanyOverlap } from './company-matching.util';
import {
  MatchingInputs,
  MatchingScore,
  MatchingWeights,
} from './matching.types';
import { convertRomanTokenToArabicNumber } from '../utils/roman.util';
import { extractSequelNumbers } from '../slug/slug-variant.util';

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
  const numbers = extractSequelNumbers(name);
  return numbers.some((value) => value > 0 && value <= 50);
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
          const rParsed = parseSlugComponents(rSlug);
          const sParsed = parseSlugComponents(sSlug);

          if (rParsed.base && sParsed.base && rParsed.base === sParsed.base) {
            const rSuffix = rParsed.suffixRaw;
            const sSuffix = sParsed.suffixRaw;
            const rValue = rParsed.suffixValue;
            const sValue = sParsed.suffixValue;
            const baseLength = rParsed.base.length;

            if (baseLength <= 3) {
              continue;
            }

            // 케이스 1: suffix 없음 → 정확히 같은 게임
            if (!rSuffix && !sSuffix) {
              dbSlugMatch = true;
              break;
            }

            // 케이스 2: 양쪽 suffix 존재
            if (rSuffix && sSuffix) {
              // 둘 다 숫자/로마 숫자로 파싱 가능하면 값 비교
              if (rValue !== null && sValue !== null) {
                if (rValue === sValue) {
                  dbSlugMatch = true;
                  break;
                }

                const hasNumberToken =
                  hasNumberInName(steam.original) ||
                  hasNumberInName(rawg.original);

                if (!hasNumberToken) {
                  // slug 중복으로 판단
                  dbSlugMatch = true;
                  break;
                }
              } else if (
                rSuffix.toLowerCase() === sSuffix.toLowerCase()
              ) {
                dbSlugMatch = true;
                break;
              } else {
                // 파싱 실패 → 안전하게 이름 기반으로 판단
                const hasNumberToken =
                  hasNumberInName(steam.original) ||
                  hasNumberInName(rawg.original);
                if (!hasNumberToken) {
                  dbSlugMatch = true;
                  break;
                }
              }
            }

            // 케이스 3: 한쪽만 suffix 존재
            if ((rSuffix && !sSuffix) || (!rSuffix && sSuffix)) {
              const hasNumberToken =
                hasNumberInName(steam.original) ||
                hasNumberInName(rawg.original);

              if (hasNumberToken) {
                dbSlugMatch = false;
              } else {
                const numericValue = rValue ?? sValue;
                if (numericValue !== null && numericValue <= 50) {
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

function parseSlugComponents(slug?: string | null) {
  if (!slug) {
    return {
      base: null as string | null,
      suffixRaw: null as string | null,
      suffixValue: null as number | null,
    };
  }
  const match = slug.match(/^(.+?)(?:-([0-9]{1,4}|[ivxlcdm]+))?$/i);
  if (!match) {
    return {
      base: slug,
      suffixRaw: null,
      suffixValue: null,
    };
  }

  const base = match[1];
  const suffixRaw = match[2] ?? null;
  let suffixValue: number | null = null;

  if (suffixRaw) {
    if (/^\d+$/.test(suffixRaw)) {
      suffixValue = Number(suffixRaw);
    } else {
      suffixValue = convertRomanTokenToArabicNumber(suffixRaw);
    }
  }

  return {
    base,
    suffixRaw,
    suffixValue,
  };
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
