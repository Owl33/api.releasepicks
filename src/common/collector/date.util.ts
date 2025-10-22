/**
 * 다양한 날짜 입력(Date | string | null | undefined)을 Unix 타임스탬프로 변환한다.
 * 값이 없거나 파싱이 실패하면 Infinity(정렬용) 혹은 null을 반환한다.
 */
export function toTimestamp(
  input: Date | string | null | undefined,
  fallback: number = Infinity,
): number {
  if (!input) return fallback;
  if (input instanceof Date) {
    const value = input.getTime();
    return Number.isFinite(value) ? value : fallback;
  }
  const parsed = new Date(input as any).getTime();
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Date 또는 문자열 입력을 Date 객체로 정규화한다. 실패 시 null 반환.
 */
export function normalizeDate(
  input: Date | string | null | undefined,
): Date | null {
  if (!input) return null;
  if (input instanceof Date)
    return Number.isFinite(input.getTime()) ? input : null;
  const parsed = new Date(input as any);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}
