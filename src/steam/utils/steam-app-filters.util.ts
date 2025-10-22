/**
 * Steam 앱 이름 제외 규칙 관리 유틸
 * - AppList 단계와 세부 수집 단계에서 동일하게 재사용한다.
 */

const STEAM_APP_EXCLUDE_PATTERNS: RegExp[] = [
  /\bsoundtrack\b/,
  /\boriginal soundtrack\b/,
  /\boriginal sound track\b/,
  /\bwallpaper\b/,
  /\bscreensaver\b/,
  /\bsdk\b/,
  /\bdevelopment kit\b/,
  /\bserver\b/,
  /\bbenchmark\b/,
  /\btest\b/,
  /\bsample\b/,
  /\btrailer\b/,
  /\bvideo\b/,
  /\bplaytest\b/,
];

/**
 * Steam 앱 이름이 제외 대상인지 여부를 반환한다.
 */
export function shouldExcludeSteamAppName(name: unknown): boolean {
  const normalized = typeof name === 'string' ? name.trim().toLowerCase() : '';
  if (!normalized) return false;
  return STEAM_APP_EXCLUDE_PATTERNS.some((pattern) => pattern.test(normalized));
}
