# iPhone Safari Mobile UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Xcode iPhone Simulator의 Safari에서 OMR Maker 핵심 경로가 320–430px, safe area, 키보드, 다크 모드 조건에서도 의도된 계층과 정렬을 유지하도록 개선한다.

**Architecture:** 기존 Next.js/PWA와 디자인 토큰을 유지하고, 공통 모바일 리듬은 `globals.css`와 기존 헤더 컴포넌트에 모은다. 화면별로는 DOM 순서와 모바일 전용 리플로우만 최소 수정하며, 실제 Simulator 수동 확인과 WebKit 자동 회귀검사를 함께 사용한다. 현재 작업 트리의 기존 변경은 사용자 작업으로 간주해 덮어쓰지 않고 병합한다.

**Tech Stack:** Next.js 16, React 19, TypeScript, CSS, Vitest, Playwright WebKit, Xcode Simulator Safari

---

## 파일 구조

- Create: `e2e/ios-mobile-layout.spec.ts` — iPhone 폭별 overflow, 터치 크기, 핵심 행동 가시성 회귀검사
- Create: `src/lib/iosMobileLayoutSurface.test.ts` — 공통 모바일 클래스와 화면별 적용 계약
- Create: `docs/quality/ios-simulator-mobile-ui-2026-08-05.md` — 기기별 점검 결과와 캡처 인덱스
- Modify: `playwright.config.ts` — WebKit iPhone SE/표준/Max 프로젝트
- Modify: `src/app/globals.css` — 모바일 여백·스택·행동·오버레이 공통 규칙
- Modify: `src/components/TeacherHeader.tsx` — 좁은 화면 헤더 정렬과 44px 제어
- Modify: `src/app/page.tsx`, `src/app/page.module.css` — 역할·로그인 화면의 iPhone 키보드/정렬
- Modify: `src/app/student/dashboard/page.tsx`, `src/app/student/history/page.tsx`, `src/app/student/review/[attemptId]/page.tsx` — 학생 정보 계층과 세로 리플로우
- Modify: `src/app/teacher/dashboard/page.tsx`, `src/app/teacher/users/page.tsx`, `src/app/teacher/exam/[id]/page.tsx`, `src/app/teacher/live/page.tsx` — 교사 데이터 화면의 모바일 카드·행동 정렬
- Modify: `src/app/create/page.tsx`, `src/app/solve/[id]/page.tsx` — 출제·풀이의 패널 전환과 safe-area 행동 영역
- Modify carefully: `src/components/DistributeModal.tsx`, `src/components/PDFViewer.tsx` — 현재 작업 트리 변경을 유지하며 iPhone 오버레이만 병합

### Task 1: iPhone WebKit 회귀검사 기반 만들기

**Files:**
- Create: `e2e/ios-mobile-layout.spec.ts`
- Modify: `playwright.config.ts`

- [ ] **Step 1: 실패하는 iPhone 레이아웃 검사를 작성한다**

```ts
import { expect, test, type Page } from "@playwright/test";

async function expectViewportContained(page: Page) {
  const metrics = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(metrics.content).toBeLessThanOrEqual(metrics.viewport + 1);
}

async function expectTouchTarget(page: Page, selector: string) {
  const box = await page.locator(selector).first().boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
}

test("role selection fits the iPhone viewport", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /시작|OMR/i })).toBeVisible();
  await expectViewportContained(page);
  await expectTouchTarget(page, "button");
});
```

- [ ] **Step 2: 테스트가 현재 프로젝트 구성에서 실패하는지 확인한다**

Run: `PLAYWRIGHT_ENABLE_WEBKIT=1 npx playwright test e2e/ios-mobile-layout.spec.ts --project=ios-se-webkit`

Expected: FAIL because `ios-se-webkit` is not configured yet.

- [ ] **Step 3: 세 iPhone WebKit 프로젝트를 추가한다**

Add to `playwright.config.ts` without removing the existing projects:

```ts
const iosLayoutProjects = enableWebKitPwa ? [
  { name: "ios-se-webkit", viewport: { width: 320, height: 568 } },
  { name: "ios-standard-webkit", viewport: { width: 393, height: 852 } },
  { name: "ios-max-webkit", viewport: { width: 430, height: 932 } },
].map(({ name, viewport }) => ({
  name,
  testMatch: /ios-mobile-layout\.spec\.ts/,
  use: {
    ...devices["iPhone 13"],
    browserName: "webkit" as const,
    viewport,
  },
}));
```

Append `...iosLayoutProjects` to `projects`.

- [ ] **Step 4: 세 폭의 baseline 결과를 기록한다**

Run: `PLAYWRIGHT_ENABLE_WEBKIT=1 npx playwright test e2e/ios-mobile-layout.spec.ts --project=ios-se-webkit --project=ios-standard-webkit --project=ios-max-webkit`

Expected: the projects start successfully; any layout failures become the implementation baseline rather than being weakened or skipped.

- [ ] **Step 5: 기반 검사만 커밋한다**

```bash
git add playwright.config.ts e2e/ios-mobile-layout.spec.ts
git commit -m "test: add iPhone WebKit layout matrix"
```

### Task 2: 공통 모바일 리듬과 헤더 정렬

**Files:**
- Create: `src/lib/iosMobileLayoutSurface.test.ts`
- Modify: `src/app/globals.css`
- Modify: `src/components/TeacherHeader.tsx`
- Modify: `src/app/page.tsx`
- Modify: `src/app/page.module.css`

- [ ] **Step 1: 공통 모바일 계약 테스트를 작성한다**

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
const teacherHeader = readFileSync(join(process.cwd(), "src/components/TeacherHeader.tsx"), "utf8");
const home = readFileSync(join(process.cwd(), "src/app/page.tsx"), "utf8");

describe("iPhone mobile layout surface", () => {
  it("defines one shared mobile spacing and action contract", () => {
    expect(css).toContain("--mobile-inline-space");
    expect(css).toContain(".mobile-section-stack");
    expect(css).toContain(".mobile-action-row");
    expect(css).toContain("min-height: 44px");
  });

  it("uses the shared contract in the global teacher header and login entry", () => {
    expect(teacherHeader).toContain("mobile-action-row");
    expect(home).toContain("mobile-section-stack");
  });
});
```

- [ ] **Step 2: Vitest RED를 확인한다**

Run: `npm test -- --run src/lib/iosMobileLayoutSurface.test.ts`

Expected: FAIL because the shared classes do not exist.

- [ ] **Step 3: 디자인 토큰 기반 모바일 프리미티브를 추가한다**

Add to `src/app/globals.css`:

```css
:root {
  --mobile-inline-space: clamp(1rem, 4vw, 1.25rem);
  --mobile-section-gap: clamp(1rem, 4.8vw, 1.5rem);
}

.mobile-section-stack {
  display: grid;
  gap: var(--mobile-section-gap);
  min-width: 0;
}

.mobile-action-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
}

@media (max-width: 640px) {
  .mobile-action-row {
    flex-wrap: wrap;
  }

  .mobile-action-row > :is(button, a, input, select) {
    min-height: 44px;
  }
}
```

- [ ] **Step 4: 홈과 교사 헤더에 공통 클래스를 적용한다**

Use `mobile-section-stack` on the login content wrapper and `mobile-action-row` on the teacher header action group. Preserve existing accessible names, links, session controls, and desktop layout.

- [ ] **Step 5: 320px에서 헤더와 로그인 폼을 검증한다**

Run: `npm test -- --run src/lib/iosMobileLayoutSurface.test.ts src/lib/homeLoginAccessibilitySurface.test.ts`

Expected: PASS, with no source contract regression.

- [ ] **Step 6: 공통 모바일 리듬을 커밋한다**

```bash
git add src/app/globals.css src/components/TeacherHeader.tsx src/app/page.tsx src/app/page.module.css src/lib/iosMobileLayoutSurface.test.ts
git commit -m "feat: align shared iPhone mobile surfaces"
```

### Task 3: 학생 핵심 경로를 세로 과업 흐름으로 정리한다

**Files:**
- Modify: `src/app/student/dashboard/page.tsx`
- Modify: `src/app/student/history/page.tsx`
- Modify: `src/app/student/review/[attemptId]/page.tsx`
- Modify: `src/app/globals.css`
- Modify: `e2e/ios-mobile-layout.spec.ts`

- [ ] **Step 1: 학생 경로의 실패하는 모바일 검사를 추가한다**

```ts
test("student dashboard keeps identity, status, and next action in order", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => sessionStorage.setItem("omr_student_session", JSON.stringify({
    name: "모바일 점검 학생",
    studentId: "ios-mobile-student",
    groupId: "demo-group",
    groupName: "iOS 점검반",
    isGuest: false,
  })));
  await page.goto("/student/dashboard");
  await expectViewportContained(page);
  await expect(page.locator(".student-dashboard-identity")).toBeVisible();
  await expect(page.locator("main")).toHaveCSS("min-width", "0px");
});
```

Add equivalent containment assertions for `/student/history` and the existing showcase review route used by current E2E fixtures.

- [ ] **Step 2: RED 또는 기존 overflow를 확인한다**

Run: `PLAYWRIGHT_ENABLE_WEBKIT=1 npx playwright test e2e/ios-mobile-layout.spec.ts --project=ios-se-webkit --grep student`

Expected: at least one hierarchy, selector, or containment assertion fails before the mobile classes are applied.

- [ ] **Step 3: DOM 순서와 모바일 스택 클래스를 적용한다**

Apply these rules through existing class names in `globals.css`:

```css
@media (max-width: 640px) {
  .student-dashboard-welcome,
  .student-dashboard-identity,
  .student-review-card-head,
  .student-review-question-toolbar {
    align-items: flex-start;
    min-width: 0;
  }

  .student-dashboard-controls,
  .student-review-header-actions,
  .student-review-question-actions {
    width: 100%;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
  }

  .student-review-long-copy,
  .student-dashboard-user-name {
    overflow-wrap: anywhere;
    word-break: keep-all;
  }
}
```

Keep status/error recovery blocks before empty-state content and keep the primary next action before secondary history/support links.

- [ ] **Step 4: 학생 단위·WebKit 검사를 실행한다**

Run: `npm test -- --run src/lib/studentDashboardLoadState.test.ts src/lib/uiSurface.test.ts`

Run: `PLAYWRIGHT_ENABLE_WEBKIT=1 npx playwright test e2e/ios-mobile-layout.spec.ts --project=ios-se-webkit --project=ios-standard-webkit --grep student`

Expected: PASS at 320px and 393px with no horizontal overflow.

- [ ] **Step 5: 학생 모바일 흐름을 커밋한다**

```bash
git add src/app/student/dashboard/page.tsx src/app/student/history/page.tsx src/app/student/review/[attemptId]/page.tsx src/app/globals.css e2e/ios-mobile-layout.spec.ts
git commit -m "feat: refine iPhone student task flow"
```

### Task 4: 교사 데이터 화면의 카드와 행동 배치를 통일한다

**Files:**
- Modify: `src/app/teacher/dashboard/page.tsx`
- Modify: `src/app/teacher/users/page.tsx`
- Modify: `src/app/teacher/exam/[id]/page.tsx`
- Modify: `src/app/teacher/live/page.tsx`
- Modify: `src/app/globals.css`
- Modify: `e2e/ios-mobile-layout.spec.ts`

- [ ] **Step 1: 교사 경로 모바일 회귀검사를 추가한다**

```ts
test("teacher data pages use cards without viewport overflow", async ({ page }) => {
  await page.goto("/");
  await page.getByText("교사").first().click();
  await page.getByLabel(/아이디|이메일/).fill("admin");
  await page.getByLabel("비밀번호").fill("admin123");
  await page.getByRole("button", { name: "대시보드 입장" }).click();

  for (const path of ["/teacher/dashboard", "/teacher/users", "/teacher/live"]) {
    await page.goto(path);
    await expectViewportContained(page);
  }
  await expect(page.locator('[data-testid="teacher-users-mobile-card"]').first()).toBeVisible();
});
```

- [ ] **Step 2: iPhone SE에서 RED를 확인한다**

Run: `PLAYWRIGHT_ENABLE_WEBKIT=1 npx playwright test e2e/ios-mobile-layout.spec.ts --project=ios-se-webkit --grep teacher`

Expected: any remaining width, action-row, or selector issue fails visibly.

- [ ] **Step 3: 교사 화면의 모바일 계층을 통일한다**

Implement with existing selectors and tokens:

```css
@media (max-width: 640px) {
  .dashboard-welcome,
  .teacher-exam-context-bar,
  .teacher-users-mobile-card-head,
  .live-grid {
    min-width: 0;
  }

  .teacher-exam-context-actions,
  .teacher-users-mobile-actions,
  .dashboard-analysis-actions {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    width: 100%;
  }

  .teacher-exam-context-title,
  .teacher-users-mobile-identity h3 {
    overflow-wrap: anywhere;
    word-break: keep-all;
  }
}
```

Keep results tables desktop-only where mobile card equivalents already exist. Do not duplicate the same row in both visible surfaces.

- [ ] **Step 4: 교사 화면 회귀검사를 실행한다**

Run: `npm test -- --run src/lib/teacherLiveExamState.test.ts src/lib/teacherExamDetailSurface.test.ts src/lib/uiSurface.test.ts`

Run: `PLAYWRIGHT_ENABLE_WEBKIT=1 npx playwright test e2e/ios-mobile-layout.spec.ts --project=ios-se-webkit --project=ios-standard-webkit --grep teacher`

Expected: PASS, mobile cards visible, desktop tables hidden at iPhone widths, no horizontal overflow.

- [ ] **Step 5: 교사 모바일 배치를 커밋한다**

```bash
git add src/app/teacher/dashboard/page.tsx src/app/teacher/users/page.tsx src/app/teacher/exam/[id]/page.tsx src/app/teacher/live/page.tsx src/app/globals.css e2e/ios-mobile-layout.spec.ts
git commit -m "feat: align iPhone teacher data layouts"
```

### Task 5: 출제·풀이·오버레이를 safe area와 키보드에 맞춘다

**Files:**
- Modify: `src/app/create/page.tsx`
- Modify: `src/app/solve/[id]/page.tsx`
- Modify carefully: `src/components/DistributeModal.tsx`
- Modify carefully: `src/components/PDFViewer.tsx`
- Modify: `src/app/globals.css`
- Modify: `e2e/ios-mobile-layout.spec.ts`

- [ ] **Step 1: 고정 CTA와 오버레이 실패 검사를 추가한다**

```ts
test("mobile completion actions stay inside the visual viewport", async ({ page }) => {
  await page.goto("/create");
  const actions = page.locator(".create-primary-actions--mobile");
  await expect(actions).toBeVisible();
  const box = await actions.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);
});
```

Add a modal assertion that the dialog height is no larger than the viewport and has an internal scroll region.

- [ ] **Step 2: 좁은 화면 baseline 실패를 확인한다**

Run: `PLAYWRIGHT_ENABLE_WEBKIT=1 npx playwright test e2e/ios-mobile-layout.spec.ts --project=ios-se-webkit --grep "completion|overlay"`

Expected: any remaining fixed-action or dialog overflow fails.

- [ ] **Step 3: safe-area와 키보드 규칙을 적용한다**

Merge, do not overwrite, existing changes in `DistributeModal.tsx` and `PDFViewer.tsx`. Use:

```css
@media (max-width: 640px) {
  .create-primary-actions--mobile {
    left: max(var(--mobile-inline-space), env(safe-area-inset-left));
    right: max(var(--mobile-inline-space), env(safe-area-inset-right));
    bottom: max(0.75rem, env(safe-area-inset-bottom), var(--app-keyboard-inset-bottom));
  }

  html[data-app-keyboard="open"] .create-primary-actions--mobile {
    position: static;
    margin: 1rem var(--mobile-inline-space);
  }

  .balanced-dialog-panel {
    max-height: calc(var(--app-viewport-height, 100dvh) - 1rem);
    overflow-y: auto;
    overscroll-behavior: contain;
  }
}
```

Keep problem/answer panel tabs reachable at 320px and preserve the existing PDF 44px target contract.

- [ ] **Step 4: 출제·풀이 관련 회귀를 실행한다**

Run: `npm test -- --run src/lib/createSaveHierarchySurface.test.ts src/lib/pdfTouchTargetsSurface.test.ts src/lib/design93Surface.test.ts`

Run: `PLAYWRIGHT_ENABLE_WEBKIT=1 npx playwright test e2e/ios-mobile-layout.spec.ts --project=ios-se-webkit --project=ios-standard-webkit --grep "completion|overlay|solve"`

Expected: PASS with no fixed-action or dialog clipping.

- [ ] **Step 5: 출제·풀이 모바일 안전영역을 커밋한다**

```bash
git add src/app/create/page.tsx src/app/solve/[id]/page.tsx src/components/DistributeModal.tsx src/components/PDFViewer.tsx src/app/globals.css e2e/ios-mobile-layout.spec.ts
git commit -m "feat: make iPhone exam actions keyboard safe"
```

### Task 6: Xcode Simulator 실제 점검과 최종 검증

**Files:**
- Create: `docs/quality/ios-simulator-mobile-ui-2026-08-05.md`
- Create: `docs/quality/ios-simulator-mobile-ui-2026-08-05/*.png`
- Modify: `e2e/ios-mobile-layout.spec.ts` only if a real-device regression needs a reproducible assertion

- [ ] **Step 1: Xcode와 Simulator 사용 가능 상태를 확인한다**

Run: `xcodebuild -version && xcrun simctl list devices available`

Expected: Xcode version prints and at least one available iPhone simulator is listed. If unavailable, stop and report the exact missing runtime; do not claim Simulator verification.

- [ ] **Step 2: 프로덕션 서버를 실행한다**

Run: `npm run build && TEACHER_SESSION_SECRET=local-ios-audit-secret npm start -- -p 3003`

Expected: production build succeeds and the server listens on port 3003.

- [ ] **Step 3: Simulator Safari에서 세 기기 폭을 직접 점검한다**

Use the `build-ios-apps:ios-simulator-browser` skill. Check iPhone SE, a 393px-class iPhone, and a Max-class iPhone where installed. Inspect portrait first, then landscape and software-keyboard states for login/create. Capture the same priority routes and state before and after each correction.

- [ ] **Step 4: 자동 회귀 전체를 실행한다**

Run: `npm test -- --reporter=dot`

Expected: all Vitest files pass.

Run: `npx eslint src e2e && npx tsc --noEmit && npm run build`

Expected: ESLint, TypeScript, and production build all pass.

Run: `PLAYWRIGHT_ENABLE_WEBKIT=1 npx playwright test e2e/ios-mobile-layout.spec.ts --project=ios-se-webkit --project=ios-standard-webkit --project=ios-max-webkit`

Expected: all iPhone WebKit layout tests pass.

- [ ] **Step 5: 검증 문서를 작성한다**

Use this exact structure in `docs/quality/ios-simulator-mobile-ui-2026-08-05.md`:

```md
# iPhone Simulator 모바일 UI 검증 — 2026-08-05

## 환경
- Xcode: `xcodebuild -version`에서 확인한 실제 버전
- Simulator devices: `simctl`에서 확인한 실제 기기명과 iOS 버전
- Build: production

## 결과
| 경로 | 320px | 393px | 430px | 키보드/safe area | 판정 |
| --- | --- | --- | --- | --- | --- |

## 변경 전후
경로별 전후 이미지 링크와 눈에 보이는 차이를 한 문단씩 기록한다.

## 남은 위험
확인된 잔여 위험만 기록하고 남지 않았으면 `없음`으로 기록한다.
```

- [ ] **Step 6: 최종 diff와 사용자 파일 보존을 확인한다**

Run: `git diff --check && git status --short`

Expected: no whitespace errors. Existing unrelated modifications and `.gitattributes 2`, `supabase/.gitignore 2` remain unstaged unless the user separately authorizes them.

- [ ] **Step 7: 검증 자료를 커밋한다**

```bash
git add docs/quality/ios-simulator-mobile-ui-2026-08-05.md docs/quality/ios-simulator-mobile-ui-2026-08-05 e2e/ios-mobile-layout.spec.ts
git commit -m "docs: verify iPhone Simulator mobile UI"
```

## 완료 조건

- iPhone SE/표준/Max WebKit 프로젝트가 모두 통과한다.
- 실제 Xcode Simulator Safari에서 설치된 최소 두 기기 크기를 직접 확인한다.
- 320–430px에서 핵심 경로의 의도하지 않은 가로 overflow가 없다.
- 키보드·safe area·모달·고정 CTA가 콘텐츠나 홈 인디케이터와 겹치지 않는다.
- 기존 단위 테스트, ESLint, TypeScript, 프로덕션 빌드가 통과한다.
- 현재 작업 트리의 사용자 변경이 보존되고 작업 커밋에는 의도한 파일만 포함된다.
