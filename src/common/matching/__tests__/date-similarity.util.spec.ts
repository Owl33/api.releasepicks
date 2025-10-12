import { compareReleaseDates, parseRawRelease } from '../date-similarity.util';

describe('date-similarity', () => {
  it('ISO 문자열을 파싱한다', () => {
    const date = parseRawRelease('2025-10-11');
    expect(date).not.toBeNull();
    expect(date?.getUTCFullYear()).toBe(2025);
  });

  it('출시일 차이를 계산한다', () => {
    const a = new Date('2025-10-10T00:00:00Z');
    const b = new Date('2025-10-13T00:00:00Z');
    const { diffDays, score } = compareReleaseDates(a, b);
    expect(diffDays).toBe(3);
    expect(score).toBeCloseTo(0.85, 2);
  });
});
