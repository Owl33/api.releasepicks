# 백엔드 관리 스크립트

## update-steam-game-details.ts (최신 - 권장) ⭐

Steam과 RAWG ID가 모두 있는 멀티플랫폼 게임의 game_details를 Steam 데이터로 덮어쓰는 스크립트입니다.

### 사용 목적

- `steam_id`와 `rawg_id`가 **모두 존재**하는 게임의 `game_details` 테이블을 Steam 데이터로 **전체 덮어쓰기**
- 멀티플랫폼 게임의 경우 Steam 데이터가 더 정확하고 상세함
- RAWG 데이터가 먼저 저장된 경우 Steam 데이터로 보정

### 실행 방법

#### 방법 1: npm scripts 사용 (권장)

```bash
# 1. Dry Run 테스트 (10개 게임, 실제 업데이트 안 함)
npm run update:steam-details:test

# 2. Dry Run (전체 게임, 실제 업데이트 안 함)
npm run update:steam-details:dry

# 3. 실제 업데이트
npm run update:steam-details
```

#### 방법 2: 직접 실행 (옵션 조절 필요 시)

```bash
# 1. Dry Run (테스트 실행, 실제 업데이트 안 함)
npx ts-node scripts/update-steam-game-details.ts --dry-run

# 2. 소수의 게임만 테스트 (예: 10개)
npx ts-node scripts/update-steam-game-details.ts --dry-run --limit 10

# 3. 실제 업데이트 (소수 테스트 후 실행 권장)
npx ts-node scripts/update-steam-game-details.ts --limit 50

# 4. 전체 실행
npx ts-node scripts/update-steam-game-details.ts
```

### 업데이트 대상

**조건**: `games` 테이블에서 `steam_id IS NOT NULL AND rawg_id IS NOT NULL`

**업데이트 필드**:
- `header_image` - 헤더 이미지
- `screenshots` - 스크린샷 5장
- `video_url` - 트레일러 영상
- `description` - 상세 설명
- `website` - 공식 웹사이트
- `genres` - 장르
- `tags` - 카테고리
- `support_languages` - 지원 언어
- `metacritic_score` - 메타크리틱 점수

**유지되는 필드** (Steam에 없는 데이터):
- `opencritic_score` - 오픈크리틱 점수 (RAWG 전용)
- `rawg_added` - RAWG added 수 (RAWG 전용)

### 주의사항

1. **Steam API Rate Limit**
   - Steam API는 **310초당 200개 호출** 제한이 있습니다
   - 자동으로 Rate Limit을 관리하고 대기하므로 중단하지 마세요
   - 200개 호출 후 자동으로 남은 시간만큼 대기합니다

2. **처음 실행 시 권장 절차**
   ```bash
   # 1단계: Dry Run으로 확인 (10개 게임 테스트)
   npm run update:steam-details:test

   # 2단계: 소수만 실제 업데이트하여 테스트 (50개)
   npx ts-node scripts/update-steam-game-details.ts --limit 50

   # 3단계: DB에서 업데이트 결과 확인
   # Supabase Dashboard에서 확인

   # 4단계: 문제 없으면 전체 실행
   npm run update:steam-details
   ```

### 실행 결과 예시

```
🚀 Steam 게임 상세정보 일괄 업데이트 시작...
⚠️ 주의: game_details 테이블을 Steam 데이터로 무조건 덮어씁니다!
📝 업데이트 대상: steam_id와 rawg_id가 모두 존재하는 게임
✅ 총 245개의 멀티플랫폼 게임 발견 (Steam + RAWG)

⚠️ 주의: 이 작업은 Steam API Rate Limit으로 인해 시간이 오래 걸립니다.
   - 총 245개 게임 처리 예정
   - Rate Limit: 310초당 200개 호출
   - 예상 윈도우: 2개
   - 예상 소요 시간: 약 11분

📊 진행률: 100/245 (41%) | 성공: 98 | 스킵: 2 | 실패: 0 | Rate Limit: 100/200 (155초 경과)
⏸️ Rate Limit 도달 (200개 호출) - 155초 대기 중...
🔄 Rate Limit 윈도우 리셋 - 다시 시작합니다.

============================================================
✅ Steam 게임 상세정보 일괄 업데이트 완료!
============================================================
📊 총 처리: 245개
   ✅ 업데이트 성공: 240개
   ⏭️ 스킵 (데이터 없음): 3개
   ❌ 실패: 2개

📋 업데이트 필드:
   - header_image (헤더 이미지)
   - screenshots (스크린샷 5장)
   - video_url (트레일러 영상)
   - description (상세 설명)
   - website (공식 웹사이트)
   - genres (장르)
   - tags (카테고리)
   - support_languages (지원 언어)
   - metacritic_score (메타크리틱 점수)
```

---

## update-pc-game-details.ts (구버전 - Deprecated)

PC 게임의 description(게임 설명)을 Steam API로부터 가져와 업데이트하는 스크립트입니다.

### 사용 목적

- platform_type이 'pc'인 **모든 게임**의 description을 일괄 업데이트
- Steam의 `short_description` 데이터로 **무조건 덮어쓰기**
- 기존 잘못된 description 데이터 교체
- 약 2,500개 PC 게임의 description 일괄 재수집

### 실행 방법

#### 방법 1: npm scripts 사용 (권장)

```bash
# 1. Dry Run 테스트 (10개 게임, 실제 업데이트 안 함)
npm run update:pc-details:test

# 2. Dry Run (전체 게임, 실제 업데이트 안 함)
npm run update:pc-details:dry

# 3. 실제 업데이트
npm run update:pc-details
```

#### 방법 2: 직접 실행 (옵션 조절 필요 시)

```bash
# 1. Dry Run (테스트 실행, 실제 업데이트 안 함)
npx ts-node scripts/update-pc-game-details.ts --dry-run

# 2. 소수의 게임만 테스트 (예: 10개)
npx ts-node scripts/update-pc-game-details.ts --dry-run --limit 10

# 3. 실제 업데이트 (소수 테스트 후 실행 권장)
# 처음에는 소수만 업데이트
npx ts-node scripts/update-pc-game-details.ts --limit 50

# 문제 없으면 전체 실행
npx ts-node scripts/update-pc-game-details.ts
```

### 주의사항

1. **Steam API Rate Limit**
   - Steam API는 **310초당 200개 호출** 제한이 있습니다
   - 2,500개 게임 처리 시 **약 65분** 소요 (13개 윈도우)
   - 자동으로 Rate Limit을 관리하고 대기하므로 중단하지 마세요
   - 200개 호출 후 자동으로 남은 시간만큼 대기합니다

2. **처음 실행 시 권장 절차**
   ```bash
   # 1단계: Dry Run으로 확인 (10개 게임 테스트)
   npm run update:pc-details:test

   # 2단계: 소수만 실제 업데이트하여 테스트 (50개)
   npx ts-node scripts/update-pc-game-details.ts --limit 50

   # 3단계: DB에서 업데이트 결과 확인
   # SQL: SELECT * FROM game_details WHERE platform_type = 'pc' ORDER BY id DESC LIMIT 50;

   # 4단계: 문제 없으면 전체 실행
   npm run update:pc-details
   ```

3. **업데이트 로직**
   - ⚠️ **기존 description 무조건 덮어쓰기** (잘못된 데이터 교체)
   - ✅ **Steam에 description이 없으면만**: 스킵 (빈 값 방지)
   - 사용 필드: `short_description` (Steam AppDetails API)

4. **다른 필드는 업데이트하지 않음**
   - screenshots, video_url, website, genres 등은 **건드리지 않음**
   - **오직 description만** 업데이트

### 실행 결과 예시

```
🚀 PC 게임 Description 업데이트 시작...
⚠️ 주의: 기존 description을 무조건 덮어씁니다!
📝 업데이트 대상: platform_type = "pc"인 모든 게임
📋 업데이트 대상 게임 조회 중...
✅ 총 2534개의 PC 게임 발견

⚠️ 주의: 이 작업은 Steam API Rate Limit으로 인해 시간이 오래 걸립니다.
   - 총 2534개 게임 처리 예정
   - Rate Limit: 310초당 200개 호출
   - 예상 윈도우: 13개
   - 예상 소요 시간: 약 67분

계속하려면 5초 기다립니다...

📊 진행률: 10/2534 (0%) | 성공: 8 | 스킵: 2 | 실패: 0 | Rate Limit: 10/200 (15초 경과)
📊 진행률: 200/2534 (8%) | 성공: 195 | 스킵: 5 | 실패: 0 | Rate Limit: 200/200 (305초 경과)
⏸️ Rate Limit 도달 (200개 호출) - 5초 대기 중...
🔄 Rate Limit 윈도우 리셋 - 다시 시작합니다.
📊 진행률: 210/2534 (8%) | 성공: 205 | 스킵: 5 | 실패: 0 | Rate Limit: 10/200 (12초 경과)
...

============================================================
✅ PC 게임 Description 업데이트 완료!
============================================================
📊 총 처리: 2534개
   ✅ 업데이트 성공: 2480개
   ⏭️ 스킵 (데이터 없음): 50개
   ❌ 실패: 4개
```

### 실패 처리

실패한 게임은 로그에 상세히 기록되며, 스크립트는 계속 진행됩니다.
실패한 게임은 나중에 개별적으로 처리할 수 있습니다.

### 롤백 방법

업데이트 전 백업이 필요한 경우:

```sql
-- 백업 테이블 생성
CREATE TABLE game_details_backup AS
SELECT * FROM game_details WHERE platform_type = 'pc';

-- 필요 시 롤백
UPDATE game_details gd
SET
  screenshots = gdb.screenshots,
  video_url = gdb.video_url,
  description = gdb.description,
  -- 기타 필드들...
FROM game_details_backup gdb
WHERE gd.id = gdb.id;
```

### 문제 해결

1. **"요청한 게임을 찾을 수 없습니다" 에러**
   - 정상적인 경우입니다 (Steam에서 삭제된 게임 등)
   - 스킵되며 다음 게임으로 진행됩니다

2. **Rate Limit 429 에러**
   - 자동으로 대기 후 재시도합니다
   - 계속 발생하면 스크립트를 중단하고 나중에 재실행하세요

3. **메모리 부족**
   - `--limit` 옵션으로 배치 크기를 줄이세요
   - 예: `--limit 500`씩 여러 번 실행
