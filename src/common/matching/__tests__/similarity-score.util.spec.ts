import { calcMatchingScore } from '../similarity-score.util';
import { normalizeGameName } from '../name-normalizer.util';

describe('similarity-score', () => {
  it('동일 게임에 대해 높은 점수를 반환한다', () => {
    const rawg = normalizeGameName('Final Fantasy VII Remake');
    const steam = normalizeGameName('Final Fantasy 7 Remake');

    const score = calcMatchingScore({
      rawgName: rawg,
      steamName: steam,
      rawgReleaseDate: new Date('2020-04-10T00:00:00Z'),
      steamReleaseDate: new Date('2020-04-11T00:00:00Z'),
      rawgCompanies: [{ name: 'Square Enix', role: 'publisher' }] as any,
      steamCompanies: [{ name: 'SQUARE ENIX CO., LTD.', role: 'publisher' }] as any,
      rawgGenres: ['Role-playing (RPG)'],
      steamGenres: ['role-playing (rpg)'],
      pcReleaseAligned: true,
    });

    expect(score.totalScore).toBeGreaterThan(0.85);
    expect(score.flags.nameExactMatch).toBe(true);
    expect(score.flags.companyOverlap.length).toBeGreaterThan(0);
  });

  it('서로 다른 게임은 낮은 점수를 반환한다', () => {
    const rawg = normalizeGameName('Gran Turismo 7');
    const steam = normalizeGameName('Forza Horizon 5');

    const score = calcMatchingScore({
      rawgName: rawg,
      steamName: steam,
    });

    expect(score.totalScore).toBeLessThan(0.4);
  });
});
