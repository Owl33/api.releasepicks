import {
  buildLooseSlug,
  buildTokenSet,
  normalizeGameName,
} from '../name-normalizer.util';

describe('name-normalizer', () => {
  it('로마 숫자를 치환하고 토큰을 생성한다', () => {
    const result = normalizeGameName('Resident Evil VII: Biohazard');
    expect(result.tokens).toContain('7');
    expect(result.tokens).toContain('resident');
  });

  it('불용어를 제거한다', () => {
    const tokens = buildTokenSet('The Legend of Heroes Trails of Cold Steel');
    expect(tokens).not.toContain('the');
    expect(tokens).not.toContain('of');
  });

  it('슬러그를 안정적으로 만든다', () => {
    const slug = buildLooseSlug('Marvel’s Spider-Man Remastered');
    expect(slug).toBe('marvels-spider-man-remastered');
  });

  it('로마 숫자를 완전히 치환한다', () => {
    const result = normalizeGameName('Dragon Quest XIV');
    expect(result.compact).toContain('14');
    expect(result.tokens).toContain('14');
  });
});
