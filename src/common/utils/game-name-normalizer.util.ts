/**
 * 게임 이름 정규화 유틸리티
 *
 * 목적:
 * - 플랫폼별 게임 이름 표기 차이를 통일하여 중복 게임 방지
 * - 특수문자, 그리스 문자, 로마 숫자 등을 표준 형식으로 변환
 *
 * 사용 예:
 * - Steam: "METAL GEAR SOLID Δ: SNAKE EATER"
 * - RAWG: "Metal Gear Solid Delta: Snake Eater"
 * → 둘 다 "metal-gear-solid-delta-snake-eater"로 정규화
 */

/**
 * 그리스 문자 → 영문 변환 매핑
 */
const GREEK_TO_LATIN: Record<string, string> = {
  // 대문자
  Α: 'alpha',
  Β: 'beta',
  Γ: 'gamma',
  Δ: 'delta', // ⭐ Metal Gear Solid Δ
  Ε: 'epsilon',
  Ζ: 'zeta',
  Η: 'eta',
  Θ: 'theta',
  Ι: 'iota',
  Κ: 'kappa',
  Λ: 'lambda',
  Μ: 'mu',
  Ν: 'nu',
  Ξ: 'xi',
  Ο: 'omicron',
  Π: 'pi',
  Ρ: 'rho',
  Σ: 'sigma',
  Τ: 'tau',
  Υ: 'upsilon',
  Φ: 'phi',
  Χ: 'chi',
  Ψ: 'psi',
  Ω: 'omega',

  // 소문자
  α: 'alpha',
  β: 'beta',
  γ: 'gamma',
  δ: 'delta',
  ε: 'epsilon',
  ζ: 'zeta',
  η: 'eta',
  θ: 'theta',
  ι: 'iota',
  κ: 'kappa',
  λ: 'lambda',
  μ: 'mu',
  ν: 'nu',
  ξ: 'xi',
  ο: 'omicron',
  π: 'pi',
  ρ: 'rho',
  σ: 'sigma',
  ς: 'sigma', // 단어 끝 시그마
  τ: 'tau',
  υ: 'upsilon',
  φ: 'phi',
  χ: 'chi',
  ψ: 'psi',
  ω: 'omega',
};

/**
 * 로마 숫자 → 아라비아 숫자 변환 매핑 (유니코드 문자 포함)
 */
const ROMAN_TO_ARABIC: Record<string, string> = {
  // 유니코드 로마 숫자 (한 글자로 된 특수 문자)
  Ⅰ: '1',
  Ⅱ: '2',
  Ⅲ: '3',
  Ⅳ: '4',
  Ⅴ: '5',
  Ⅵ: '6',
  Ⅶ: '7',
  Ⅷ: '8',
  Ⅸ: '9',
  Ⅹ: '10',
  Ⅺ: '11',
  Ⅻ: '12',

  // 소문자
  ⅰ: '1',
  ⅱ: '2',
  ⅲ: '3',
  ⅳ: '4',
  ⅴ: '5',
  ⅵ: '6',
  ⅶ: '7',
  ⅷ: '8',
  ⅸ: '9',
  ⅹ: '10',
  ⅺ: '11',
  ⅻ: '12',
};

/**
 * 기타 특수 기호 변환/제거 매핑
 */
const SPECIAL_CHARS: Record<string, string> = {
  // 상표/저작권 기호 (제거)
  '™': '',
  '®': '',
  '©': '',

  // 기타 특수 문자
  '№': 'no',
  '§': 'section',
  '†': 'dagger',
  '‡': 'double-dagger',

  // 불릿 포인트/구분자 (제거)
  '•': '',
  '·': '',
  '…': '',
  '–': '-', // en dash
  '—': '-', // em dash
  '\u2018': '', // 왼쪽 작은따옴표 '
  '\u2019': '', // 오른쪽 작은따옴표 '
  '\u201C': '', // 왼쪽 큰따옴표 "
  '\u201D': '', // 오른쪽 큰따옴표 "
  '：': ':', // 전각 콜론
  '；': ';', // 전각 세미콜론
};

/**
 * 키릴 문자를 라틴 문자로 변환 (러시아어 음역)
 */
function transliterateCyrillic(text: string): string {
  const CYRILLIC_MAP: Record<string, string> = {
    // 러시아어 대문자
    А: 'a', Б: 'b', В: 'v', Г: 'g', Д: 'd', Е: 'e', Ё: 'yo',
    Ж: 'zh', З: 'z', И: 'i', Й: 'y', К: 'k', Л: 'l', М: 'm',
    Н: 'n', О: 'o', П: 'p', Р: 'r', С: 's', Т: 't', У: 'u',
    Ф: 'f', Х: 'h', Ц: 'ts', Ч: 'ch', Ш: 'sh', Щ: 'shch',
    Ъ: '', Ы: 'y', Ь: '', Э: 'e', Ю: 'yu', Я: 'ya',
    // 러시아어 소문자
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo',
    ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
    н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u',
    ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
    ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  };

  return text.replace(/[А-Яа-яЁё]/g, (char) => CYRILLIC_MAP[char] || char);
}

/**
 * 게임 이름을 정규화하여 slug 생성
 *
 * 처리 순서:
 * 1. 소문자 변환
 * 2. 키릴 문자 → 라틴 문자 변환 (러시아어 등)
 * 3. 그리스 문자 → 영문 변환
 * 4. 로마 숫자 → 아라비아 숫자 변환
 * 5. 특수 문자 제거/변환
 * 6. 허용된 문자만 유지 (영문, 숫자, 한글, 일본어, 중국어, 공백, 하이픈)
 * 7. 공백을 하이픈으로 변환
 * 8. 연속 하이픈 제거
 * 9. 앞뒤 하이픈 제거
 * 10. 길이 제한 (100자)
 * 11. 빈 문자열 방지 (fallback ID 추가)
 *
 * @param name 원본 게임 이름
 * @param fallbackId 빈 slug 방지용 ID (steam_id 또는 rawg_id, 선택적)
 * @returns URL 친화적인 slug
 *
 * @example
 * ```typescript
 * normalizeGameName("METAL GEAR SOLID Δ: SNAKE EATER")
 * // → "metal-gear-solid-delta-snake-eater"
 *
 * normalizeGameName("Древние Ящеры", 2621150)
 * // → "drevnie-yashchery-2621150"
 *
 * normalizeGameName("𣸩", 2639280)
 * // → "unknown-game-2639280"
 * ```
 */
export function normalizeGameName(name: string, fallbackId?: number | null): string {
  if (!name || typeof name !== 'string') {
    return fallbackId ? `unknown-game-${fallbackId}` : '';
  }

  let normalized = name;

  // 1. 소문자 변환
  normalized = normalized.toLowerCase();

  // 2. 키릴 문자 → 라틴 문자 변환 (러시아어 등)
  normalized = transliterateCyrillic(normalized);

  // 3. 그리스 문자 → 영문 변환
  for (const [greek, latin] of Object.entries(GREEK_TO_LATIN)) {
    const lowerGreek = greek.toLowerCase();
    normalized = normalized.replace(new RegExp(lowerGreek, 'g'), latin);
  }

  // 4. 로마 숫자 → 아라비아 숫자 변환
  for (const [roman, arabic] of Object.entries(ROMAN_TO_ARABIC)) {
    const lowerRoman = roman.toLowerCase();
    normalized = normalized.replace(new RegExp(lowerRoman, 'g'), arabic);
  }

  // 5. 특수 문자 제거/변환
  for (const [special, replacement] of Object.entries(SPECIAL_CHARS)) {
    normalized = normalized.replace(new RegExp(special, 'g'), replacement);
  }

  // 6. 허용된 문자만 유지 (영문, 숫자, 한글, 일본어, 중국어 간체/번체, 공백, 하이픈)
  // 중국어 범위: \u4e00-\u9fff (CJK 통합 한자)
  normalized = normalized.replace(
    /[^a-z0-9가-힣ぁ-んァ-ヶー\u4e00-\u9fff\s-]/g,
    '',
  );

  // 7. 공백을 하이픈으로 변환
  normalized = normalized.replace(/\s+/g, '-');

  // 8. 연속 하이픈 제거
  normalized = normalized.replace(/-+/g, '-');

  // 9. 앞뒤 하이픈 제거
  normalized = normalized.replace(/^-|-$/g, '');

  // 10. 길이 제한 (fallback ID 공간 확보: 최대 100자에서 ID 길이만큼 줄임)
  const maxLength = fallbackId ? 85 : 100; // ID는 최대 15자 예상 (예: "-2621150")
  normalized = normalized.substring(0, maxLength);

  // 11. 빈 문자열 방지: fallback ID 추가
  if (!normalized || normalized.trim() === '') {
    return fallbackId ? `unknown-game-${fallbackId}` : 'unknown-game';
  }

  // 12. fallback ID 추가 (빈 slug 중복 방지)
  if (fallbackId) {
    return `${normalized}-${fallbackId}`;
  }

  return normalized;
}
