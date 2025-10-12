// src/services/platform/platform-normalizer.ts
export type PlatformFamily = 'pc' | 'playstation' | 'xbox' | 'nintendo';

export function normalizePlatformSlug(slug: string): PlatformFamily | null {
  const s = (slug || '').toLowerCase();
  if (s === 'pc' || s.includes('pc')) return 'pc';
  if (s.includes('playstation')) return 'playstation';
  if (s.includes('xbox')) return 'xbox';
  if (s.includes('nintendo')) return 'nintendo';
  return null;
}

export function extractPlatformFamilies(
  rawgPlatforms: Array<{ platform?: { slug?: string } }>,
): PlatformFamily[] {
  const set = new Set<PlatformFamily>();
  for (const p of rawgPlatforms || []) {
    const fam = p?.platform?.slug
      ? normalizePlatformSlug(p.platform.slug)
      : null;
    if (fam) set.add(fam);
  }
  return [...set];
}
