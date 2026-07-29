# 디자인 디벨롭 + 통폐합 기획

> 작성: 2026-07-29. 모든 수치는 이 날짜의 `main`(`ad0a81b`)을 실측한 값이다.
> 추정으로 쓴 문장은 "추정"이라고 명시했다.

## 0. 현재 상태 요약 (실측)

| 항목 | 값 |
| --- | --- |
| 라우트 | 16개 (redirect 1개 포함) |
| 최대 페이지 | `/teacher/users` 4,091줄 · `/create` 3,947줄 · `/solve/[id]` 3,205줄 |
| 인라인 `style={{}}` | **2,440회** (`/teacher/users` 단독 409회) |
| `globals.css` | 7,924줄 (압축 후 ~24KB — 전송량 문제는 아님, 유지보수 문제) |
| 랜딩 전송량 | 470KB (폰트 서브셋·recharts 분리 후) |
| 라우트별 eager JS | 최대 422KB(`/teacher/users`) ~ 163KB, 무거운 라이브러리 eager 잔존은 `/pwa-check`의 qrcode뿐 |

번들 쪽 큰 최적화는 끝났다. 남은 것은 **구조** — 중복 구현, 페이지 비대화,
디자인 일관성이다. 이 문서는 그걸 다룬다.

---

## 1. 통폐합 — 라우트

### 1a. `/groups` — 이미 처리됨, 제거 시점만 결정

12줄짜리 서버 redirect(`/teacher/users?tab=groups`)다. 내부 링크 0건.
**액션:** 외부에 공유된 URL이 없다고 판단되는 시점(예: 다음 메이저 배포)에 삭제.
그 전까지는 비용이 0이므로 방치해도 된다.

### 1b. `/pwa-check` — 프로덕션 번들에서 분리 (우선순위 상)

2,048줄, 내부 링크 1건, 순수 진단 페이지인데 **프로덕션 라우트로 항상 빌드**되고
qrcode를 eager로 실는다(라우트 220KB). 진단 페이지가 서비스 라우트와 같은 급으로
관리되는 상태.

**액션(택1):**
- **권장:** 페이지 본문을 `dynamic(() => …, { ssr: false })` 셸로 감싸 초기 청크에서
  제거하고, 헤더 nav 등 어디에도 노출하지 않는 진단 전용 URL로 유지.
- 대안: `NODE_ENV`/플래그로 404 처리. 단, PWA 검증 스크립트(`pwa:proof`)가 이
  페이지를 쓰므로 CI 경로 확인 필요 — `scripts/pwa-proof-verify.mjs`가 참조한다.

### 1c. `/teacher/live` ↔ `/teacher/exam/[id]` — 통합 후보 (우선순위 중)

둘 다 "시험 하나를 중심으로 한 교사 뷰"다. live(903줄)는 실시간 제출 현황,
exam/[id](442줄)는 배포·현황 요약. 사용자는 시험 상세에서 "지금 누가 풀고 있나"를
보러 live로 건너간다(상호 참조 6회).

**액션:** `/teacher/exam/[id]`에 "실시간" 탭으로 live를 흡수. `/teacher/live`는
redirect로 강등(전체 시험 대상 live 뷰가 필요하면 대시보드 위젯으로).
**효과:** 라우트 1개 감소, 시험 중심 내비게이션 단순화, TeacherHeader 중복 1곳 제거.
**리스크:** live는 폴링 로직을 가진다 — 탭 전환 시 폴링 시작/중단 수명주기를
명확히 해야 한다.

### 1d. `/student/history` ↔ `/student/dashboard` — 보류 권장

history(388줄)는 이미 얇다. 대시보드는 "해야 할 것", history는 "했던 것"으로
정보 목적이 다르고, 학생(특히 모바일)에게 페이지 분리가 인지적으로 더 싸다.
**액션: 통합하지 않는다.** 대신 §3의 공통 셸만 공유.

### 1e. `/teacher/billing` — 축소 후보 (우선순위 하)

1,247줄인데 실결제 미연동(SIMULATED PLAN)이다. 영수증 HTML 생성 등 미래 기능이
페이지 안에 들어 있다.
**액션:** 결제 연동 전까지 영수증/인보이스 코드를 별도 모듈로 빼고 페이지는 플랜
비교 + 시뮬레이션 상태 표시로 압축. 지금 급하지 않다 — 결제 연동 작업이 시작될 때
그 첫 단계로 수행.

---

## 2. 통폐합 — 컴포넌트/구현 중복

### 2a. MockupOverview ↔ OverviewTab — 데모 대시보드가 두 벌 (우선순위 상)

`MockupOverview`(387줄)는 `?showcase=1` 데모 계정 전용 개요 화면이고,
`OverviewTab`(791줄)은 실계정용이다. 그런데 대시보드에는 **이미**
`buildDemoDashboardData()`로 데모 데이터를 만들어 `OverviewTab`에 흘리는 경로가
있다(`forceDemoData`). 즉 "데모를 보여주는 방법"이 두 벌 존재한다.

**액션:** showcase 계정도 `OverviewTab` + `buildDemoDashboardData()` 경로로 통일하고
`MockupOverview`를 삭제. showcase에만 있는 연출(예: 고정 지표)이 있으면
`OverviewTab`의 prop으로 흡수.
**효과:** -387줄, recharts 소비자 1개 감소(로딩 성능 계약 테스트의 검사 대상도 줄어듦),
데모 화면과 실화면의 디자인 드리프트 원천 차단.
**검증:** `?showcase=1` 진입 시 기존 스크린샷과 비교. e2e `teacher-pages.spec.ts`.

### 2b. 교사 헤더 이원화 (우선순위 상, §3의 선행 작업)

`TeacherHeader`를 쓰는 페이지 5개(settings/live/users/exam/billing) vs 자체 헤더를
조립하는 페이지 2개(dashboard/create). dashboard와 create는 BrandLogo + 검색 +
세션칩 + 테마토글을 각자 배열한다.

**액션:** dashboard/create를 `TeacherHeader`로 수렴. create는 편집기 특성상 헤더가
다르면(저장 상태 표시 등) `TeacherHeader`에 slot prop을 추가하는 방향으로.
**효과:** 헤더 수정이 한 곳으로. §3 레이아웃 셸의 전제 조건.

### 2c. 거대 페이지 분해 — `/teacher/users`부터 (우선순위 중)

4,091줄 + 인라인 스타일 409회 + `useEffect` 9개. 이미 탭 3개(students/groups/invites)
구조이므로 절단선이 명확하다.

**액션:** 탭별 컴포넌트로 분해(`teacher/users/` 하위 `StudentsTab.tsx`,
`GroupsTab.tsx`, `InvitesTab.tsx`)하고, 대시보드 탭들처럼 비활성 탭을 `dynamic()`으로.
**효과(추정):** eager 422KB 중 상당분 지연화. 파일당 1,500줄 이하.
**주의:** 분해는 순수 이동으로만 — 동작 변경과 섞지 않는다. 한 탭당 커밋 1개.

`/create`(3,947줄)와 `/solve/[id]`(3,205줄)는 편집기/응시기라 절단선이 탭만큼
명확하지 않다. users에서 패턴을 확립한 뒤 별도 기획으로.

---

## 3. 디자인 디벨롭

### 방향

새 시안을 만드는 단계가 아니라 **이미 확립된 시스템(토큰·StatusPill·StatCard·
elevation 규칙)을 아직 안 쓰는 곳에 적용해 일관성을 회수**하는 단계다.
`globals.css`가 7,924줄이 된 원인이 인라인 일회성 값이라고 CLAUDE.md가 이미
진단했고, 인라인 스타일 2,440회가 그 증거다.

### 3a. 공통 프리미티브 승격 (우선순위 상)

인라인 반복 상위 패턴을 컴포넌트/클래스로 승격:

| 패턴 | 현황 | 액션 |
| --- | --- | --- |
| 버튼 | 페이지마다 `style={{}}` 조립 | `Button` 컴포넌트 (primary/secondary/danger/retake 톤 — StatusPill의 톤 체계 재사용) |
| 카드 | `bento-card` 클래스 + 인라인 혼용 | 카드 variant 클래스로 통일 |
| 모달 셸 | DistributeModal, 각종 confirm이 각자 구현 | `ModalShell` 하나로 |
| 폼 입력 | label+input+help 반복 | `Field` 래퍼 |

**진행 방식:** 새 코드에는 프리미티브만 허용하는 규칙을 먼저 세우고(리뷰 기준),
기존 코드는 §2c 분해 때 지나가는 파일만 전환한다. 일괄 치환 금지 —
2,440회를 한 번에 바꾸는 PR은 리뷰 불가능하다.

### 3b. 다크 모드 QA 패스 (우선순위 중)

토큰은 다크 값이 있으나 인라인 스타일은 하드코딩 색이 섞여 있다(예: solve의
`background: '#525659'`). 인라인 → 토큰 전환과 같은 파일 단위로 다크 모드
스크린샷 비교를 수행.

### 3c. Figma 프로덕트 맵 활용

`tools/figma-product-map/`이 이미 현재 구현 기준 화면 인벤토리·플로우·토큰을
생성한다. §1~2로 라우트/화면이 바뀌면 `code.js`의 ROUTES 테이블을 갱신하고
재실행 — 기획 리뷰는 Figma에서, 소스는 코드에서.

### 하지 않을 것

- 새 색/타입 스케일 추가 (기존 토큰으로 충분, CLAUDE.md 규칙 유지)
- Tailwind 등 스타일 시스템 교체 (전환 비용 > 이득)
- `--error` / `--grade-red` 통합 (명시적 금지 항목)

---

## 4. 실행 순서와 게이트

의존 관계를 따른 권장 순서. 각 단계는 독립 커밋/PR이고 전체 게이트
(`tsc` · `npm test` · `lint` · `build` · 필요시 e2e)를 통과해야 다음으로 간다.

```
Phase 1 (즉시, 저위험)
  1. 2a MockupOverview 제거          — -387줄, 중복 데모 경로 정리
  2. 1b /pwa-check 번들 분리          — 진단 코드를 서비스 번들에서 격리
  3. 2b 헤더 수렴 (dashboard, create) — 셸 통일의 전제

Phase 2 (구조)
  4. 2c /teacher/users 탭 분해        — 파일당 ≤1,500줄, 비활성 탭 dynamic()
  5. 3a 프리미티브 승격               — Button/ModalShell/Field, 분해 파일부터 적용
  6. 1c live → exam/[id] 탭 흡수      — 폴링 수명주기 설계 포함

Phase 3 (후속, 트리거 있을 때)
  7. 1e billing 압축                  — 결제 연동 착수 시
  8. /create·/solve 분해 기획         — users 패턴 검증 후 별도 문서
  9. 1a /groups 삭제                  — 다음 메이저 배포
```

**측정 기준(전/후 비교로 증명):**
- 라우트 eager JS: `/teacher/users` 422KB → (Phase 2 후 재측정)
- 인라인 스타일 수: 2,440 → 감소 추세 확인 (파일 단위)
- 페이지 최대 줄 수: 4,091 → ≤1,500
- 기존 회귀 가드 유지: `loadingPerformanceContract` · e2e 전체

## 5. 명시적 비목표

- 학생 응시 플로우(`/solve`)의 UX 변경 — 시험 중 화면은 안정성이 우선
- 서버/데이터 계층 변경 — 이번 범위는 클라이언트 구조와 디자인
- 신규 기능 — 이 기획은 순수 정리·통합이다
