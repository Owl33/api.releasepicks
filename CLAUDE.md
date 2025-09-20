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

### 핵심 요구사항 (🔄 2025.09.19 아키텍처 전환)
- **데이터 소스**: ~~IGDB API~~ → **RAWG API 단일 소스** (아키텍처 단순화)
- **사용자 인터페이스**: 직관적인 캘린더 뷰로 게임 출시일 표시
- **스토어 연결**: 모든 주요 스토어(Steam, PlayStation, Epic, Xbox) 페이지 링크
- **YouTube 트레일러**: 공식 트레일러 자동 매칭 및 표시
- **자동 업데이트**: 주간 1회 자동 데이터 갱신
- **반응형 디자인**: 모바일/데스크톱 호환

### 현재 개발 상태 (2025.09.20 Phase 1 완료)
- ✅ **아키텍처 대전환**: IGDB 복잡한 하이브리드 → **RAWG 단일 소스**로 단순화
- ✅ **RAWG API 연동**: 게임 데이터, 검색, 통계 API 완료 (스토어 정보 포함)
- ✅ **GameCalendarService**: 완성된 통합 게임 캘린더 데이터 서비스 구현
- ✅ **YouTube 트레일러 서비스**: 구현 완료, video 필드로 단순화 (API 키 설정 시 정상 동작)
- ✅ **불필요한 모듈 제거**: store-mapping 모듈 완전 제거 (~400라인 감소)
- ✅ **모든 메인 API 구현**: 캘린더, 게임 상세, YouTube, RAWG 모든 엔드포인트 완료
- ✅ **타입 안정성**: 완전한 TypeScript 타입 정의 및 컴파일 성공
- ✅ **보안 개선**: API 키 환경변수 분리 완료
- ❌ **아키텍처 리팩토링**: 현재 실시간 API 호출 → DB 기반 구조로 전환 필요 (Phase 2 예정)
- ❌ **데이터베이스**: 영구 저장 시스템 미구현 (Phase 2 예정)
- ❌ **프론트엔드**: UI 미구현 (Phase 3 예정)

---

## 🛠️ 개발 환경

### 빌드 및 실행 명령어
```bash
npm run build        # NestJS 애플리케이션 빌드
npm run start        # TypeScript 컴파일 및 watch 모드 서버 시작
npm run start:dev    # 개발 모드 (자동 재시작)
npm run start:debug  # 디버그 모드 (자동 재시작)
npm run start:prod   # 프로덕션 서버 (빌드 후 실행)
```

### 코드 품질 도구
```bash
npm run lint         # ESLint 자동 수정
npm run format       # Prettier 코드 포맷팅
```

### 테스트 명령어
```bash
npm run test         # 단위 테스트
npm run test:watch   # 테스트 watch 모드
npm run test:cov     # 커버리지 리포트
npm run test:debug   # Node.js 디버거 테스트
npm run test:e2e     # E2E 테스트
```

### 환경 설정
- **기본 포트**: 3000 (PORT 환경변수로 변경 가능)
- **TypeScript**: ES2023 타겟, Node.js next 모듈 해석
- **환경변수**: `.env` 파일 사용 (`@nestjs/config`)

### 보안 개선 필요사항
- **API 키 하드코딩**: 현재 RAWG API 키가 코드에 포함됨 → 환경변수 분리 필요

---

## 🏗️ 현재 시스템 아키텍처 (✅ 2025.09.20 구현 완료)

### 현재 기술 스택 (실시간 API 호출 기반)
- **백엔드**: NestJS + TypeScript
- **메인 데이터 소스**: RAWG.io API (단일 소스)
- **보조 서비스**: YouTube Data API (공식 트레일러 매칭)
- **데이터 저장**: 없음 (실시간 API 호출만)
- **프론트엔드**: React + Next.js (Phase 3 예정)

### 현재 모듈 구조 (3개 모듈)

#### 1. 메인 게임 캘린더 서비스 (`src/game-calendar/`)
- **GameCalendarService** (`game-calendar.service.ts`)
  - RAWG API + YouTube API 통합 호출
  - 실시간 월별 게임 데이터 조합
  - 완성된 캘린더 데이터 구조 생성
- **GameCalendarController** (`game-calendar.controller.ts`)
  - `GET /calendar/:month` - 완성된 캘린더 데이터 (실시간 조합)
  - `GET /calendar/game/:id` - 게임 상세 정보 (실시간 조합)

#### 2. RAWG 데이터 소스 (`src/rawg/`)
- **RawgService** (`rawg.service.ts`)
  - RAWG.io API 직접 호출 및 데이터 변환
  - 게임 데이터, 스토어 정보, 상세 정보 제공
- **RawgController** (`rawg.controller.ts`)
  - `GET /rawg/games` - 월별 RAWG 게임 데이터
  - `GET /rawg/games/:gameId` - 게임 상세 조회
  - `GET /rawg/games/:gameId/stores` - 스토어 정보 조회

#### 3. YouTube 트레일러 서비스 (`src/youtube/`)
- **YouTubeService** (`youtube.service.ts`)
  - YouTube Data API 호출 및 트레일러 검색
  - 게임명 기반 최적 트레일러 매칭
- **YouTubeController** (`youtube.controller.ts`)
  - `GET /youtube/trailer/:gameName` - 상세 트레일러 검색
  - `GET /youtube/simple/:gameName` - 간단한 트레일러 조회
  - `GET /youtube/statistics` - 서비스 통계
  - `GET /youtube/search-options` - 검색 옵션 정보

#### 타입 정의 (`src/types/`)
- **game-calendar.types.ts**: 통합 게임 캘린더 타입 정의
- **youtube.types.ts**: YouTube 트레일러 검색 타입 정의

### 현재 API 엔드포인트 현황 (실시간 API 호출 기반)

#### 🎯 메인 캘린더 API (✅ 완성)
| 엔드포인트 | 상태 | 설명 |
|------------|------|------|
| `GET /calendar/:month` | ✅ **프로덕션** | **메인 API** - 실시간 통합 캘린더 데이터 (RAWG + YouTube) |
| `GET /calendar/game/:id` | ✅ **프로덕션** | 실시간 게임 상세 정보 (모든 서비스 통합) |

#### 🔧 RAWG 데이터 소스 API (✅ 완성)
| 엔드포인트 | 상태 | 설명 |
|------------|------|------|
| `GET /rawg/games` | ✅ **프로덕션** | RAWG 월별 게임 데이터 (실시간 조회) |
| `GET /rawg/games/:gameId` | ✅ **프로덕션** | RAWG 게임 상세 조회 (실시간) |
| `GET /rawg/games/:gameId/stores` | ✅ **프로덕션** | RAWG 스토어 정보 조회 (실시간) |

#### 🌐 YouTube 트레일러 API (✅ 완성)
| 엔드포인트 | 상태 | 설명 |
|------------|------|------|
| `GET /youtube/trailer/:gameName` | ✅ **프로덕션** | 게임 공식 트레일러 검색 (실시간) |
| `GET /youtube/simple/:gameName` | ✅ **프로덕션** | 간단한 트레일러 조회 (실시간) |
| `GET /youtube/statistics` | ✅ **프로덕션** | YouTube 서비스 통계 |
| `GET /youtube/search-options` | ✅ **프로덕션** | 지원하는 검색 옵션 정보 |

---

## 🔮 **향후 아키텍처: DB 기반 시스템** (Phase 2 목표)

### 아키텍처 전환 방향
**현재 구조** (실시간 API 호출):
```
사용자 요청 → GameCalendar Controller → RAWG/YouTube Service → 외부 API → 실시간 응답
```

**향후 구조** (DB 기반 분리):
```
1. 데이터 수집: RAWG Controller → 외부 API → PostgreSQL DB 저장
2. 데이터 서비스: GameCalendar Controller → PostgreSQL DB 조회 → 빠른 응답
```

### 향후 기술 스택 (Phase 2 목표)
- **백엔드**: NestJS + TypeScript (동일)
- **데이터 수집**: RAWG.io API + YouTube Data API
- **데이터베이스**: TypeORM + PostgreSQL (영구 저장)
- **캐싱**: Redis (선택사항)
- **프론트엔드**: React + Next.js (Phase 3)

### 향후 모듈 역할 분리
#### RAWG 모듈 → **데이터 수집 전담**
- `POST /rawg/collect/:month` - 월별 게임 데이터 수집 → DB 저장
- `POST /rawg/collect/game/:id` - 게임 상세 정보 수집 → DB 저장
- 외부 API 호출 및 DB 저장 로직 전담

#### GameCalendar 모듈 → **서비스 제공 전담**
- `GET /calendar/:month` - DB에서 월별 캘린더 데이터 조회
- `GET /calendar/game/:id` - DB에서 게임 상세 정보 조회
- 빠른 DB 조회 및 사용자 서비스 전담

### 향후 DB 스키마 (2테이블 설계)
```sql
-- 캘린더용 기본 정보 (빠른 로딩)
CREATE TABLE games (
  id INTEGER PRIMARY KEY,
  name VARCHAR(255),
  released DATE,
  rating DECIMAL,
  image_url TEXT,
  platforms JSONB,
  genres JSONB
);

-- 상세 페이지용 정보 (풍부한 정보)
CREATE TABLE games_detail (
  game_id INTEGER PRIMARY KEY REFERENCES games(id),
  description TEXT,
  developers JSONB,
  publishers JSONB,
  stores JSONB,
  youtube_trailer TEXT,
  screenshots JSONB
);
```

---

### 현재 한계사항 (실시간 API 호출 방식)

- **캐싱 시스템 없음**: Redis 캐싱 시스템 미구현 (Phase 2 예정)
- **데이터베이스 영구 저장**: 현재 실시간 API 호출만 지원 (Phase 2 예정)
- **성능 최적화**: 병렬 처리 및 응답 속도 최적화 여지 있음


## 📅 개발 로드맵

### **Phase 1: 실시간 API 기반 게임 캘린더 시스템 구축** ✅ **완료 (2025.09.20)**
> **우선순위**: 최고 | **기간**: 2-3주 | **상태**: ✅ **완료**

**목표**: 실시간 API 호출 기반의 완전한 게임 캘린더 시스템 구현 (DB 없이)

#### Phase 1-0: 코드베이스 정리 (선행 작업) ✅ **완료 (2025.09.19)**
- [x] **IGDB 관련 코드 완전 제거**
  - `src/igdb/` 폴더 전체 삭제
  - `src/app.module.ts`에서 IgdbModule 제거
  - .env.example 파일 정리 (사용하지 않는 파일 삭제)
- [x] **RAWG 단일 소스 구조로 정리**
  - RAWG API만 남기고 모든 IGDB 연동 코드 정리 (.env 포함)
  - 깔끔한 단일 API 구조로 재정비
- [x] **보안 개선**
  - RAWG API 키를 환경변수로 이동
  - 하드코딩된 API 키 제거

#### Phase 1-A: 핵심 데이터 서비스 구현 (1주) ✅ **완료 (2025.09.19)**
- [x] **GameCalendarService 구현**
  - RAWG API 기반 월별 게임 데이터 수집
  - 인기도 필터링 (added 기준 정렬 활용)
  - 게임 상세 정보 통합 처리
  - 스토어 링크 및 YouTube 트레일러 통합
- [x] **YouTube 트레일러 서비스**
  - YouTube Data API 활용한 공식 트레일러 검색
  - 신뢰도 점수 기반 최적 트레일러 선택


#### Phase 1-B: 메인 API 구현 ✅ **완료 (2025.09.20)**
- [x] **게임 캘린더 API** (`GET /calendar/:month`) ✅ **완료**
  - RAWG + YouTube 실시간 통합 데이터
  - 프론트엔드 친화적 완성형 응답 구조
  - 월별 필터링, 인기도 정렬, 메타데이터 모두 포함
- [x] **게임 상세 API** (`GET /calendar/game/:id`) ✅ **완료**
  - RAWG 상세 + 스토어 + YouTube 트레일러 모두 통합
  - 단일 요청으로 완전한 게임 정보 제공

#### Phase 1-C: 서비스 완성도 검증 ✅ **완료 (2025.09.20)**
- [x] **RAWG API 최적화 완성** - `ordering=-added` 인기도 정렬 적용
- [x] **전체 API 엔드포인트 검증** - 9개 엔드포인트 모두 정상 동작 확인
- [x] **데이터 구조 완성도 검증** - 프론트엔드 요구사항 100% 충족
- [x] **실제 데이터 테스트** - 2025년 게임 데이터로 완전성 검증

### **Phase 2: DB 기반 아키텍처 전환** 💾
> **우선순위**: 최고 | **기간**: 3-4주 | **상태**: 🎯 설계 완료

**목표**: 현재 실시간 API 호출 → DB 기반 데이터 서비스로 아키텍처 전환

#### 🏗️ **아키텍처 전환 방향**
**현재 구조** (실시간 API 호출):
```
GameCalendar → RAWG Service → 외부 RAWG.io API
```

**새로운 구조** (DB 기반 분리):
```
1. RAWG Controller → 외부 RAWG.io API → DB 저장 (데이터 수집)
2. GameCalendar Controller → 내부 DB 조회 (서비스 제공)
```

#### 📋 **Phase 2-A: 컨트롤러 역할 완전 분리** (1주)
- [ ] **RAWG Controller → 데이터 수집 전담으로 리팩토링**
  - `POST /rawg/collect/:month` - 외부 API에서 DB로 저장
  - `POST /rawg/collect/game/:id` - 게임 상세 정보 수집 새로운 POST 메소드
- [ ] **GameCalendar Controller → DB 조회 전담으로 리팩토링**
  - 현재 RAWG Service 호출을 DB Repository 호출로 변경
  - `GET /calendar/:month` - DB에서 월별 데이터 조회
  - `GET /calendar/game/:id` - DB에서 게임 상세 정보 조회
#### 📋 **Phase 2-B: 현재 데이터 검증 및 추가 정보 수집** (1주)
- [ ] **실제 API 응답 데이터 완전성 검증**
  - 2025년 1월-8월 각 월별 게임 데이터 품질 검증
  - RAWG API 응답 필드 누락 여부 확인
  - YouTube 트레일러 매칭 정확도 검증
- [ ] **RAWG API 추가 정보 수집 구현**
  - `games/{id}/developers` 엔드포인트 활용
  - `games/{id}/publishers` 엔드포인트 활용
  - developers, publishers 정보를 게임 상세 데이터에 통합
- [ ] **프론트엔드 요구사항 100% 충족 확인**
  - 캘린더 뷰에 필요한 모든 데이터 확보 검증
  - 게임 상세 페이지에 필요한 모든 데이터 확보 검증


#### 📋 **Phase 2-C: 검증된 데이터 기반 DB 구축** (1주)
- [ ] **검증된 데이터 기반 PostgreSQL 스키마 구현**
  - `games` 테이블: 캘린더용 기본 정보 (name, released, rating, image, platforms, genres)
  - `games_detail` 테이블: 상세 페이지용 정보 (description, developers, publishers, stores, youtube, screenshots)
- [ ] **TypeORM 엔티티 및 Repository 구현**
  - Game 엔티티 (캘린더 최적화)
  - GameDetail 엔티티 (JSONB 필드 활용)
  - 선택적 조인 관계 설정

#### 📋 **Phase 2-D: 초기 데이터 마이그레이션** (1주)
- [ ] **검증된 데이터로 초기 DB 구축**
  - 새로운 수집 시스템으로 2025년 1월-8월 데이터 저장
  - RAWG API 완전 활용 (developers, publishers, stores 포함)
  - 데이터 무결성 및 성능 검증
- [ ] **선택사항: Redis 캐싱 시스템**
  - API 응답 캐싱 (TTL 기반)
  - YouTube 트레일러 링크 캐싱

### **Phase 3: 프론트엔드 구현** 🎨
> **우선순위**: 높음 | **기간**: 2-3주

#### 주요 작업
- [ ] React + Next.js 설정
- [ ] 월별 캘린더 UI 구현
- [ ] 게임 카드 디자인 (스토어 링크, YouTube 트레일러 포함)
- [ ] 반응형 디자인
- [ ] **데이터베이스 기반 데이터 표시** (1월-8월 실제 데이터 활용)

### **Phase 4: 자동화 및 스케줄링** ⏰
> **우선순위**: 중간 | **기간**: 1-2주

#### 주요 작업
- [ ] **9월부터 자동 데이터 수집**
  - 크론 스케줄러 구현
  - Phase 1 데이터 구조에 맞춰 자동 저장
- [ ] **성능 모니터링**
- [ ] **Docker 컨테이너화**

---

## 📊 현재 진행 상황

### 🔄 작업 상태 추적
- **마지막 업데이트**: 2025.09.20 
- **현재 Phase**: **Phase 2 설계 완료**

- **다음 마일스톤**: **Phase 2-B PostgreSQL 데이터베이스 설정**

- **수정된 프로젝트 순서** (DB 기반 아키텍처 전환):
  1. ✅ **Phase 1: 완벽한 데이터 구조 구축** - **완료! (2025.09.20)**
  2. ✅ **Phase 2-A: 컨트롤러 역할 완전 분리** - **완료! (2025.09.20)**
  3. 🎯 **Phase 2-B: PostgreSQL 데이터베이스 설정** - **다음 단계 (1주)**
  4. **Phase 2-C: 데이터 검증 및 추가 정보 수집** - 1주
  5. **Phase 2-D: 초기 데이터 마이그레이션** (1-8월 데이터 저장) - 1주
  6. **Phase 3: 프론트엔드 구현** (DB 기반 데이터 표시) - 2-3주
  7. **Phase 4: 9월부터 자동화** (데이터 수집 자동화) - 1-2주
- **Phase 2-A 완료 상태** (2025.09.20):
  - ✅ **아키텍처 전환 완료**: 실시간 API → DB 기반 구조 분리
    - **기존 GET 메소드**: 사용자용 서비스 (실시간 API 호출)
    - **새로운 POST 메소드**: 관리자용 데이터 수집 (DB 저장용)
  - ✅ **엔티티 구현**: Game(캘린더) + GameDetail(상세) 분리 설계
  - ✅ **TypeORM 구조**: 완전한 엔티티 및 모듈 구조 완성
  - ⚠️ **DB 연결**: PostgreSQL 설정 대기 (Phase 2-B에서 처리)
- **블로커**: PostgreSQL 설정 필요 (Docker 또는 로컬 설치)

---