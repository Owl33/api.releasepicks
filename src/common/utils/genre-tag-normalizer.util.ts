/**
 * 장르/태그 정규화 및 한영 변환 유틸리티
 *
 * 규칙:
 * 1. 영문은 소문자로 변환
 * 2. 공백, 하이픈, 언더스코어 제거 (slug 형태)
 * 3. 한글 입력 시 한글+영문(정규화) 모두 검색
 */

/**
 * 문자열을 정규화된 slug 형태로 변환
 * - 소문자 변환
 * - 공백, 하이픈, 언더스코어, 특수문자 제거
 *
 * @example
 * normalizeToSlug("Action-Adventure") // "actionadventure"
 * normalizeToSlug("Third Person") // "thirdperson"
 * normalizeToSlug("Free to Play") // "freetoplay"
 */
export function normalizeToSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\-_'":]/g, '') // 공백, 하이픈, 언더스코어, 따옴표, 콜론 제거
    .trim();
}

/**
 * 장르 영한 매핑 (정규화된 키 사용)
 * DB에 저장된 실제 값과 매칭하기 위한 맵
 */
export const GENRE_MAP_SLUG_TO_KO: Record<string, string> = {
  // 영문 원본 (DB 저장값)
  action: 'Action',
  adventure: 'Adventure',
  indie: 'Indie',
  platformer: 'Platformer',
  rpg: 'RPG',
  shooter: 'Shooter',
  sports: 'Sports',
  strategy: 'Strategy',

  // 한글 원본 (DB 저장값)
  게임개발: '게임 개발',
  고어: '고어',
  교육: '교육',
  대규모멀티플레이어: '대규모 멀티플레이어',
  동영상제작: '동영상 제작',
  디자인과일러스트레이션: '디자인과 일러스트레이션',
  레이싱: '레이싱',
  무료플레이: '무료 플레이',
  사진편집: '사진 편집',
  스포츠: '스포츠',
  시뮬레이션: '시뮬레이션',
  앞서해보기: '앞서 해보기',
  애니메이션과모델링: '애니메이션과 모델링',
  액션: '액션',
  어드벤처: '어드벤처',
  오디오제작: '오디오 제작',
  웹퍼블리싱: '웹 퍼블리싱',
  유틸리티: '유틸리티',
  인디: '인디',
  전략: '전략',
  캐주얼: '캐주얼',
  폭력적: '폭력적',
};

/**
 * 한글 장르 → 영문 장르 변환 맵
 */
export const GENRE_KO_TO_EN: Record<string, string[]> = {
  액션: ['Action', '액션'],
  어드벤처: ['Adventure', '어드벤처'],
  인디: ['Indie', '인디'],
  플랫포머: ['Platformer'],
  rpg: ['RPG'],
  슈터: ['Shooter'],
  스포츠: ['Sports', '스포츠'],
  전략: ['Strategy', '전략'],
  게임개발: ['게임 개발'],
  고어: ['고어'],
  교육: ['교육'],
  대규모멀티플레이어: ['대규모 멀티플레이어'],
  동영상제작: ['동영상 제작'],
  디자인과일러스트레이션: ['디자인과 일러스트레이션'],
  레이싱: ['레이싱'],
  무료플레이: ['무료 플레이'],
  사진편집: ['사진 편집'],
  시뮬레이션: ['시뮬레이션'],
  앞서해보기: ['앞서 해보기'],
  애니메이션과모델링: ['애니메이션과 모델링'],
  오디오제작: ['오디오 제작'],
  웹퍼블리싱: ['웹 퍼블리싱'],
  유틸리티: ['유틸리티'],
  캐주얼: ['캐주얼'],
  폭력적: ['폭력적'],
};

/**
 * 태그 정규화 slug → 원본 값 매핑
 * DB에 저장된 실제 태그 값과 매칭
 */
export const TAG_MAP_SLUG_TO_ORIGINAL: Record<string, string> = {
  // 기본 태그 (영문)
  '2d': '2D',
  '3d': '3D',
  actionadventure: 'Action-Adventure',
  atmospheric: 'Atmospheric',
  charactercustomization: 'Character Customization',
  choicesmatter: 'Choices Matter',
  cinematic: 'Cinematic',
  coop: 'Co-op',
  colorful: 'Colorful',
  controller: 'Controller',
  dark: 'Dark',
  earlyaccess: 'Early Access',
  exploration: 'Exploration',
  fantasy: 'Fantasy',
  femaleprotagonist: 'Female Protagonist',
  firstperson: 'First-Person',
  freetoplay: 'Free to Play',
  fullcontrollersupport: 'Full controller support',
  gore: 'Gore',
  hackandslash: 'Hack and Slash',
  horror: 'Horror',
  lanpvp: 'LAN PvP',
  mature: 'Mature',
  metroidvania: 'Metroidvania',
  mmo: 'MMO',
  multiplayer: 'Multiplayer',
  mystery: 'Mystery',
  nudity: 'Nudity',
  openworld: 'Open World',
  partialcontrollersupport: 'Partial Controller Support',
  physics: 'Physics',
  postapocalyptic: 'Post-apocalyptic',
  pvp: 'PvP',
  realistic: 'Realistic',
  remoteplaytogether: 'Remote Play Together',
  remoteplaytv: 'Remote Play TV',
  retro: 'Retro',
  rpg: 'RPG',
  scifi: 'Sci-fi',
  sidescroller: 'Side Scroller',
  singleplayer: 'Singleplayer',
  stealth: 'Stealth',
  steamachievements: 'Steam Achievements',
  steamcloud: 'Steam Cloud',
  steamtradingcards: 'Steam Trading Cards',
  story: 'Story',
  storyrich: 'Story Rich',
  thirdperson: 'Third Person',
  thirdpersonshooter: 'Third-Person Shooter',
  violent: 'Violent',

  // 한글 태그 (공백 제거)
  hdr사용가능: 'HDR 사용 가능',
  lan협동: 'LAN 협동',
  remoteplay태블릿: 'Remote Play 태블릿',
  remoteplay휴대전화: 'Remote Play 휴대전화',
  sourcesdk포함: 'Source SDK 포함',
  steam도전과제: 'Steam 도전 과제',
  steam순위표: 'Steam 순위표',
  steam창작마당: 'Steam 창작마당',
  steam타임라인: 'Steam 타임라인',
  steam턴알림: 'Steam 턴 알림',
  steam트레이딩카드: 'Steam 트레이딩 카드',
  steamvr수집품: 'SteamVR 수집품',
  valveanticheat사용: 'Valve Anti-Cheat 사용',
  vr전용: 'VR 전용',
  vr지원: 'VR 지원',
  가족공유: '가족 공유',
  게임메뉴음성안내: '게임 메뉴 음성 안내',
  공유및분할화면: '공유 및 분할 화면',
  난이도조정: '난이도 조정',
  레벨에디터포함: '레벨 에디터 포함',
  마우스전용옵션: '마우스 전용 옵션',
  멀티플레이어: '멀티플레이어',
  색상대체: '색상 대체',
  서라운드사운드: '서라운드 사운드',
  수시저장: '수시 저장',
  스크린공유및분할pvp: '스크린 공유 및 분할 PvP',
  스크린공유및분할협동: '스크린 공유 및 분할 협동',
  스테레오사운드: '스테레오 사운드',
  싱글플레이어: '싱글 플레이어',
  앱내구매: '앱 내 구매',
  온라인pvp: '온라인 PvP',
  온라인협동: '온라인 협동',
  음량개별조정: '음량 개별 조정',
  음성채팅텍스트변환: '음성 채팅 텍스트 변환',
  자막옵션: '자막 옵션',
  추적되는컨트롤러지원: '추적되는 컨트롤러 지원',
  카메라움직임조정: '카메라 움직임 조정',
  캡션이용가능: '캡션 이용 가능',
  컨트롤러완벽지원: '컨트롤러 완벽 지원',
  컨트롤러일부지원: '컨트롤러 일부 지원',
  코멘터리제공: '코멘터리 제공',
  퀵타임이벤트없이플레이가능: '퀵타임 이벤트 없이 플레이 가능',
  크로스플랫폼멀티플레이어: '크로스 플랫폼 멀티플레이어',
  키보드전용옵션: '키보드 전용 옵션',
  터치전용옵션: '터치 전용 옵션',
  텍스트채팅음성변환: '텍스트 채팅 음성 변환',
  텍스트크기조절: '텍스트 크기 조절',
  통계: '통계',
  협동: '협동',
};

/**
 * 한글 태그 → 영문 태그 변환 맵
 */
export const TAG_KO_TO_EN: Record<string, string[]> = {
  // 플레이 모드
  싱글플레이어: ['Singleplayer', '싱글 플레이어'],
  멀티플레이어: ['Multiplayer', '멀티플레이어'],
  협동: ['Co-op', '협동'],
  '1인칭': ['First-Person'],
  '3인칭': ['Third Person'],
  '3인칭슈팅': ['Third-Person Shooter'],
  lanpvp: ['LAN PvP'],
  lan협동: ['LAN 협동'],
  온라인pvp: ['온라인 PvP'],
  온라인협동: ['온라인 협동'],
  pvp: ['PvP'],
  mmo: ['MMO'],
  vr지원: ['VR 지원'],
  vr전용: ['VR 전용'],

  // 컨트롤러
  컨트롤러완벽지원: ['Full controller support', '컨트롤러 완벽 지원'],
  컨트롤러일부지원: ['Partial Controller Support', '컨트롤러 일부 지원'],
  컨트롤러: ['Controller', '컨트롤러'],
  추적되는컨트롤러지원: ['추적되는 컨트롤러 지원'],
  키보드전용옵션: ['키보드 전용 옵션'],
  마우스전용옵션: ['마우스 전용 옵션'],
  터치전용옵션: ['터치 전용 옵션'],

  // 세계/장르
  오픈월드: ['Open World'],
  메트로배니아: ['Metroidvania'],
  핵앤슬래시: ['Hack and Slash'],
  횡스크롤: ['Side Scroller'],
  액션어드벤처: ['Action-Adventure'],

  // 분위기
  스토리중심: ['Story Rich'],
  스토리: ['Story'],
  분위기있는: ['Atmospheric'],
  다크: ['Dark'],
  미스터리: ['Mystery'],
  판타지: ['Fantasy'],
  sf: ['Sci-fi'],
  리얼리스틱: ['Realistic'],
  레트로: ['Retro'],

  // 유통
  앞서해보기: ['Early Access', '앞서 해보기'],
  무료플레이: ['Free to Play', '무료 플레이'],
  앱내구매: ['앱 내 구매'],

  // Steam
  steam도전과제: ['Steam Achievements', 'Steam 도전 과제'],
  steam트레이딩카드: ['Steam Trading Cards', 'Steam 트레이딩 카드'],
  steamcloud: ['Steam Cloud'],
  steam창작마당: ['Steam 창작마당'],
  steam순위표: ['Steam 순위표'],

  // Remote Play
  remoteplaytogether: ['Remote Play Together'],
  remoteplaytv: ['Remote Play TV'],
  remoteplay태블릿: ['Remote Play 태블릿'],
  remoteplay휴대전화: ['Remote Play 휴대전화'],

  // 접근성
  캡션이용가능: ['캡션 이용 가능'],
  자막옵션: ['자막 옵션'],
  텍스트크기조절: ['텍스트 크기 조절'],
  색상대체: ['색상 대체'],
  음량개별조정: ['음량 개별 조정'],
  카메라움직임조정: ['카메라 움직임 조정'],
  퀵타임이벤트없이플레이가능: ['퀵타임 이벤트 없이 플레이 가능'],

  // 오디오
  스테레오사운드: ['스테레오 사운드'],
  서라운드사운드: ['서라운드 사운드'],
  음성채팅텍스트변환: ['음성 채팅 텍스트 변환'],
  텍스트채팅음성변환: ['텍스트 채팅 음성 변환'],

  // 기타
  valveanticheat사용: ['Valve Anti-Cheat 사용'],
  가족공유: ['가족 공유'],
  sourcesdk포함: ['Source SDK 포함'],

  // 테마
  고어: ['Gore', '고어'],
  폭력적: ['Violent', '폭력적'],
  호러: ['Horror'],
  누드: ['Nudity'],

  // 기타
  탐험: ['Exploration'],
  물리: ['Physics'],
  스텔스: ['Stealth'],
  포스트아포칼립스: ['Post-apocalyptic'],
  여성주인공: ['Female Protagonist'],
  캐릭터커스터마이징: ['Character Customization'],
  컬러풀: ['Colorful'],
  시네마틱: ['Cinematic'],
};

/**
 * 한글 입력값을 한글+영문(정규화) 검색 조건 배열로 변환
 *
 * @example
 * expandGenreSearchTerms(["액션", "어드벤처"])
 * // ["액션", "Action", "어드벤처", "Adventure"]
 */
export function expandGenreSearchTerms(koreanTerms: string[]): string[] {
  const expanded = new Set<string>();

  for (const term of koreanTerms) {
    const normalized = normalizeToSlug(term);

    // 1. 원본 그대로 추가
    expanded.add(term);

    // 2. 한영 변환 맵에서 찾기
    const englishEquivalents = GENRE_KO_TO_EN[normalized];
    if (englishEquivalents) {
      englishEquivalents.forEach((en) => expanded.add(en));
    }

    // 3. slug → 원본 맵에서 찾기
    const originalValue = GENRE_MAP_SLUG_TO_KO[normalized];
    if (originalValue) {
      expanded.add(originalValue);
    }
  }

  return Array.from(expanded);
}

/**
 * 한글 태그 입력값을 한글+영문(정규화) 검색 조건 배열로 변환
 *
 * @example
 * expandTagSearchTerms(["싱글 플레이어", "오픈 월드"])
 * // ["싱글 플레이어", "Singleplayer", "오픈 월드", "Open World"]
 */
export function expandTagSearchTerms(koreanTerms: string[]): string[] {
  const expanded = new Set<string>();

  for (const term of koreanTerms) {
    const normalized = normalizeToSlug(term);

    // 1. 원본 그대로 추가
    expanded.add(term);

    // 2. 한영 변환 맵에서 찾기
    const englishEquivalents = TAG_KO_TO_EN[normalized];
    if (englishEquivalents) {
      englishEquivalents.forEach((en) => expanded.add(en));
    }

    // 3. slug → 원본 맵에서 찾기
    const originalValue = TAG_MAP_SLUG_TO_ORIGINAL[normalized];
    if (originalValue) {
      expanded.add(originalValue);
    }
  }

  return Array.from(expanded);
}
