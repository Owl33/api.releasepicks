/**
 * rawg-query-builder 유틸리티 단위 테스트
 * Phase 2: 월 단위 쿼리 파라미터 생성 검증
 */

import dayjs from 'dayjs';
import {
  generateMonthRange,
  buildMonthlyParams,
} from './rawg-query-builder.util';
import { RAWG_COLLECTION, RAWG_PLATFORM_IDS } from '../config/rawg.config';

describe('rawg-query-builder', () => {
  describe('generateMonthRange', () => {
    it('기본값: 과거 12개월 + 미래 6개월 = 총 18개월 생성', () => {
      const months = generateMonthRange();

      expect(months.length).toBeGreaterThanOrEqual(18);
      expect(months.length).toBeLessThanOrEqual(19); // 경계 케이스 허용
    });

    it('사용자 정의: 과거 3개월 + 미래 2개월 생성', () => {
      const months = generateMonthRange(3, 2);

      expect(months.length).toBeGreaterThanOrEqual(5);
      expect(months.length).toBeLessThanOrEqual(6);
    });

    it('각 월은 [year, month] 튜플 형태', () => {
      const months = generateMonthRange(1, 1);

      for (const [year, month] of months) {
        expect(typeof year).toBe('number');
        expect(typeof month).toBe('number');
        expect(month).toBeGreaterThanOrEqual(1);
        expect(month).toBeLessThanOrEqual(12);
        expect(year).toBeGreaterThan(2020);
      }
    });

    it('현재 월이 포함되어야 함', () => {
      const now = dayjs();
      const currentYear = now.year();
      const currentMonth = now.month() + 1; // dayjs month: 0-11

      const months = generateMonthRange(1, 1);
      const hasCurrentMonth = months.some(
        ([y, m]) => y === currentYear && m === currentMonth,
      );

      expect(hasCurrentMonth).toBe(true);
    });

    it('월은 시간 순서대로 정렬되어야 함', () => {
      const months = generateMonthRange(3, 2);

      for (let i = 1; i < months.length; i++) {
        const [prevYear, prevMonth] = months[i - 1];
        const [currYear, currMonth] = months[i];

        const prevDate = dayjs(`${prevYear}-${prevMonth}-01`);
        const currDate = dayjs(`${currYear}-${currMonth}-01`);

        expect(currDate.isAfter(prevDate) || currDate.isSame(prevDate)).toBe(
          true,
        );
      }
    });
  });

  describe('buildMonthlyParams', () => {
    it('2024년 10월 파라미터 생성', () => {
      const params = buildMonthlyParams(2024, 10);

      expect(params.dates).toBe('2024-10-01,2024-10-31');
      expect(params.page_size).toBe(RAWG_COLLECTION.pageSize);
      expect(params.ordering).toBe(RAWG_COLLECTION.ordering);
      expect(params.platforms).toBe('187,18,186,1,7'); // PS5,PS4,Xbox Series,Xbox One,Switch
    });

    it('윤년 2월 (29일) 처리', () => {
      const params = buildMonthlyParams(2024, 2);

      expect(params.dates).toBe('2024-02-01,2024-02-29');
    });

    it('평년 2월 (28일) 처리', () => {
      const params = buildMonthlyParams(2023, 2);

      expect(params.dates).toBe('2023-02-01,2023-02-28');
    });

    it('31일이 있는 달 (1월, 3월, 5월, 7월, 8월, 10월, 12월)', () => {
      const monthsWith31Days = [1, 3, 5, 7, 8, 10, 12];

      for (const month of monthsWith31Days) {
        const params = buildMonthlyParams(2024, month);
        const [start, end] = params.dates.split(',');

        expect(end).toMatch(/-31$/);
      }
    });

    it('30일이 있는 달 (4월, 6월, 9월, 11월)', () => {
      const monthsWith30Days = [4, 6, 9, 11];

      for (const month of monthsWith30Days) {
        const params = buildMonthlyParams(2024, month);
        const [start, end] = params.dates.split(',');

        expect(end).toMatch(/-30$/);
      }
    });

    it('ordering 옵션 커스텀', () => {
      const params = buildMonthlyParams(2024, 10, { ordering: '-added' });

      expect(params.ordering).toBe('-added');
    });

    it('metacritic 옵션 추가', () => {
      const params = buildMonthlyParams(2024, 10, { metacritic: '75,100' });

      expect(params.metacritic).toBe('75,100');
    });

    it('metacritic 옵션 없으면 undefined', () => {
      const params = buildMonthlyParams(2024, 10);

      expect(params.metacritic).toBeUndefined();
    });

    it('통합 플랫폼 ID (PlayStation + Xbox + Nintendo)', () => {
      const params = buildMonthlyParams(2024, 10);

      const platformIds = params.platforms.split(',').map(Number);

      // PlayStation (PS5: 187, PS4: 18)
      expect(platformIds).toContain(187);
      expect(platformIds).toContain(18);

      // Xbox (Series X|S: 186, One: 1)
      expect(platformIds).toContain(186);
      expect(platformIds).toContain(1);

      // Nintendo (Switch: 7)
      expect(platformIds).toContain(7);
    });

    it('날짜 포맷이 ISO 8601 준수 (YYYY-MM-DD)', () => {
      const params = buildMonthlyParams(2024, 10);
      const [start, end] = params.dates.split(',');

      expect(start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('한 자리 월을 두 자리로 패딩 (01, 02, ...)', () => {
      const params = buildMonthlyParams(2024, 1);

      expect(params.dates).toMatch(/^2024-01-/);
    });
  });
});
