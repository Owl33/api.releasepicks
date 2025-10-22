import { normalizeSlugCandidate } from '../slug-normalizer.util';

describe('slug-normalizer', () => {
  it('SlugPolicy와 동일한 규칙으로 정규화한다', () => {
    expect(normalizeSlugCandidate('  Final Fantasy XVI  ')).toBe(
      'final-fantasy-xvi',
    );
  });

  it('길이가 긴 경우 120자로 자른다', () => {
    const long = 'a'.repeat(150);
    expect(normalizeSlugCandidate(long)).toHaveLength(120);
  });
});
