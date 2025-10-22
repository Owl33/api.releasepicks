const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 출시일 문자열을 Date로 파싱한다.
 */
export function parseRawRelease(raw?: string | null): Date | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const isoMatch = trimmed.match(/^\d{4}-\d{2}-\d{2}$/);
  if (isoMatch) {
    const date = new Date(`${trimmed}T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const monthMatch = trimmed.match(
    /^(?<day>\d{1,2})\s+(?<month>[A-Za-z]+)\s*,\s*(?<year>\d{4})$/,
  );
  if (monthMatch?.groups) {
    const { day, month, year } = monthMatch.groups;
    const date = new Date(`${month} ${day}, ${year} UTC`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const yearOnly = trimmed.match(/^\d{4}$/);
  if (yearOnly) {
    const date = new Date(`${yearOnly[0]}-01-01T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}

/**
 * 출시일 차이를 기반으로 유사도를 계산한다.
 * PC 포팅을 고려하여 범위 확대 (최대 5년)
 */
export function compareReleaseDates(
  a: Date | null | undefined,
  b: Date | null | undefined,
) {
  if (!a || !b) {
    return { diffDays: null as number | null, score: 0 };
  }

  const diffMs = Math.abs(a.getTime() - b.getTime());
  const diffDays = Math.round(diffMs / ONE_DAY_MS);

  let score = 0;
  if (diffDays === 0) score = 1.0;
  else if (diffDays <= 1) score = 0.95;
  else if (diffDays <= 3) score = 0.9;
  else if (diffDays <= 7) score = 0.8;
  else if (diffDays <= 14) score = 0.7;
  else if (diffDays <= 30) score = 0.6;
  else if (diffDays <= 90)
    score = 0.5; // 3개월
  else if (diffDays <= 180)
    score = 0.4; // 6개월
  else if (diffDays <= 365)
    score = 0.3; // 1년
  else if (diffDays <= 730)
    score = 0.2; // 2년
  else if (diffDays <= 1825) score = 0.1; // 5년 (PC 포팅)

  return { diffDays, score: Number(score.toFixed(3)) };
}
