## Pipeline Contracts 디렉터리

- Collector(steam/rawg), 파이프라인 오케스트레이터, Persistence 계층이 공유하는 타입 정의를 모아둔다.
- 구현 세부 사항(서비스, 유틸)을 포함하지 않고, 인터페이스·타입·상수만 선언한다.
- 모든 주석과 설명은 한글로 작성한다.

### 파일 구성
- `processed-game-data.contract.ts`: 게임 데이터 본문, 회사/상세/릴리스 정보, Steam refresh 후보.
- `collector-options.contract.ts`: Steam/RAWG 수집 옵션과 기존 게임 맵 타입.
- `pipeline-response.contract.ts`: 파이프라인 실행 결과 및 공통 API 응답 래퍼.
- `index.ts`: 위 계약을 묶어서 export 하는 허브 파일.

### 사용 예시
```ts
import { ProcessedGameData } from '@pipeline/contracts';
```

### 유지 규칙
1. 계약 파일에서는 외부 서비스나 DB에 의존하는 코드를 import하지 않는다.
2. 타입 변경 시 관련 문서(`docs/phase2/plan.md`)와 테스트를 업데이트한다.
