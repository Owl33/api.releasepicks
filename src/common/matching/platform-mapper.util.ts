import { Platform } from '../../entities/enums';

const RAWG_PC = new Set(['pc', 'macos', 'linux']);
const RAWG_PLAYSTATION = new Set([
  'playstation5',
  'playstation4',
  'playstation3',
  'playstation2',
  'playstation',
  'ps-vita',
  'psp',
]);
const RAWG_XBOX = new Set([
  'xbox-series-x',
  'xbox-one',
  'xbox360',
  'xbox-old',
  'xbox',
]);
const RAWG_NINTENDO = new Set([
  'nintendo-switch',
  'nintendo-3ds',
  'nintendo-ds',
  'nintendo-dsi',
  'wii-u',
  'wii',
  'gamecube',
  'nintendo-64',
  'game-boy-advance',
  'game-boy',
  'nes',
  'snes',
  'nintendo',
]);

/**
 * RAWG 플랫폼 slug를 통합 플랫폼 enum으로 매핑한다.
 */
export function mapRawgPlatformSlugToPlatform(slug: string): Platform | null {
  const lowered = slug?.toLowerCase();
  if (!lowered) return null;

  if (RAWG_PC.has(lowered)) return Platform.PC;
  if (RAWG_PLAYSTATION.has(lowered)) return Platform.PLAYSTATION;
  if (RAWG_XBOX.has(lowered)) return Platform.XBOX;
  if (RAWG_NINTENDO.has(lowered)) return Platform.NINTENDO;

  return null;
}

/**
 * RAWG 플랫폼 목록을 PC/콘솔 분류 요약으로 변환한다.
 */
export function summarizeRawgPlatforms(slugs: string[]) {
  const consoles = new Set<Platform>();
  let pc = false;

  for (const slug of slugs) {
    const mapped = mapRawgPlatformSlugToPlatform(slug);
    if (!mapped) continue;
    if (mapped === Platform.PC) {
      pc = true;
    } else {
      consoles.add(mapped);
    }
  }

  return {
    pc,
    consoles: [...consoles].sort(),
  };
}
