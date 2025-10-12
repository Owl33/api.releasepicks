import { CompanyData } from '@pipeline/contracts';

const COMPANY_STOPWORDS = new Set([
  'inc',
  'ltd',
  'co',
  'corp',
  'corporation',
  'limited',
  'studios',
  'studio',
  'games',
  'game',
  'entertainment',
  'interactive',
]);

/**
 * 회사 배열 간 교집합과 점수를 계산한다.
 */
export function computeCompanyOverlap(
  rawg: CompanyData[] = [],
  steam: CompanyData[] = [],
) {
  const rawgNormalized = normalizeCompanyList(rawg);
  const steamNormalized = normalizeCompanyList(steam);

  const overlapKeys = new Set<string>();

  rawgNormalized.slugKeys.forEach((key) => {
    if (steamNormalized.slugKeys.has(key)) {
      overlapKeys.add(key);
    }
  });

  rawgNormalized.nameKeys.forEach((key) => {
    if (overlapKeys.has(key)) return;
    if (steamNormalized.nameKeys.has(key)) {
      overlapKeys.add(key);
    }
  });

  const overlap = [...overlapKeys].map((key) => key.split(':')[1]);

  const denominator = Math.max(rawgNormalized.keys.size, steamNormalized.keys.size, 1);
  const score =
    overlap.length === 0 ? 0 : Number((overlap.length / denominator).toFixed(3));

  return {
    overlap,
    score,
  };
}

function normalizeCompanyList(companies: CompanyData[]): {
  keys: Set<string>;
  slugKeys: Set<string>;
  nameKeys: Set<string>;
} {
  const keys = new Set<string>();
  const slugKeys = new Set<string>();
  const nameKeys = new Set<string>();

  companies.forEach((company) => {
    const slug = company.slug?.trim().toLowerCase();
    if (slug) {
      const key = `slug:${slug}`;
      keys.add(key);
      slugKeys.add(key);
    }

    const normalizedName = normalizeCompanyName(company.name ?? '');
    if (normalizedName) {
      const key = `name:${normalizedName}`;
      keys.add(key);
      nameKeys.add(key);
    }
  });

  return { keys, slugKeys, nameKeys };
}

function normalizeCompanyName(name: string): string {
  const lower = name.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  const tokens = lower
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .filter((token) => !COMPANY_STOPWORDS.has(token));

  return tokens.join(' ');
}
