# iPhone Simulator 모바일 UI 검증 — 2026-08-05

## 환경

- Xcode: 설치되지 않음. `xcodebuild -version`은 활성 개발자 디렉터리가 `/Library/Developer/CommandLineTools`라고 보고했다.
- Simulator devices: 확인 불가. `xcrun simctl`이 설치되어 있지 않다.
- 자동화 브라우저: Playwright WebKit, iPhone SE `320×568`, 표준 `393×852`, Max `430×932`
- Build: Next.js 16.2.12 production build

실제 Xcode Simulator Safari 검증과 Simulator 캡처는 수행하지 않았다. 아래 판정은 기본 브랜치 `ca186d2`와 모바일 브랜치 `eb6f74b`를 병합한 작업 트리에서 실행한 WebKit 자동 회귀검사 결과이며 Simulator 검증으로 간주하지 않는다.

## 결과

| 경로 | 320px | 393px | 430px | 키보드/safe area | 판정 |
| --- | --- | --- | --- | --- | --- |
| 역할 선택·교사 로그인·공통 헤더 | 통과 | 통과 | 통과 | 44px 행동 영역, 긴 한국어 문구, 계정 메뉴의 실시간 경로 | 자동화 통과 |
| 학생 대시보드·기록·리뷰 | 통과 | 통과 | 통과 | 정보→상태→다음 행동의 DOM/시각 순서, 긴 문구 | 자동화 통과 |
| 교사 대시보드·사용자·시험 상세·라이브 | 통과 | 통과 | 통과 | 행동 줄바꿈, 라이브 타이머, 모달 포커스/Escape | 자동화 통과 |
| 출제·배포 모달 | 통과 | 통과 | 통과 | safe-area 완료 바, 키보드 정적 배치, visual viewport 모달 | 자동화 통과 |
| 풀이·PDF | 통과 | 통과 | 통과 | 44px 도구 disclosure, 260/300px 키보드 viewport, 답안/PDF 포커스 전환, 제출 영역 | 자동화 통과 |

자동 회귀검사는 3개 폭에서 총 63건이 통과했다. 키보드 회귀는 답안 입력과 PDF 페이지 입력을 각각 실제 포커스한 뒤 `260px`과 `300px` 가시 높이에서 컨트롤·제출·활성 입력의 경계와 페이지 스크롤 정착 상태를 확인한다.

## 변경 전후

- 공통 화면: 화면마다 달랐던 모바일 여백과 행동 높이를 공통 토큰과 44px 터치 계약으로 정렬했다. 헤더와 로그인 행동은 320px에서도 잘리지 않고 줄바꿈된다.
- 학생·교사 경로: CSS 시각 순서에 기대던 구성을 실제 DOM 읽기 순서로 옮겼고, KPI보다 현재 상태와 다음 행동이 먼저 오도록 계층을 단순화했다.
- 출제·배포: 완료 행동은 safe area를 따르고 키보드가 열리면 문서 흐름으로 돌아간다. 배포 모달은 동기화된 visual viewport 안에서 내부 스크롤하며 포커스를 가둔다.
- 풀이·PDF: 좁은 화면의 제어 행을 가로 스크롤 대신 2행 grid로 바꿨다. 키보드 포커스가 답안에 있으면 OMR을, PDF 페이지 입력에 있으면 PDF를 유지해 활성 컨트롤이 사라지지 않는다.

실제 Simulator 전후 이미지는 Xcode와 iOS Simulator runtime이 없어 생성하지 않았다.

## 자동 검증

- Vitest: 195 files, 1,466 tests 통과
- ESLint: `npx eslint src e2e` 통과
- TypeScript: `npx tsc --noEmit` 통과
- Production build: `npm run build` 통과
- WebKit: 63/63 통과 (`ios-se-webkit`, `ios-standard-webkit`, `ios-max-webkit`)
- Diff: `git diff --check` 통과

## 남은 위험

- 실제 Mobile Safari의 브라우저 chrome, 소프트 키보드 애니메이션, 홈 인디케이터와의 조합은 Xcode Simulator 또는 실기기에서 아직 확인하지 못했다.
- 실제 Safari 다크 모드의 시각 비교 캡처는 없다.
- 학생 결과 리포트의 데스크톱 요약 영역은 정상 동작하지만 기존 sticky 추적 동작이 없어져 긴 리포트의 편의성이 낮아질 수 있다.
- 교사 라이브 실제 계정 empty-state E2E는 명시적인 `loaded` 신호가 없어 초기 빈 렌더를 관찰할 가능성이 있다. 다른 라이브 상태와 전체 WebKit 검사는 통과했지만 해당 단일 검사의 엄밀성은 후속 보강 대상이다.
