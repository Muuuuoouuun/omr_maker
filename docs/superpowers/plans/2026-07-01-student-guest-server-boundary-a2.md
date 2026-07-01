# 학생/게스트 서버 신뢰경계 — 슬라이스 A / Phase A2 (클라 배선) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. **UI 태스크(3–6)는 단위테스트 대신 실행 앱 preview 검증**(preview_* 도구)이 검증 수단이다 — 서버 액션+쿠키+IndexedDB가 얽혀 있어 브라우저에서 확인해야 한다.

**Goal:** A1 서버 액션(`studentSession`/`studentExam`)을 클라 UI(로그인·solve·대시보드·리뷰)에 배선해, 학생/게스트가 실제로 서버 경계를 통해 시험을 로드(정답 없음)·제출(서버 채점)·조회(본인만)하도록 만든다. Supabase 미설정(dev)이면 기존 localStorage 경로로 degrade.

**Architecture:** 얇은 클라 래퍼 `studentExamClient`가 서버 액션을 호출하고 `degraded_local` 시 기존 로컬 경로로 폴백한다. 페이지들은 이 래퍼만 부른다. solve 페이지는 `examData`를 정답 없는 `SolvableExam`로 다루고, 클라 접근판정(`evaluateExamAccess`)을 **서버가 돌려준 상태**로 대체한다. 게스트는 로그인(랜딩) 또는 직접 링크 진입 시 `issueGuestSession`으로 서버 쿠키를 확보한다.

**Tech Stack:** Next.js App Router server actions, React client components, vitest(래퍼 단위), preview 도구(UI 검증).

**Spec:** [`docs/.../2026-07-01-student-guest-server-boundary-design.md`](../specs/2026-07-01-student-guest-server-boundary-design.md) · **선행:** A1 완료(`studentExam.ts`/`studentSession.ts` 존재).

---

## File Structure

| 파일 | 책임 | 상태 |
|---|---|---|
| `src/lib/studentExamClient.ts` | 서버 액션 래퍼 + `degraded_local` 로컬 폴백 (load/submit/list/loadAttempt) | Create |
| `src/lib/studentExamClient.test.ts` | 래퍼 단위 테스트(서버 성공 / degraded 폴백 / 상태 전달) | Create |
| `src/app/page.tsx` | 로그인 핸들러가 `issueGuestSession`/`issueStudentSession` 호출 + 학생 임시신원 고지 | Modify |
| `src/app/solve/[id]/page.tsx` | 로드·PIN·제출을 래퍼로; `examData`=SolvableExam; 접근판정 서버상태화; 게스트 세션 확보 | Modify |
| `src/app/student/dashboard/page.tsx` | `listMyAssignments`로 목록(게스트는 시작한 것만) | Modify |
| `src/app/student/review/[attemptId]/page.tsx` | `loadMyAttempt`로 본인 제출 로드 | Modify |
| `e2e/full-journey.spec.ts` | 학생 여정 서버경로 + 정답 미노출·본인격리 어서션 | Modify |

**의존 순서:** 1(래퍼) → 2(로그인) → 3(solve 로드/PIN) → 4(solve 제출) → 5(대시보드) → 6(리뷰) → 7(e2e). 3–4는 같은 파일이라 순차 필수.

---

## Task 1: `studentExamClient` — 서버 액션 래퍼 + degraded 폴백

**Files:** Create `src/lib/studentExamClient.ts`, `src/lib/studentExamClient.test.ts`

래퍼는 서버 액션을 호출하고, `status==='degraded_local'`이면 주입된 로컬 폴백 함수를 쓴다. 폴백 함수는 파라미터로 주입(테스트 가능) — 실제 페이지는 기존 `loadPersistedExam`/`saveAttempt` 등을 주입한다.

- [ ] **Step 1: 실패 테스트**

```ts
// src/lib/studentExamClient.test.ts
import { describe, expect, it, vi } from "vitest";
import { loadExamForSolvingClient, submitAttemptClient } from "./studentExamClient";

describe("studentExamClient", () => {
    it("returns server exam when server is available", async () => {
        const server = vi.fn().mockResolvedValue({ status: "ok", exam: { id: "e1", questions: [] } });
        const fallback = vi.fn();
        const res = await loadExamForSolvingClient("e1", undefined, { server, localFallback: fallback });
        expect(res).toEqual({ status: "ok", exam: { id: "e1", questions: [] } });
        expect(fallback).not.toHaveBeenCalled();
    });

    it("falls back to local when server is degraded_local", async () => {
        const server = vi.fn().mockResolvedValue({ status: "degraded_local" });
        const fallback = vi.fn().mockResolvedValue({ id: "e1", questions: [{ id: 1, number: 1, answer: 3 }] });
        const res = await loadExamForSolvingClient("e1", undefined, { server, localFallback: fallback });
        expect(res.status).toBe("ok");
        expect(res.exam).toMatchObject({ id: "e1" });
        expect(fallback).toHaveBeenCalledWith("e1");
    });

    it("passes server submit result through, falls back on degraded", async () => {
        const okServer = vi.fn().mockResolvedValue({ status: "ok", attempt: { id: "a1" } });
        expect(await submitAttemptClient({ examId: "e1", answers: {}, startedAt: "x" }, undefined, { server: okServer, localFallback: vi.fn() }))
            .toEqual({ status: "ok", attempt: { id: "a1" } });

        const degServer = vi.fn().mockResolvedValue({ status: "degraded_local" });
        const localSubmit = vi.fn().mockResolvedValue({ id: "local-1" });
        const res = await submitAttemptClient({ examId: "e1", answers: {}, startedAt: "x" }, undefined, { server: degServer, localFallback: localSubmit });
        expect(res).toEqual({ status: "ok", attempt: { id: "local-1" } });
    });
});
```

- [ ] **Step 2: 실패 확인** — `npx vitest run src/lib/studentExamClient.test.ts` → module not found.

- [ ] **Step 3: 구현**

```ts
// src/lib/studentExamClient.ts
import type { Attempt, Exam } from "@/types/omr";
import type { SolvableExam } from "@/lib/examSolvePayload";
import type { SubmitAttemptInput } from "@/lib/studentExamCore";

type LoadStatus = "ok" | "unauthenticated" | "pin_required" | "login_required" | "group_denied" | "not_started" | "ended" | "archived" | "error";
type SubmitStatus = "ok" | "unauthenticated" | "denied" | "pin_required" | "login_required" | "group_denied" | "not_started" | "ended" | "archived" | "error";

export interface LoadClientResult { status: LoadStatus; exam?: SolvableExam | Exam; }
export interface SubmitClientResult { status: SubmitStatus; attempt?: Attempt; }

export async function loadExamForSolvingClient(
    examId: string,
    pin: string | undefined,
    deps: {
        server: (examId: string, pin?: string) => Promise<{ status: string; exam?: SolvableExam }>;
        localFallback: (examId: string) => Promise<Exam | null>;
    },
): Promise<LoadClientResult> {
    const res = await deps.server(examId, pin);
    if (res.status === "degraded_local") {
        const local = await deps.localFallback(examId);
        return local ? { status: "ok", exam: local } : { status: "ended" };
    }
    return { status: res.status as LoadStatus, exam: res.exam };
}

export async function submitAttemptClient(
    input: SubmitAttemptInput,
    pin: string | undefined,
    deps: {
        server: (input: SubmitAttemptInput, pin?: string) => Promise<{ status: string; attempt?: Attempt }>;
        localFallback: (input: SubmitAttemptInput) => Promise<Attempt | null>;
    },
): Promise<SubmitClientResult> {
    const res = await deps.server(input, pin);
    if (res.status === "degraded_local") {
        const local = await deps.localFallback(input);
        return local ? { status: "ok", attempt: local } : { status: "error" };
    }
    return { status: res.status as SubmitStatus, attempt: res.attempt };
}
```

- [ ] **Step 4: 통과 + tsc** — `npx vitest run src/lib/studentExamClient.test.ts` PASS(3); `npx tsc --noEmit` clean.

- [ ] **Step 5: 커밋** — `git add src/lib/studentExamClient.ts src/lib/studentExamClient.test.ts && git commit -m "feat(client): studentExamClient wrapper with degraded_local fallback"`

> `listMyAssignmentsClient` / `loadMyAttemptClient`도 동일 패턴으로 이 파일에 추가한다(각각 서버 성공/`degraded_local`→로컬 `loadAttempts`/`loadAttempt` 폴백). 테스트도 같은 형태로 2개 추가. (지면상 load/submit만 전개 — list/loadAttempt는 동일 구조로 반복, `상태 통과 / degraded→로컬` 2가지를 각각 단언.)

---

## Task 2: 로그인 배선 (page.tsx) + 학생 임시신원 고지

**Files:** Modify `src/app/page.tsx`

**앵커:** `handleGuest`([355–369](../../../src/app/page.tsx:355)), `handleStudentLogin`([238–353](../../../src/app/page.tsx:238)).

- [ ] **Step 1: 게스트 로그인에 서버 세션 발급** — `handleGuest`에서 `getOrCreateGuestId()` 대신 서버 발급 우선:

```ts
  const handleGuest = async () => {
    const result = await issueGuestSession();
    const guestId = result.ok && result.guestId ? result.guestId : getOrCreateGuestId();
    const session: StudentSession = {
      studentId: `guest:${guestId}`, name: "Guest Student",
      isGuest: true, identityType: "guest", guestId, groupName: "Guest Mode",
    };
    saveSession(session);
    localStorage.setItem("omr_guest_id", guestId);
    const next = normalizeStudentRedirectPath(new URLSearchParams(window.location.search).get("next"));
    router.push(next);
  };
```
import: `import { issueGuestSession } from "@/app/actions/studentSession";`

- [ ] **Step 2: 학생 로그인에 서버 세션 발급** — `handleStudentLogin`에서 `saveSession(session)` **직전에**:
```ts
    await issueStudentSession({
      studentId: identity.studentId, name: trimmedName,
      groupId: selectedGroupId, groupName: identity.groupName,
      ...regionSnapshot,
    });
```
import: `issueStudentSession`. (핸들러를 `async`로. onClick은 `void handleStudentLogin()`.)

- [ ] **Step 3: 학생 폼 임시신원 고지** — 학생 폼(로그인 버튼 근처)에 안내 문구 추가(spec §4 완화 조치):
```tsx
    <p style={{ fontSize: "0.72rem", color: "var(--muted)", marginTop: "0.5rem", lineHeight: 1.45 }}>
      * 현재는 이름·반 기반 임시 신원입니다. 정식 학생 인증은 준비 중입니다.
    </p>
```

- [ ] **Step 4: preview 검증** — 앱 실행 후 게스트/학생 로그인 → 네트워크에 `issueGuestSession`/`issueStudentSession` POST + `Set-Cookie: omr_student_server_session` 확인(preview_network). 콘솔 에러 없음.

- [ ] **Step 5: 커밋** — `git add src/app/page.tsx && git commit -m "feat(client): mint server student/guest session on login + temp-identity notice"`

---

## Task 3: solve 페이지 — 로드 · PIN · 접근판정 서버화

**Files:** Modify `src/app/solve/[id]/page.tsx`

**핵심 타입/제어 변경(delicate):**
- `examData` 상태 타입을 `Exam | null` → `SolvableExam | Exam | null`(정답 없는 서버 payload 수용). solve UI는 `question.answer`를 안 쓰므로 렌더 무영향.
- 클라 `evaluateExamAccess(examData, {session, pinVerified})` 게이트(라인 [682](../../../src/app/solve/[id]/page.tsx:682),[756](../../../src/app/solve/[id]/page.tsx:756),[983](../../../src/app/solve/[id]/page.tsx:983),[1008](../../../src/app/solve/[id]/page.tsx:1008),[1121](../../../src/app/solve/[id]/page.tsx:1121),[1345](../../../src/app/solve/[id]/page.tsx:1345))를 **서버가 준 상태**로 대체. 새 상태 `const [solveStatus, setSolveStatus] = useState<"loading" | "ok" | "pin_required" | "login_required" | "group_denied" | "not_started" | "ended" | "archived" | "error">("loading")`; "ok"이면 풀이 가능, "pin_required"면 PIN 다이얼로그, 그 외는 차단 UI. `pinVerified`/`verifyExamPin`(클라) 제거.

- [ ] **Step 1: 로드 effect 교체** — `hydrateExam`([834–868 등](../../../src/app/solve/[id]/page.tsx:834))의 `loadPersistedExam(id)`를 래퍼로:
```ts
    const res = await loadExamForSolvingClient(id, undefined, {
      server: (examId, pin) => loadExamForSolving(examId, pin),
      localFallback: (examId) => loadPersistedExam(examId),
    });
    if (res.status === "ok" && res.exam) {
      setExamData(res.exam as Exam);
      examQuestionsRef.current = res.exam.questions as Question[];
      setSolveStatus("ok");
      // (retake 파싱 등 기존 로직 유지)
    } else if (res.status === "pin_required") {
      setSolveStatus("pin_required");
    } else if (res.status === "ended" || res.status === "not_started" || res.status === "archived" || res.status === "group_denied" || res.status === "login_required") {
      setSolveStatus(res.status);
    } else {
      setLoadError({ title: "시험을 불러올 수 없습니다", body: "잠시 후 다시 시도해주세요." });
    }
```
imports: `import { loadExamForSolving } from "@/app/actions/studentExam"; import { loadExamForSolvingClient } from "@/lib/studentExamClient";`

- [ ] **Step 2: PIN 다이얼로그 서버화** — `submitPin`([1347](../../../src/app/solve/[id]/page.tsx:1347))을 서버 재검증으로:
```ts
    const submitPin = async () => {
      const res = await loadExamForSolvingClient(id, pinInput, {
        server: (examId, pin) => loadExamForSolving(examId, pin),
        localFallback: (examId) => loadPersistedExam(examId),
      });
      if (res.status === "ok" && res.exam) {
        setExamData(res.exam as Exam); setSolveStatus("ok"); setPinError("");
        const firstId = retakeConfig?.questionIds[0] || (res.exam.questions[0] as Question)?.id;
        if (firstId) beginQuestionVisit(firstId);
      } else { setPinError("PIN이 일치하지 않습니다."); }
    };
```
PIN 값 `pinInput`을 제출 시 쓰도록 상위 스코프 ref에 보관(`pinRef.current = pinInput`)해 Task 4의 submit에서 사용.

- [ ] **Step 3: 게이트 렌더 교체** — 라인 [1345–1401](../../../src/app/solve/[id]/page.tsx:1345)의 `accessDecision`/`requiresPin` 블록을 `solveStatus` 분기로 교체: `solveStatus==="pin_required"`→`ExamPinDialog`; `["ended","not_started","archived","group_denied","login_required"].includes(solveStatus)`→`ExamAccessBlockedDialog`(기존 `decision` 대신 `{ status: solveStatus }` 전달하도록 그 컴포넌트 시그니처 확인/조정); `"ok"`이 아니면 풀이 UI 미표시.

- [ ] **Step 4: 중간 가드 교체** — [682/756/983/1008/1121](../../../src/app/solve/[id]/page.tsx:682)의 `evaluateExamAccess(...).status !== "allowed"`를 `solveStatus !== "ok"`로 교체. `pinVerified` 의존성 배열 항목 제거, `solveStatus`로 대체.

- [ ] **Step 5: preview 검증** — (a) PIN 없는 공개 시험 링크 → 바로 풀이, 네트워크 payload에 어떤 `answer`/`explanation`/`pin`도 없음(preview_network로 `loadExamForSolving` 응답 확인). (b) PIN 시험 → PIN 다이얼로그 → 틀린 PIN 거부 / 맞는 PIN 통과. (c) 콘솔 에러 없음.

- [ ] **Step 6: 커밋** — `git add src/app/solve/[id]/page.tsx && git commit -m "feat(solve): server-driven exam load + PIN gate (no answers on client)"`

---

## Task 4: solve 페이지 — 서버 제출 + 게스트 세션 확보

**Files:** Modify `src/app/solve/[id]/page.tsx`

**앵커:** `handleSubmitInternal`([1116–1257](../../../src/app/solve/[id]/page.tsx:1116)).

- [ ] **Step 1: 게스트 세션 확보 + 서버 제출로 교체** — 클라 `gradeAttempt`([1147](../../../src/app/solve/[id]/page.tsx:1147))·`buildQuestionResults`·`saveAttempt`([1231](../../../src/app/solve/[id]/page.tsx:1231)) 제거. 드로잉 IndexedDB 아카이브(기존 `drawingsRef` 로직)는 유지하고, 그 후 서버 제출:
```ts
    // 게스트가 서버 쿠키 없이 직접 링크로 들어온 경우 보장
    if (user?.isGuest || !user) { await issueGuestSession(user?.name); }
    const input: SubmitAttemptInput = {
      examId: id, answers: studentAnswers, startedAt,
      autoSubmitted, tabFociLostCount,
      questionTimings: buildQuestionTimingSnapshot(activeExamQuestions),
      focusLossEvents: focusLossEventsRef.current,
      drawingsRef, drawingPageCount: activeDrawingPageCount, drawingStrokeCount: activeDrawingStrokeCount,
    };
    const res = await submitAttemptClient(input, pinRef.current || undefined, {
      server: (i, pin) => submitAttempt(i, pin),
      localFallback: (i) => saveLocalGradedAttempt(i),   // 아래 폴백
    });
    if (res.status !== "ok" || !res.attempt) {
      submittedRef.current = false;
      toast.error("제출 실패", res.status === "pin_required" ? "PIN을 다시 확인해주세요." : "잠시 후 다시 시도해주세요.");
      return;
    }
    try { localStorage.removeItem(DRAFT_KEY); localStorage.removeItem(LEGACY_DRAFT_KEY); } catch {}
    router.push(`/student/review/${res.attempt.id}`);
```
imports: `import { submitAttempt } from "@/app/actions/studentExam"; import { submitAttemptClient } from "@/lib/studentExamClient"; import { issueGuestSession } from "@/app/actions/studentSession";`

- [ ] **Step 2: degraded 로컬 폴백 함수** — dev(Supabase 미설정)에서만 쓰는 `saveLocalGradedAttempt(input)`를 파일 내 헬퍼로 정의: 기존 클라 로직(`gradeAttempt`+`buildQuestionResults`+`saveAttempt`)을 그대로 재사용해 `Attempt` 반환. (프로덕션에선 서버가 `ok`를 반환하므로 호출 안 됨.)

- [ ] **Step 3: 게스트 이름 흐름 정리** — `GuestNameDialog`/`guestSubmitPending`/`createGuestSubmitter`는 서버 세션 발급으로 대체되므로 제거 또는 "이름만 받아 `issueGuestSession(name)` 재발급 후 제출"로 축소. (기존 자동제출 경로가 이름 없이도 제출되도록 — 게스트 세션이 이미 있음.)

- [ ] **Step 4: preview 검증(가장 중요)** — (a) 공개 시험 풀고 제출 → `submitAttempt` POST, 응답 `status:"ok"` + attempt; 리뷰 페이지로 이동. (b) **타이머 자동제출** 경로도 제출 성공(PIN 시험이면 `pinRef` 전달 확인 — I-1). (c) 제출 점수가 서버 계산값인지(리뷰에서 확인). (d) 콘솔/네트워크 에러 없음.

- [ ] **Step 5: 커밋** — `git add src/app/solve/[id]/page.tsx && git commit -m "feat(solve): server-graded submit via submitAttempt (+ guest session ensure, PIN threading)"`

---

## Task 5: 대시보드 — listMyAssignments

**Files:** Modify `src/app/student/dashboard/page.tsx`

- [ ] **Step 1: 목록 소스 교체** — [`loadAttempts`(66)](../../../src/app/student/dashboard/page.tsx:66)를 `listMyAssignments` 결과로. 게스트는 "시작한(제출/draft) 시험만" 노출(spec §7a) — `listMyAssignments`가 본인 attempt 있는 것만 주므로, todo/done 분류를 그 attempts 기준으로 구성. `degraded_local`이면 기존 `loadAttempts` 폴백. `loadExams`(전체 공개시험)는 게스트에겐 사용 안 함(narrowing).
- [ ] **Step 2: preview 검증** — 게스트로 시험 하나 풀고 대시보드 → 그 시험만 보임(다른 공개시험 안 뜸). 학생은 기존대로.
- [ ] **Step 3: 커밋** — `git add src/app/student/dashboard/page.tsx && git commit -m "feat(dashboard): server listMyAssignments + guest list narrowing"`

---

## Task 6: 리뷰 페이지 — loadMyAttempt

**Files:** Modify `src/app/student/review/[attemptId]/page.tsx`

- [ ] **Step 1: 로드 교체** — 리뷰 페이지의 로컬 attempt 로드를 `loadMyAttempt(attemptId)`(본인 소유 확인)로. `degraded_local`이면 기존 로컬 `loadAttempt` 폴백. `denied`면 "본인 제출이 아니거나 없음" 안내.
- [ ] **Step 2: preview 검증** — 제출 직후 리뷰 표시(서버 attempt), 정답·해설이 이제 여기서 보임(제출 후이므로 OK). 타 attemptId 접근 시 denied.
- [ ] **Step 3: 커밋** — `git add src/app/student/review/[attemptId]/page.tsx && git commit -m "feat(review): server loadMyAttempt with ownership check"`

---

## Task 7: e2e 갱신

**Files:** Modify `e2e/full-journey.spec.ts`

- [ ] **Step 1: 학생 여정 서버경로** — 로그인→풀이→제출→리뷰 흐름을 갱신. 어서션 추가: `loadExamForSolving` 응답에 정답 필드 부재; 게스트 A의 대시보드에 게스트 B 제출 미노출(본인격리).
- [ ] **Step 2: 실행** — `npm run test:e2e` (또는 해당 spec) 통과.
- [ ] **Step 3: 커밋** — `git add e2e/full-journey.spec.ts && git commit -m "test(e2e): student server-path journey + answer-hidden/isolation assertions"`

---

## Self-Check (구현 후)

- [ ] 공개(PIN無) 시험: 게스트 링크→풀이→제출→리뷰 end-to-end, 네트워크에 정답 부재.
- [ ] 공개+PIN 시험: PIN 게이트→통과→제출(자동제출 포함, PIN 스레딩) 성공.
- [ ] 게스트 대시보드: 시작한 시험만.
- [ ] dev(Supabase 미설정): 모든 경로 degraded 로컬 폴백 동작.
- [ ] `npx tsc --noEmit` + `npx vitest run` 그린.

## 비목표(이월)
- 서버 명단/코드 검증(학생 사칭) → B. 교사 read/write 서버 이관 → B. `production-rls` 적용·anon revoke → C. 게스트 retake 서버경로 → B(spec 노트). 플랜/AI 사용량 서버강제 → D.

---

## Execution Handoff

Phase A2는 **UI 통합 리팩터**라 blind 단위테스트로는 부족하다 — solve/대시보드/리뷰 태스크는 **실행 앱 preview 검증**이 핵심. 실행 방식:
1. **Inline + preview (권장)** — executing-plans로 이 세션에서 태스크별 구현 후 preview 도구로 즉시 검증(네트워크에 정답 부재·PIN·격리 확인). UI 회귀를 눈으로 잡는다.
2. **Subagent-Driven** — 래퍼(Task 1)·로그인(Task 2) 등 로직 태스크엔 적합하나, solve 대재배선은 preview 없는 blind 편집이라 리스크. 하이브리드(로직=서브에이전트, solve=inline preview) 권장.
