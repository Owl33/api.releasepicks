// src/services/rawg/utils/rawg-query-builder.util.ts
import dayjs from 'dayjs';
import { RAWG_COLLECTION, RAWG_PLATFORM_IDS } from '../config/rawg.config';

export function generateMonthRange(
  pastMonths: number,
  futureMonths: number,
): [number, number][] {
  // 현재 기준으로 과거~미래 월 목록 생성
  const out: [number, number][] = [];
  const now = new Date();
  const baseY = now.getUTCFullYear();
  const baseM = now.getUTCMonth(); // 0-11

  const startIdx = baseY * 12 + baseM - pastMonths + 1; // inclusive
  const endIdx = baseY * 12 + baseM + futureMonths; // inclusive

  for (let idx = startIdx; idx <= endIdx; idx++) {
    const y = Math.floor(idx / 12);
    const m = (idx % 12) + 1; // 1-12
    out.push([y, m]);
  }

  // 가까운 달부터 처리 (현재 month index와의 절대거리 기준)
  const nowIdx = baseY * 12 + baseM;
  out.sort((a, b) => {
    const ai = a[0] * 12 + (a[1] - 1);
    const bi = b[0] * 12 + (b[1] - 1);
    return Math.abs(ai - nowIdx) - Math.abs(bi - nowIdx);
  });
  return out;
}

export function buildMonthlyParams(
  year: number,
  month: number,
  opts?: { ordering?: '-released' | '-added'; metacritic?: string },
) {
  const start = dayjs(`${year}-${String(month).padStart(2, '0')}-01`)
    .startOf('month')
    .format('YYYY-MM-DD');
  const end = dayjs(`${year}-${String(month).padStart(2, '0')}-01`)
    .endOf('month')
    .format('YYYY-MM-DD');

  const platforms = [
    ...RAWG_PLATFORM_IDS.playstation,
    ...RAWG_PLATFORM_IDS.xbox,
    ...RAWG_PLATFORM_IDS.nintendo,
  ].join(',');

  const params: Record<string, any> = {
    platforms,
    dates: `${start},${end}`,
    page_size: RAWG_COLLECTION.pageSize,
    ordering: opts?.ordering || RAWG_COLLECTION.ordering,
  };
  if (opts?.metacritic) params.metacritic = opts.metacritic;
  return params;
}
