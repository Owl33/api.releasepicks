/**
 * 플랫폼 정규화 유틸리티
 *
 * RAWG 플랫폼 슬러그를 표준 패밀리명으로 변환
 * 예: "playstation5", "playstation4" → "playstation"
 *     "xbox-series-x", "xbox-one" → "xbox"
 *     "nintendo-switch" → "nintendo"
 */

/**
 * 플랫폼 패밀리 타입
 * DB에 저장되는 표준 플랫폼명
 */
export type PlatformFamily = 'playstation' | 'xbox' | 'nintendo' | 'pc';

/**
 * RAWG 플랫폼 슬러그를 표준 패밀리명으로 정규화
 *
 * @param slug RAWG 플랫폼 슬러그 (예: "playstation5", "xbox-series-x")
 * @returns 표준 패밀리명 또는 null (지원하지 않는 플랫폼)
 *
 * @example
 * ```typescript
 * normalizePlatformSlug('playstation5') // 'playstation'
 * normalizePlatformSlug('playstation4') // 'playstation'
 * normalizePlatformSlug('xbox-series-x') // 'xbox'
 * normalizePlatformSlug('nintendo-switch') // 'nintendo'
 * normalizePlatformSlug('pc') // 'pc'
 * normalizePlatformSlug('android') // null
 * ```
 */
export function normalizePlatformSlug(slug: string): PlatformFamily | null {
  if (!slug) {
    return null;
  }

  const normalized = slug.toLowerCase().trim();

  // PlayStation 패밀리 (PS5, PS4, PS3 등)
  if (normalized.includes('playstation')) {
    return 'playstation';
  }

  // Xbox 패밀리 (Series X|S, One, 360 등)
  if (normalized.includes('xbox')) {
    return 'xbox';
  }

  // Nintendo 패밀리 (Switch, Switch 2 등)
  if (normalized.includes('nintendo')) {
    return 'nintendo';
  }

  // PC
  if (normalized === 'pc') {
    return 'pc';
  }

  // 지원하지 않는 플랫폼 (Android, iOS, macOS, Linux 등)
  return null;
}

/**
 * RAWG 플랫폼 배열을 표준 패밀리명 배열로 변환 (중복 제거)
 *
 * @param platforms RAWG 플랫폼 객체 배열
 * @returns 중복 제거된 표준 패밀리명 배열
 *
 * @example
 * ```typescript
 * const platforms = [
 *   { platform: { slug: 'playstation5' } },
 *   { platform: { slug: 'playstation4' } },
 *   { platform: { slug: 'xbox-series-x' } }
 * ];
 * normalizePlatforms(platforms) // ['playstation', 'xbox']
 * ```
 */
export function normalizePlatforms(
  platforms: Array<{ platform: { slug: string } }>,
): PlatformFamily[] {
  if (!platforms || platforms.length === 0) {
    return [];
  }

  const familySet = new Set<PlatformFamily>();

  for (const platformData of platforms) {
    const family = normalizePlatformSlug(platformData.platform.slug);
    if (family) {
      familySet.add(family);
    }
  }

  return Array.from(familySet);
}

/**
 * 플랫폼 패밀리에 따른 스토어명 반환
 *
 * @param family 플랫폼 패밀리명
 * @returns 스토어명
 *
 * @example
 * ```typescript
 * getStoreFromPlatform('playstation') // 'psn'
 * getStoreFromPlatform('xbox') // 'xbox-store'
 * getStoreFromPlatform('nintendo') // 'eshop'
 * getStoreFromPlatform('pc') // 'steam'
 * ```
 */
export function getStoreFromPlatform(family: PlatformFamily): string {
  const storeMap: Record<PlatformFamily, string> = {
    playstation: 'psn',
    xbox: 'xbox-store',
    nintendo: 'eshop',
    pc: 'steam',
  };

  return storeMap[family];
}
