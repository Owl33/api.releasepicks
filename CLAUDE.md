# CLAUDE.md

Claude Code 작업 가이드 문서

## ⚠️ 중요 작업 규칙

### 📋 문서 업데이트 필수 원칙
1. **CLAUDE.md 우선 업데이트**: 모든 코드 작성 전에 반드시 이 문서에 먼저 계획 작성
2. **주제별 섹션 배치**: 새 내용 추가 시 관련 섹션에 배치 (아래로만 추가 금지)
3. **설계 → 문서화 → 구현**: 반드시 이 순서 준수
4. **실시간 상태 업데이트**: 작업 완료 시마다 해당 섹션 즉시 업데이트
5. **한글 우선**: 모든 설명과 주석은 한글로 작성

**절대 금지**: 계획 없이 바로 코드 작성

---

## 📋 프로젝트 개요

### 🎯 프로젝트 목표
**게임 출시 캘린더 홈페이지** - 앞으로 출시할 게임의 스케줄을 보여주는 캘린더 형태의 웹서비스

### 📊 현재 상태 (2025-09-21)
- ✅ **백엔드 핵심 기능**: NestJS + TypeScript 완성
- ✅ **데이터베이스**: PostgreSQL + TypeORM 완전 구축
- ✅ **데이터 수집**: RAWG API + youtube-sr 통합 완료
- ✅ **스토어 링크**: 6개 플랫폼 자동 생성
- ✅ **YouTube 트레일러**: quota 없는 검색 시스템 완성
- ⚠️ **서비스 API**: 기본 구현만 완료 (확장 필요)
- ❌ **프론트엔드**: UI 미구현

### 🏗️ 현재 기술 스택
- **백엔드**: NestJS + TypeScript ✅
- **데이터베이스**: PostgreSQL (Supabase) + TypeORM ✅
- **데이터 수집**: RAWG.io API + youtube-sr ✅
- **프론트엔드**: React + Next.js (예정)

## 📂 현재 시스템 구조

### 🔌 완성된 API 엔드포인트
```typescript
// 데이터 수집 모듈 (RAWG)
GET  /rawg/released/:month     // 월별 게임 데이터 조회
POST /rawg/save/:month         // 월별 게임 데이터 DB 저장
GET  /rawg/movies/:gameId      // 테스트용 영상 데이터

// YouTube 트레일러 모듈
GET  /youtube/simple/:gameName // 트레일러 검색 (quota 없음)

// 게임 캘린더 서비스 (기본만)
GET  /games                    // 전체 게임 조회
```

### 🗄️ 데이터베이스 스키마 (완성됨)
```sql
-- games 테이블 (메인 게임 정보)
CREATE TABLE games (
  id SERIAL PRIMARY KEY,
  rawg_id INTEGER UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  released DATE,
  platforms TEXT[],
  genres TEXT[],
  added INTEGER,
  image TEXT,
  developers TEXT[],
  publishers TEXT[]
);

-- game_details 테이블 (상세 정보)
CREATE TABLE game_details (
  id SERIAL PRIMARY KEY,
  game_id INTEGER REFERENCES games(id),
  slug_name VARCHAR(255),
  tags TEXT[],
  rating DECIMAL,
  early_access BOOLEAN,
  ratings_count INTEGER,
  screenshots TEXT[],
  store_links JSONB,
  esrb_rating VARCHAR(50),
  description TEXT,
  website TEXT
);
```

### 🔄 데이터 흐름 (완성됨)
```mermaid
RAWG API → RawgService → 데이터 가공 → DB 저장
                     ↓
              YouTube 트레일러 추가
                     ↓
              스토어 링크 자동 생성
                     ↓
              GameCalendar API → 프론트엔드
```

## 🎯 다음 우선순위 작업

### **📋 Phase 3-A: GameCalendar API 확장** (즉시 필요)
> **우선순위**: 긴급 | **기간**: 3-5일

#### 필요한 API 엔드포인트
```typescript
// 월별 캘린더 조회 (필터링 & 정렬 포함)
GET /calendar/:month?minPopularity=10&platforms=pc,playstation&sortBy=releaseDate

// 게임 상세 정보 조회
GET /calendar/game/:id

// 검색 기능
GET /calendar/search?q=silksong&limit=10
```

#### 구현 계획
- [ ] **월별 캘린더 컨트롤러** 구현
  - DB에서 해당 월 게임 조회
  - 필터링 (플랫폼, 인기도, 장르)
  - 정렬 (출시일, 인기도, 이름)
- [ ] **게임 상세 컨트롤러** 구현
  - 게임 + 상세정보 조인 조회
  - YouTube 트레일러 정보 포함
- [ ] **검색 기능** 구현
  - 게임명 기반 검색
  - 개발사/배급사 검색

### **📋 Phase 3-B: 실제 데이터 마이그레이션** (즉시 필요)
> **우선순위**: 높음 | **기간**: 2-3일

#### 데이터 수집 계획
```bash
# 2025년 전체 데이터 수집
POST /rawg/save/2025-01  # 완료 (40개 게임)
POST /rawg/save/2025-02  # 대기
POST /rawg/save/2025-03  # 대기
# ... 2025-12까지
```

#### 작업 목록
- [ ] **2025년 2월-12월 데이터 수집**
  - 월별 배치 실행
  - 데이터 품질 검증
- [ ] **YouTube 트레일러 보완**
  - 기존 게임 트레일러 재검색
  - 누락된 트레일러 수동 보완
- [ ] **데이터 무결성 검증**
  - 중복 데이터 제거
  - 필드 완성도 검사

### **📋 Phase 3-C: 프론트엔드 개발** (2-3주)
> **우선순위**: 높음 | **완료 후 서비스 론칭 가능**

#### 기술 스택 결정
```typescript
// 프론트엔드 설정
- Framework: Next.js 15 + React 18
- Styling: Tailwind CSS + shadcn/ui
- State: Zustand or TanStack Query
- Database: 백엔드 API 연동
```

#### UI/UX 설계
- [ ] **월별 캘린더 뷰**
  - 그리드 형태 게임 카드
  - 날짜별 게임 배치
  - 필터 및 정렬 UI
- [ ] **게임 상세 모달**
  - 스크린샷 갤러리
  - YouTube 트레일러 재생
  - 스토어 링크 버튼
- [ ] **반응형 디자인**
  - 모바일 최적화
  - 태블릿 지원

#### 구현 단계
- [ ] **Next.js 프로젝트 설정**
- [ ] **API 연동 레이어** 구현
- [ ] **컴포넌트 개발** (게임카드, 캘린더, 필터)
- [ ] **페이지 구현** (메인, 상세)
- [ ] **배포 설정** (Vercel or Netlify)

## 🚀 개발 로드맵 (2025년 4분기)

### **10월 (백엔드 완성)**
- Week 1: GameCalendar API 확장
- Week 2: 실제 데이터 마이그레이션
- Week 3: API 성능 최적화
- Week 4: 문서화 및 테스트

### **11월 (프론트엔드 개발)**
- Week 1: Next.js 설정 및 기본 구조
- Week 2: 캘린더 UI 컴포넌트 개발
- Week 3: 상세 페이지 및 상호작용
- Week 4: 반응형 디자인 및 최적화

### **12월 (론칭 및 운영)**
- Week 1: 베타 테스트 및 버그 수정
- Week 2: 최종 배포 및 론칭
- Week 3: 사용자 피드백 수집
- Week 4: 개선사항 적용

## 🎛️ 현재 해결된 문제들

### ✅ **YouTube API Quota 문제** (완전 해결)
- **기존**: YouTube Data API → 10,000 tokens/day 제한
- **해결**: youtube-sr 패키지 → **무제한 사용**
- **결과**: 실제 비디오 ID 반환, 쿼터 걱정 없음

### ✅ **데이터베이스 구축** (완전 완료)
- **PostgreSQL + TypeORM** 완전 구축
- **관계형 설계**: games ↔ game_details
- **JSONB 활용**: 스토어 링크 유연한 저장

### ✅ **RAWG API 통합** (완전 완료)
- **다중 페이지 수집**: 최대 200개/월
- **스토어 링크 자동 생성**: 6개 플랫폼
- **데이터 가공**: 정규화 및 최적화 완료

## 🛠️ 기술 참고사항

### **환경 설정**
```bash
# 개발 서버 실행
npm run start:dev

# DB 연결 확인
# Supabase PostgreSQL 자동 연결됨
```

### **중요 파일 구조**
```
src/
├── entities/           # TypeORM 엔티티
│   ├── game.entity.ts          # 게임 기본 정보
│   └── game-detail.entity.ts   # 게임 상세 정보
├── rawg/              # RAWG API 모듈
│   ├── rawg.service.ts         # 데이터 수집 로직
│   └── rawg.controller.ts      # API 엔드포인트
├── youtube/           # YouTube 모듈
│   ├── youtube.service.ts      # youtube-sr 기반 검색
│   └── youtube.controller.ts   # 트레일러 API
└── game-calendar/     # 서비스 제공 모듈
    ├── game-calendar.service.ts
    └── game-calendar.controller.ts
```

### **핵심 데이터 타입**
```typescript
// 게임 캘린더 아이템 (완성된 형태)
interface GameCalendarItem {
  rawgId: number;
  name: string;
  released: string;
  platforms: string[];
  genres: string[];
  rating: number;
  image: string;
  storeLinks: StoreLinks;  // 6개 플랫폼
  video?: string;          // YouTube URL
  developers: string[];
  publishers: string[];
  // ... 기타 필드
}
```

### **성능 최적화 사항**
- **데이터 수집**: 페이지당 40개, 최대 200개/월
- **YouTube 검색**: youtube-sr로 쿼터 무제한
- **스토어 링크**: RAWG API + fallback URL 생성
- **DB 최적화**: 관계형 설계 + JSONB 활용

---

# important-instruction-reminders
Do what has been asked; nothing more, nothing less.
NEVER create files unless they're absolutely necessary for achieving your goal.
ALWAYS prefer editing an existing file to creating a new one.
NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.


      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.