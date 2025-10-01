// src/services/rawg/utils/rawg-query-builder.util.ts
import dayjs from 'dayjs';
import { RAWG_COLLECTION, RAWG_PLATFORM_IDS } from '../config/rawg.config';

export function generateMonthRange(
  pastMonths = RAWG_COLLECTION.pastMonths,
  futureMonths = RAWG_COLLECTION.futureMonths
): Array<[number, number]> {
  const now = dayjs();
  const start = now.subtract(pastMonths, 'month').startOf('month');
  const end = now.add(futureMonths, 'month').endOf('month');

  const months: Array<[number, number]> = [];
  let cur = start.clone();
  while (cur.isBefore(end) || cur.isSame(end, 'month')) {
    months.push([cur.year(), cur.month() + 1]); // month: 1-12
    cur = cur.add(1, 'month');
  }
  return months;
}

export function buildMonthlyParams(
  year: number,
  month: number,
  opts?: { ordering?: '-released' | '-added'; metacritic?: string }
) {
  const start = dayjs(`${year}-${String(month).padStart(2, '0')}-01`).startOf('month').format('YYYY-MM-DD');
  const end   = dayjs(`${year}-${String(month).padStart(2, '0')}-01`).endOf('month').format('YYYY-MM-DD');

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
