import { EntityManager } from 'typeorm';
import { SlugPolicyService } from './slug-policy.service';

const createManagerMock = (existSequence: Array<boolean | (() => boolean)>): Partial<EntityManager> => {
  const sequence = [...existSequence];
  const builderFactory = () => {
    return {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getExists: jest.fn().mockImplementation(() => {
        if (!sequence.length) {
          return Promise.resolve(false);
        }
        const next = sequence.shift();
        const value = typeof next === 'function' ? next() : next;
        return Promise.resolve(value);
      }),
    };
  };

  return {
    createQueryBuilder: jest.fn().mockImplementation(() => builderFactory()),
  } as unknown as Partial<EntityManager>;
};

describe('SlugPolicyService', () => {
  let service: SlugPolicyService;

  beforeEach(() => {
    service = new SlugPolicyService();
  });

  it('생성된 slug/ogSlug가 기본 규칙을 따른다', async () => {
    const manager = createManagerMock([false, false]);

    const result = await service.resolve(manager as EntityManager, {
      selfId: null,
      name: 'Hello World',
    });

    expect(result.slug).toBe('hello-world');
    expect(result.ogSlug).toBe('hello-world');
  });

  it('중복 slug가 있으면 suffix를 증가시킨다', async () => {
    const manager = createManagerMock([true, false, false]);

    const result = await service.resolve(manager as EntityManager, {
      selfId: null,
      name: 'Banana',
      preferredSlug: 'banana',
      preferredOgSlug: 'banana',
    });

    expect(result.slug).toBe('banana-2');
    expect(result.ogSlug).toBe('banana');
  });

  it('후보가 없을 때 fallback ID로 생성한다', async () => {
    const manager = createManagerMock([false, false]);

    const result = await service.resolve(manager as EntityManager, {
      selfId: null,
      name: '',
      preferredSlug: null,
      preferredOgSlug: null,
      fallbackSteamId: 123,
    });

    expect(result.slug).toBe('game-123');
    expect(result.ogSlug).toBe('game-123');
  });

  it('suffix 추가 시 최대 길이를 유지한다', async () => {
    const longName = 'a'.repeat(130);
    const manager = createManagerMock([true, false, false]);

    const result = await service.resolve(manager as EntityManager, {
      selfId: null,
      name: longName,
    });

    expect(result.slug.length).toBeLessThanOrEqual(120);
    expect(result.slug.endsWith('-2')).toBe(true);
    expect(result.ogSlug.length).toBeLessThanOrEqual(120);
  });
});
