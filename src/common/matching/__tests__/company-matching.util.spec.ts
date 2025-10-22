import { computeCompanyOverlap } from '../company-matching.util';

describe('company-matching', () => {
  it('회사 교집합과 점수를 계산한다', () => {
    const rawg = [
      { name: 'Square Enix', role: 'publisher' },
      { name: 'Luminous Productions', role: 'developer' },
    ];
    const steam = [
      { name: 'SQUARE ENIX CO., LTD.', role: 'publisher' },
      { name: 'Unknown Studio', role: 'developer' },
    ];

    const { overlap, score } = computeCompanyOverlap(rawg as any, steam as any);
    expect(overlap).toContain('square enix');
    expect(score).toBeGreaterThan(0);
  });

  it('slug를 우선 비교한다', () => {
    const rawg = [
      { name: 'FromSoftware, Inc.', slug: 'fromsoftware', role: 'developer' },
    ];
    const steam = [
      { name: 'FromSoftware', slug: 'fromsoftware', role: 'developer' },
    ];

    const { overlap } = computeCompanyOverlap(rawg as any, steam as any);
    expect(overlap).toContain('fromsoftware');
  });
});
