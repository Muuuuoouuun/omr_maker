# 학생/게스트 서버 신뢰 경계 — 슬라이스 A / Phase A1 (서버 기반) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 학생/게스트의 정답조회·채점·제출·본인조회를 service-role 서버 경계로 옮기기 위한 **서버 기반 모듈**(서명 신원 쿠키, 정답 스트립, 서버 채점 코어, 서버 읽기)을 TDD로 구축한다. 클라 배선은 Phase A2.

**Architecture:** 순수/서버 전용 모듈을 먼저 만든다 — (1) `studentServerSession`(HMAC 서명 HttpOnly 쿠키, `teacherServerSession` 미러), (2) `examSolvePayload`(정답·PIN·정답PDF 제거 순수함수), (3) `supabaseServerAdmin` 읽기 확장(service-role select), (4) `studentExamCore`(서버 채점·소유권·목록가시성 순수함수), (5) `studentSession`/`studentExam` 서버 액션(위 조각 조립). 보안 임계 필드(score·questionResults·organizationId·소유자)는 **서버가 쿠키/시험에서 주입**하고 클라 값은 신뢰하지 않는다.

**Tech Stack:** Next.js App Router server actions(`"use server"`), `@supabase/supabase-js` service-role, `node:crypto`(HMAC), vitest.

**Spec:** [`docs/superpowers/specs/2026-07-01-student-guest-server-boundary-design.md`](../specs/2026-07-01-student-guest-server-boundary-design.md)

---

## File Structure

| 파일 | 책임 | 상태 |
|---|---|---|
| `src/lib/studentServerSession.ts` | 학생/게스트 서명 세션 쿠키 mint/parse | Create |
| `src/lib/studentServerSession.test.ts` | 위 단위 테스트 | Create |
| `src/lib/examSolvePayload.ts` | `stripExamForSolving` — 정답/PIN/정답PDF 제거 | Create |
| `src/lib/examSolvePayload.test.ts` | 위 단위 테스트 | Create |
| `src/lib/supabaseServerAdmin.ts` | service-role **읽기** 헬퍼 추가(`fetchExamRowById`, `fetchAttemptRowsByOwner`) | Modify |
| `src/lib/supabaseServerAdmin.test.ts` | 읽기 헬퍼 테스트 추가 | Modify |
| `src/lib/studentExamCore.ts` | 서버 채점(`buildServerAttempt`)·소유권(`attemptOwnedBy`)·목록가시성(`assignmentVisibleTo`) 순수함수 | Create |
| `src/lib/studentExamCore.test.ts` | 위 단위 테스트 | Create |
| `src/app/actions/studentSession.ts` | `issueGuestSession`/`issueStudentSession` 서버 액션 | Create |
| `src/app/actions/studentExam.ts` | `loadExamForSolving`/`submitAttempt`/`listMyAssignments`/`loadMyAttempt` 서버 액션 | Create |

`examFromSupabaseRow`/`attemptFromSupabaseRow`(순수, [`omrPersistence.ts`](../../../src/lib/omrPersistence.ts))와 `gradeAttempt`/`buildQuestionResults`/`evaluateExamAccess`는 서버에서 재사용한다(로직 중복 없음).

---

## Task 1: `studentServerSession` — 서명 세션 쿠키

**Files:**
- Create: `src/lib/studentServerSession.ts`
- Test: `src/lib/studentServerSession.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

```ts
// src/lib/studentServerSession.test.ts
import { describe, expect, it } from "vitest";
import {
    createSignedStudentSessionCookie,
    parseSignedStudentSessionCookie,
    resolveStudentSessionSecret,
    type StudentIdentityInput,
} from "./studentServerSession";

const GUEST: StudentIdentityInput = { kind: "guest", guestId: "g-123", name: "Guest Student", identityType: "guest" };
const STUDENT: StudentIdentityInput = {
    kind: "student", studentId: "grp1::김철수", name: "김철수",
    groupId: "grp1", groupName: "1반", identityType: "temporary",
};
const ENV = { STUDENT_SESSION_SECRET: "test-secret", NODE_ENV: "test" } as Record<string, string>;

describe("studentServerSession", () => {
    it("resolves the dedicated secret, falls back only outside production", () => {
        expect(resolveStudentSessionSecret({ STUDENT_SESSION_SECRET: " s " })).toBe("s");
        expect(resolveStudentSessionSecret({ NODE_ENV: "development" })).toBe("dev-student-session-secret");
        expect(resolveStudentSessionSecret({ NODE_ENV: "production" })).toBeNull();
    });

    it("round-trips a guest identity", () => {
        const now = 1_000_000;
        const cookie = createSignedStudentSessionCookie(GUEST, ENV, now)!;
        const parsed = parseSignedStudentSessionCookie(cookie, ENV, now + 1000);
        expect(parsed).toMatchObject({ kind: "guest", guestId: "g-123", identityType: "guest" });
    });

    it("round-trips a student identity", () => {
        const now = 1_000_000;
        const cookie = createSignedStudentSessionCookie(STUDENT, ENV, now)!;
        const parsed = parseSignedStudentSessionCookie(cookie, ENV, now + 1000);
        expect(parsed).toMatchObject({ kind: "student", studentId: "grp1::김철수", groupId: "grp1" });
    });

    it("rejects a tampered signature", () => {
        const cookie = createSignedStudentSessionCookie(GUEST, ENV, 1000)!;
        const [payload] = cookie.split(".");
        expect(parseSignedStudentSessionCookie(`${payload}.deadbeef`, ENV, 2000)).toBeNull();
    });

    it("rejects an expired session", () => {
        const now = 1_000_000;
        const cookie = createSignedStudentSessionCookie(GUEST, ENV, now)!;
        const past = now + 31 * 24 * 60 * 60 * 1000; // > 30d TTL
        expect(parseSignedStudentSessionCookie(cookie, ENV, past)).toBeNull();
    });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/lib/studentServerSession.test.ts`
Expected: FAIL — "Cannot find module './studentServerSession'".

- [ ] **Step 3: 구현 작성**

```ts
// src/lib/studentServerSession.ts
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IdentityType } from "@/types/omr";

export const STUDENT_SERVER_SESSION_COOKIE = "omr_student_server_session";
export const STUDENT_SERVER_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30d

type Env = Record<string, string | undefined>;

export interface StudentIdentityInput {
    kind: "guest" | "student";
    guestId?: string;
    studentId?: string;
    name: string;
    groupId?: string;
    groupName?: string;
    regionId?: string;
    regionName?: string;
    identityType: Extract<IdentityType, "guest" | "temporary">;
}

export interface StudentServerIdentity extends StudentIdentityInput {
    issuedAt: number;
    expiresAt: number;
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

export function resolveStudentSessionSecret(env: Env = process.env): string | null {
    const explicit = clean(env.STUDENT_SESSION_SECRET) || clean(env.OMR_STUDENT_SESSION_SECRET);
    if (explicit) return explicit;
    return env.NODE_ENV === "production" ? null : "dev-student-session-secret";
}

function base64UrlEncode(value: string): string {
    return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string): string {
    return Buffer.from(value, "base64url").toString("utf8");
}

function signPayload(payload: string, secret: string): string {
    return createHmac("sha256", secret).update(payload, "utf8").digest("base64url");
}

function signaturesMatch(actual: string, expected: string): boolean {
    const a = Buffer.from(actual, "base64url");
    const b = Buffer.from(expected, "base64url");
    return a.length === b.length && timingSafeEqual(a, b);
}

export function createStudentServerIdentity(
    input: StudentIdentityInput,
    now = Date.now(),
): StudentServerIdentity {
    return { ...input, issuedAt: now, expiresAt: now + STUDENT_SERVER_SESSION_MAX_AGE_SECONDS * 1000 };
}

export function isStudentIdentityActive(identity: StudentServerIdentity | null, now = Date.now()): boolean {
    return !!identity && Number.isFinite(identity.expiresAt) && identity.expiresAt > now;
}

export function createSignedStudentSessionCookie(
    input: StudentIdentityInput,
    env: Env = process.env,
    now = Date.now(),
): string | null {
    const secret = resolveStudentSessionSecret(env);
    if (!secret) return null;
    const identity = createStudentServerIdentity(input, now);
    const payload = base64UrlEncode(JSON.stringify(identity));
    return `${payload}.${signPayload(payload, secret)}`;
}

export function parseSignedStudentSessionCookie(
    rawCookie: string | null | undefined,
    env: Env = process.env,
    now = Date.now(),
): StudentServerIdentity | null {
    if (!rawCookie) return null;
    const secret = resolveStudentSessionSecret(env);
    if (!secret) return null;

    const [payload, signature, ...rest] = rawCookie.split(".");
    if (!payload || !signature || rest.length > 0) return null;
    if (!signaturesMatch(signature, signPayload(payload, secret))) return null;

    try {
        const parsed = JSON.parse(base64UrlDecode(payload)) as StudentServerIdentity;
        return isStudentIdentityActive(parsed, now) ? parsed : null;
    } catch {
        return null;
    }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/lib/studentServerSession.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: 커밋**

```bash
git add src/lib/studentServerSession.ts src/lib/studentServerSession.test.ts
git commit -m "feat(student-auth): signed student/guest server session cookie"
```

---

## Task 2: `stripExamForSolving` — 정답/PIN/정답PDF 제거

**Files:**
- Create: `src/lib/examSolvePayload.ts`
- Test: `src/lib/examSolvePayload.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

```ts
// src/lib/examSolvePayload.test.ts
import { describe, expect, it } from "vitest";
import { stripExamForSolving } from "./examSolvePayload";
import type { Exam } from "@/types/omr";

const EXAM: Exam = {
    id: "e1", title: "기말고사", createdAt: "2026-07-01T00:00:00.000Z",
    answerKeyPdf: "data:application/pdf;base64,AAAA",
    answerKeyPdfRef: { store: "indexeddb", key: "ans-e1" },
    accessConfig: { type: "public", pin: "1234" },
    questions: [
        { id: 1, number: 1, answer: 3, choices: 5, score: 10 },
        { id: 2, number: 2, answer: 1, choices: 4 },
    ],
};

describe("stripExamForSolving", () => {
    it("removes every question answer but keeps display fields", () => {
        const solvable = stripExamForSolving(EXAM);
        expect(solvable.questions).toHaveLength(2);
        for (const q of solvable.questions) {
            expect("answer" in q).toBe(false);
        }
        expect(solvable.questions[0]).toMatchObject({ id: 1, number: 1, choices: 5, score: 10 });
    });

    it("removes the answer key PDF and inline pin, exposing only hasPin", () => {
        const solvable = stripExamForSolving(EXAM);
        expect(solvable.answerKeyPdf).toBeUndefined();
        expect(solvable.answerKeyPdfRef).toBeUndefined();
        expect(solvable.accessConfig).toEqual({ type: "public", groupIds: undefined, hasPin: true });
        expect(JSON.stringify(solvable)).not.toContain("1234");
    });

    it("reports hasPin false when no pin is set", () => {
        const solvable = stripExamForSolving({ ...EXAM, accessConfig: { type: "group", groupIds: ["g1"] } });
        expect(solvable.accessConfig).toEqual({ type: "group", groupIds: ["g1"], hasPin: false });
    });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/lib/examSolvePayload.test.ts`
Expected: FAIL — "Cannot find module './examSolvePayload'".

- [ ] **Step 3: 구현 작성**

```ts
// src/lib/examSolvePayload.ts
import type { Exam, Question } from "@/types/omr";

export type SolvableQuestion = Omit<Question, "answer">;

export interface SolvableExam
    extends Omit<Exam, "questions" | "answerKeyPdf" | "answerKeyPdfRef" | "accessConfig"> {
    questions: SolvableQuestion[];
    accessConfig?: { type: "public" | "group"; groupIds?: string[]; hasPin: boolean };
}

/**
 * Server-side projection of an exam that is safe to ship to the solving client:
 * no correct answers, no answer-key PDF, no inline PIN (only a hasPin flag).
 */
export function stripExamForSolving(exam: Exam): SolvableExam {
    const solvableQuestions: SolvableQuestion[] = exam.questions.map(question => {
        const { answer: _omitAnswer, ...rest } = question;
        void _omitAnswer;
        return rest;
    });

    const {
        answerKeyPdf: _omitPdf,
        answerKeyPdfRef: _omitPdfRef,
        accessConfig,
        questions: _omitQuestions,
        ...rest
    } = exam;
    void _omitPdf;
    void _omitPdfRef;
    void _omitQuestions;

    return {
        ...rest,
        questions: solvableQuestions,
        accessConfig: accessConfig
            ? { type: accessConfig.type, groupIds: accessConfig.groupIds, hasPin: !!accessConfig.pin }
            : undefined,
    };
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/lib/examSolvePayload.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: 커밋**

```bash
git add src/lib/examSolvePayload.ts src/lib/examSolvePayload.test.ts
git commit -m "feat(exam): stripExamForSolving removes answers/pin/answer-key from solve payload"
```

---

## Task 3: `supabaseServerAdmin` — service-role 읽기 헬퍼

**Files:**
- Modify: `src/lib/supabaseServerAdmin.ts`
- Test: `src/lib/supabaseServerAdmin.test.ts`

- [ ] **Step 1: 실패 테스트 추가**

`src/lib/supabaseServerAdmin.test.ts` 상단 import 뒤에 아래 블록을 추가한다. (기존 `mockAdminClient`는 그대로 두고 읽기용 mock를 별도로 추가.)

```ts
// append to src/lib/supabaseServerAdmin.test.ts
import { fetchAttemptRowsByOwner, fetchExamRowById } from "./supabaseServerAdmin";

function mockReadClient(rows: Record<string, unknown[]>) {
    return {
        from(table: string) {
            const data = rows[table] || [];
            const filtered: unknown[] = [...data];
            const builder = {
                _rows: filtered,
                select() { return builder; },
                eq(column: string, value: string) {
                    builder._rows = builder._rows.filter(
                        row => (row as Record<string, unknown>)[column] === value,
                    );
                    return builder;
                },
                async maybeSingle() { return { data: builder._rows[0] ?? null, error: null }; },
                async order() { return { data: builder._rows, error: null }; },
            };
            return builder;
        },
    };
}

describe("Supabase server admin reads", () => {
    it("fetches a single exam row by id", async () => {
        const client = mockReadClient({ omr_exams: [{ id: "e1", title: "T" }, { id: "e2", title: "U" }] });
        expect(await fetchExamRowById(client, "e2")).toEqual({ id: "e2", title: "U" });
        expect(await fetchExamRowById(client, "missing")).toBeNull();
    });

    it("fetches attempt rows scoped to a guest owner", async () => {
        const client = mockReadClient({
            omr_attempts: [
                { id: "a1", student_id: "guest:g1", exam_id: "e1" },
                { id: "a2", student_id: "guest:g2", exam_id: "e1" },
            ],
        });
        const rows = await fetchAttemptRowsByOwner(client, { studentId: "guest:g1" });
        expect(rows.map(r => (r as { id: string }).id)).toEqual(["a1"]);
    });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/lib/supabaseServerAdmin.test.ts`
Expected: FAIL — `fetchExamRowById`/`fetchAttemptRowsByOwner` are not exported.

- [ ] **Step 3: 구현 추가**

`src/lib/supabaseServerAdmin.ts`의 `SupabaseAdminClientLike` 인터페이스를 확장하고 읽기 헬퍼를 추가한다.

`SupabaseAdminClientLike`를 아래로 교체:

```ts
export interface SupabaseAdminReadFilter {
    eq(column: string, value: string): SupabaseAdminReadFilter;
    maybeSingle(): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
    order(column: string, options?: { ascending?: boolean }): PromiseLike<{ data: unknown[] | null; error: { message?: string } | null }>;
}

export interface SupabaseAdminClientLike {
    from(table: string): {
        upsert(row: unknown): SupabaseMutationCall;
        insert?(row: unknown): SupabaseMutationCall;
        select?(columns?: string): { eq(column: string, value: string): SupabaseAdminReadFilter };
    };
}

export interface SupabaseAdminReadClientLike {
    from(table: string): { select(columns?: string): { eq(column: string, value: string): SupabaseAdminReadFilter } };
}
```

파일 하단(export 함수들 뒤)에 추가:

```ts
export async function fetchExamRowById(
    client: SupabaseAdminReadClientLike,
    examId: string,
): Promise<unknown | null> {
    const { data, error } = await client.from("omr_exams").select("*").eq("id", examId).maybeSingle();
    if (error) throw new Error(error.message || "Failed to read exam");
    return data ?? null;
}

export async function fetchAttemptRowsByOwner(
    client: SupabaseAdminReadClientLike,
    owner: { studentId?: string; guestId?: string },
): Promise<unknown[]> {
    // Guests are stored under the student_id = "guest:<guestId>" convention.
    const key = owner.studentId || (owner.guestId ? `guest:${owner.guestId}` : "");
    if (!key) return [];
    const { data, error } = await client.from("omr_attempts").select("*").eq("student_id", key).order("finished_at", { ascending: false });
    if (error) throw new Error(error.message || "Failed to read attempts");
    return data ?? [];
}
```

> 참고: 게스트 attempt는 `student_id = "guest:<guestId>"`로 저장된다([`page.tsx:358`](../../../src/app/page.tsx:358), `createGuestSubmitter`). Phase A2에서 서버 제출도 동일 규약으로 소유자를 주입한다(Task 5의 `buildServerAttempt`가 이를 보장).

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/lib/supabaseServerAdmin.test.ts`
Expected: PASS (기존 3 + 신규 2).

- [ ] **Step 5: 커밋**

```bash
git add src/lib/supabaseServerAdmin.ts src/lib/supabaseServerAdmin.test.ts
git commit -m "feat(server): service-role read helpers for exams and owner-scoped attempts"
```

---

## Task 4: `studentExamCore` — 서버 채점·소유권·목록가시성 (순수)

**Files:**
- Create: `src/lib/studentExamCore.ts`
- Test: `src/lib/studentExamCore.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

```ts
// src/lib/studentExamCore.test.ts
import { describe, expect, it } from "vitest";
import { attemptOwnedBy, buildServerAttempt, identityAccessSession, type SubmitAttemptInput } from "./studentExamCore";
import type { Exam } from "@/types/omr";
import type { StudentServerIdentity } from "./studentServerSession";

const EXAM: Exam = {
    id: "e1", title: "기말", createdAt: "2026-07-01T00:00:00.000Z", organizationId: "teacher_abc",
    questions: [
        { id: 1, number: 1, answer: 3, choices: 5, score: 10 },
        { id: 2, number: 2, answer: 2, choices: 5, score: 10 },
    ],
};
const GUEST: StudentServerIdentity = {
    kind: "guest", guestId: "g1", name: "Guest Student", identityType: "guest",
    issuedAt: 0, expiresAt: 9e15,
};
const INPUT: SubmitAttemptInput = { examId: "e1", answers: { 1: 3, 2: 4 }, startedAt: "2026-07-01T01:00:00.000Z" };

describe("studentExamCore", () => {
    it("server-grades and injects owner/org, ignoring any client score", () => {
        const attempt = buildServerAttempt(INPUT, EXAM, GUEST, "att1", "2026-07-01T01:30:00.000Z");
        expect(attempt.score).toBe(10);       // only q1 correct
        expect(attempt.totalScore).toBe(20);
        expect(attempt.organizationId).toBe("teacher_abc");
        expect(attempt.studentId).toBe("guest:g1");
        expect(attempt.guestId).toBe("g1");
        expect(attempt.identityType).toBe("guest");
        expect(attempt.questionResults).toHaveLength(2);
        expect(attempt.questionResults?.[0]).toMatchObject({ questionId: 1, isCorrect: true });
    });

    it("attemptOwnedBy matches guest by guestId and student by studentId", () => {
        expect(attemptOwnedBy({ studentId: "guest:g1", guestId: "g1" }, GUEST)).toBe(true);
        expect(attemptOwnedBy({ studentId: "guest:g2", guestId: "g2" }, GUEST)).toBe(false);
        const student: StudentServerIdentity = { kind: "student", studentId: "grp1::김", name: "김", identityType: "temporary", issuedAt: 0, expiresAt: 9e15 };
        expect(attemptOwnedBy({ studentId: "grp1::김" }, student)).toBe(true);
        expect(attemptOwnedBy({ studentId: "grp1::이" }, student)).toBe(false);
    });

    it("maps identity to an ExamAccessSession for evaluateExamAccess", () => {
        expect(identityAccessSession(GUEST)).toMatchObject({ isGuest: true, identityType: "guest" });
    });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/lib/studentExamCore.test.ts`
Expected: FAIL — "Cannot find module './studentExamCore'".

- [ ] **Step 3: 구현 작성**

```ts
// src/lib/studentExamCore.ts
import type { Attempt, Exam, FocusLossEvent, QuestionTiming, StoredDataRef } from "@/types/omr";
import { gradeAttempt } from "@/types/omr";
import { buildQuestionResults } from "@/lib/premiumAnalytics";
import type { ExamAccessSession } from "@/lib/examAccess";
import type { StudentServerIdentity } from "@/lib/studentServerSession";

export interface SubmitAttemptInput {
    examId: string;
    answers: Record<number, number>;
    startedAt: string;
    autoSubmitted?: boolean;
    questionTimings?: QuestionTiming[];
    focusLossEvents?: FocusLossEvent[];
    tabFociLostCount?: number;
    drawingsRef?: StoredDataRef;
    drawingPageCount?: number;
    drawingStrokeCount?: number;
}

/** Canonical owner id written to omr_attempts.student_id. Guests use the guest:<id> convention. */
export function ownerStudentId(identity: StudentServerIdentity): string {
    if (identity.kind === "guest") return `guest:${identity.guestId}`;
    return identity.studentId || "";
}

export function attemptOwnedBy(
    attempt: Pick<Attempt, "studentId" | "guestId">,
    identity: StudentServerIdentity,
): boolean {
    if (identity.kind === "guest") return !!identity.guestId && attempt.guestId === identity.guestId;
    return !!identity.studentId && attempt.studentId === identity.studentId;
}

export function identityAccessSession(identity: StudentServerIdentity): ExamAccessSession {
    return {
        groupId: identity.groupId,
        groupName: identity.groupName,
        isGuest: identity.kind === "guest",
        identityType: identity.identityType,
    };
}

/**
 * Build a fully server-authoritative attempt: score, totalScore, questionResults are
 * computed here from the trusted exam; owner/org/identity come from the signed cookie.
 * Client-supplied score is never read.
 */
export function buildServerAttempt(
    input: SubmitAttemptInput,
    exam: Exam,
    identity: StudentServerIdentity,
    attemptId: string,
    finishedAtIso: string,
): Attempt {
    const graded = gradeAttempt(exam.questions, input.answers);
    const attempt: Attempt = {
        id: attemptId,
        examId: exam.id,
        examTitle: exam.title,
        organizationId: exam.organizationId,
        studentName: identity.name,
        studentId: ownerStudentId(identity),
        guestId: identity.kind === "guest" ? identity.guestId : undefined,
        groupId: identity.groupId,
        groupName: identity.groupName,
        regionId: identity.regionId,
        regionName: identity.regionName,
        identityType: identity.identityType,
        startedAt: input.startedAt,
        finishedAt: finishedAtIso,
        score: graded.earnedScore,
        totalScore: graded.totalScore,
        answers: input.answers,
        status: "completed",
        autoSubmitted: input.autoSubmitted,
        tabFociLostCount: input.tabFociLostCount,
        questionTimings: input.questionTimings,
        focusLossEvents: input.focusLossEvents,
        drawingsRef: input.drawingsRef,
        drawingPageCount: input.drawingPageCount,
        drawingStrokeCount: input.drawingStrokeCount,
    };
    attempt.questionResults = buildQuestionResults(exam, attempt);
    return attempt;
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/lib/studentExamCore.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: 커밋**

```bash
git add src/lib/studentExamCore.ts src/lib/studentExamCore.test.ts
git commit -m "feat(server): studentExamCore server-grading, ownership, access-session mapping"
```

---

## Task 5: 서버 액션 — 세션 발급 & 시험/제출 중개

**Files:**
- Create: `src/app/actions/studentSession.ts`
- Create: `src/app/actions/studentExam.ts`

액션은 위 순수/서버 조각을 조립하는 얇은 래퍼다(로직은 Task 1–4에서 이미 테스트됨). 실 Supabase/쿠키 의존이라 단위테스트 대신 타입체크·수동 검증 + Phase A2의 e2e로 검증한다.

- [ ] **Step 1: `studentSession.ts` 작성**

```ts
// src/app/actions/studentSession.ts
"use server";

import { cookies, headers } from "next/headers";
import { randomUUID } from "node:crypto";
import {
    createSignedStudentSessionCookie,
    STUDENT_SERVER_SESSION_COOKIE,
    STUDENT_SERVER_SESSION_MAX_AGE_SECONDS,
    type StudentIdentityInput,
} from "@/lib/studentServerSession";
import { shouldUseSecureTeacherSessionCookie } from "@/lib/teacherServerSession";

async function setSessionCookie(input: StudentIdentityInput): Promise<{ ok: boolean }> {
    const value = createSignedStudentSessionCookie(input);
    if (!value) return { ok: false };
    const headerStore = await headers();
    const cookieStore = await cookies();
    cookieStore.set(STUDENT_SERVER_SESSION_COOKIE, value, {
        httpOnly: true,
        sameSite: "lax",
        secure: shouldUseSecureTeacherSessionCookie(headerStore.get("host")),
        path: "/",
        maxAge: STUDENT_SERVER_SESSION_MAX_AGE_SECONDS,
    });
    return { ok: true };
}

export async function issueGuestSession(name?: string): Promise<{ ok: boolean; guestId?: string }> {
    const guestId = randomUUID();
    const result = await setSessionCookie({
        kind: "guest", guestId, name: name?.trim() || "Guest Student", identityType: "guest",
    });
    return { ok: result.ok, guestId: result.ok ? guestId : undefined };
}

export async function issueStudentSession(identity: {
    studentId: string; name: string; groupId?: string; groupName?: string; regionId?: string; regionName?: string;
}): Promise<{ ok: boolean }> {
    if (!identity.studentId.trim() || !identity.name.trim()) return { ok: false };
    return setSessionCookie({ kind: "student", ...identity, identityType: "temporary" });
}
```

- [ ] **Step 2: `studentExam.ts` 작성**

```ts
// src/app/actions/studentExam.ts
"use server";

import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";
import { parseSignedStudentSessionCookie, STUDENT_SERVER_SESSION_COOKIE, type StudentServerIdentity } from "@/lib/studentServerSession";
import { getSupabaseServerConfigFromEnv, createSupabaseAdminClient, fetchAttemptRowsByOwner, fetchExamRowById, type SupabaseAdminClientLike, type SupabaseAdminReadClientLike } from "@/lib/supabaseServerAdmin";
import { attemptFromSupabaseRow, examFromSupabaseRow, attemptToSupabaseRow, questionResultRowsForAttempt } from "@/lib/omrPersistence";
import { evaluateExamAccess } from "@/lib/examAccess";
import { stripExamForSolving, type SolvableExam } from "@/lib/examSolvePayload";
import { attemptOwnedBy, buildServerAttempt, identityAccessSession, type SubmitAttemptInput } from "@/lib/studentExamCore";
import type { Attempt } from "@/types/omr";

type Status = "ok" | "unauthenticated" | "degraded_local" | "denied" | "error";

async function currentIdentity(): Promise<StudentServerIdentity | null> {
    const cookieStore = await cookies();
    return parseSignedStudentSessionCookie(cookieStore.get(STUDENT_SERVER_SESSION_COOKIE)?.value);
}

type AdminClient = SupabaseAdminClientLike & SupabaseAdminReadClientLike;
function adminOrNull(): AdminClient | null {
    const config = getSupabaseServerConfigFromEnv();
    return config ? (createSupabaseAdminClient(config) as unknown as AdminClient) : null;
}

export interface SolveLoadResult {
    status: Status | "pin_required" | "login_required" | "group_denied" | "not_started" | "ended" | "archived";
    exam?: SolvableExam;
}

export async function loadExamForSolving(examId: string, pin?: string): Promise<SolveLoadResult> {
    const identity = await currentIdentity();
    if (!identity) return { status: "unauthenticated" };
    const admin = adminOrNull();
    if (!admin) return { status: "degraded_local" }; // dev-only; client falls back (spec §8)

    const row = await fetchExamRowById(admin, examId);
    if (!row) return { status: "ended" };
    const exam = examFromSupabaseRow(row as Parameters<typeof examFromSupabaseRow>[0]);

    const pinVerified = !exam.accessConfig?.pin || (!!pin && pin === exam.accessConfig.pin);
    const access = evaluateExamAccess(exam, { session: identityAccessSession(identity), pinVerified });
    if (access.status !== "allowed") return { status: access.status };
    return { status: "ok", exam: stripExamForSolving(exam) };
}

export async function submitAttempt(input: SubmitAttemptInput): Promise<{ status: Status; attempt?: Attempt }> {
    const identity = await currentIdentity();
    if (!identity) return { status: "unauthenticated" };
    const admin = adminOrNull();
    if (!admin) return { status: "degraded_local" };

    const row = await fetchExamRowById(admin, input.examId);
    if (!row) return { status: "error" };
    const exam = examFromSupabaseRow(row as Parameters<typeof examFromSupabaseRow>[0]);

    const access = evaluateExamAccess(exam, { session: identityAccessSession(identity), pinVerified: true });
    if (access.status !== "allowed") return { status: "denied" };

    const attempt = buildServerAttempt(input, exam, identity, randomUUID(), new Date().toISOString());
    const attemptResult = await admin.from("omr_attempts").upsert(attemptToSupabaseRow(attempt));
    if (attemptResult.error) return { status: "error" };
    const resultRows = questionResultRowsForAttempt(attempt);
    if (resultRows.length > 0) {
        const qrResult = await admin.from("omr_question_results").upsert(resultRows);
        if (qrResult.error) return { status: "error" };
    }
    return { status: "ok", attempt };
}

export async function listMyAssignments(): Promise<{ status: Status; attempts?: Attempt[] }> {
    const identity = await currentIdentity();
    if (!identity) return { status: "unauthenticated" };
    const admin = adminOrNull();
    if (!admin) return { status: "degraded_local" };
    const rows = await fetchAttemptRowsByOwner(admin, { studentId: identity.kind === "guest" ? `guest:${identity.guestId}` : identity.studentId });
    const attempts = rows
        .map(r => { try { return attemptFromSupabaseRow(r as Parameters<typeof attemptFromSupabaseRow>[0]); } catch { return null; } })
        .filter((a): a is Attempt => !!a && attemptOwnedBy(a, identity));
    return { status: "ok", attempts };
}

export async function loadMyAttempt(attemptId: string): Promise<{ status: Status; attempt?: Attempt }> {
    const identity = await currentIdentity();
    if (!identity) return { status: "unauthenticated" };
    const admin = adminOrNull();
    if (!admin) return { status: "degraded_local" };
    const rows = await fetchAttemptRowsByOwner(admin, { studentId: identity.kind === "guest" ? `guest:${identity.guestId}` : identity.studentId });
    const match = rows
        .map(r => { try { return attemptFromSupabaseRow(r as Parameters<typeof attemptFromSupabaseRow>[0]); } catch { return null; } })
        .find(a => !!a && a.id === attemptId && attemptOwnedBy(a, identity));
    return match ? { status: "ok", attempt: match } : { status: "denied" };
}
```

- [ ] **Step 3: 타입체크·전체 테스트**

Run: `npx tsc --noEmit && npx vitest run src/lib/studentServerSession.test.ts src/lib/examSolvePayload.test.ts src/lib/supabaseServerAdmin.test.ts src/lib/studentExamCore.test.ts`
Expected: 타입 에러 없음, 모든 단위테스트 PASS.

> `attemptToSupabaseRow`/`questionResultRowsForAttempt`/`attemptFromSupabaseRow`/`examFromSupabaseRow`가 [`omrPersistence.ts`](../../../src/lib/omrPersistence.ts)에서 export 되어 있는지 확인(이미 export됨). `submitAttempt`이 `attemptToSupabaseRow(attempt)`에 org를 넘길 때, `attempt.organizationId`가 채워져 있으면 그대로 사용된다(서버가 exam org로 주입).

- [ ] **Step 4: 커밋**

```bash
git add src/app/actions/studentSession.ts src/app/actions/studentExam.ts
git commit -m "feat(server): student/guest session + exam-load/submit/list server actions"
```

---

## Phase A1 Self-Check (구현 후)

- [ ] `npx vitest run` 전체 그린.
- [ ] `npx tsc --noEmit` 클린.
- [ ] `loadExamForSolving` 반환 `SolvableExam`에 `answer`/`pin`/`answerKeyPdf` 타입·런타임 부재 재확인(Task 2 계약테스트).
- [ ] `submitAttempt`이 클라 점수를 읽지 않고 재채점함(Task 4 테스트).

---

## Phase A2 (다음 계획, 클라 배선) — 태스크 아웃라인

A1의 실제 export가 존재하면 아래를 step-level 코드로 상세화한다(별도 plan 문서). 각 앵커는 실제 현행 코드 위치.

1. **로그인 배선** — [`page.tsx` `handleGuest`(355–369)](../../../src/app/page.tsx:355), [`handleStudentLogin`(238–353)](../../../src/app/page.tsx:238): 세션 저장 직전에 `await issueGuestSession()` / `await issueStudentSession(...)` 호출. 게스트 guestId는 서버 반환값 사용.
2. **학생 로그인 UI 고지** — 학생 폼에 "정식 학생 인증 준비 중(현재 임시 신원)" 안내(spec §4 완화 조치).
3. **solve 재배선** — [로드(837–851)](../../../src/app/solve/[id]/page.tsx:837)를 `loadExamForSolving(id, pin?)`로 교체(정답 없는 `SolvableExam` 소비); [제출(1116–1257)](../../../src/app/solve/[id]/page.tsx:1116)에서 클라 `gradeAttempt`/`saveAttempt` 제거하고 `submitAttempt(input, pin)` 호출(드로잉은 클라 IndexedDB 아카이브 후 ref만 전달). 정답이 없으므로 리뷰 화면은 `loadMyAttempt`의 서버 결과 사용. ⚠️ **(I-1 필수)** `submitAttempt`에 **PIN을 반드시 스레딩** — 특히 **타이머 자동제출** 경로. 공개+PIN 시험에서 PIN 미전달 시 제출이 `pin_required`로 거부됨. (권장 대안: `loadExamForSolving` 성공 시 서명 pin-ok 쿠키를 세워 submit이 PIN 없이 통과.)
4. **대시보드 재배선** — [`student/dashboard`(65–125)](../../../src/app/student/dashboard/page.tsx:65)에서 `loadAttempts` 대신 `listMyAssignments`; 게스트 목록은 "시작한 시험만"으로 좁힘(spec §7a).
5. **degraded_local 처리** — 서버 액션이 `degraded_local` 반환 시(dev, Supabase 미설정) 기존 localStorage 경로 폴백; 프로덕션에서 이 상태면 명시적 에러(spec §8, [`deploymentReadiness`](../../../src/lib/deploymentReadiness.ts)와 정렬).
6. **e2e 갱신** — [`e2e/full-journey.spec.ts`](../../../e2e/full-journey.spec.ts) 등 학생 여정을 서버 경로로 갱신, 정답 미노출·본인격리 어서션 추가.

---

## A1 구현 반영 & A2 필수 주의 (2026-07-01 최종 홀리스틱 리뷰)

A1 5개 태스크 구현 + 태스크별 2단계 리뷰 + 전체 홀리스틱 리뷰 완료(**A1 sound to land**, Critical 0, 514 테스트 그린, tsc 클린). 계획 대비 반영/개선:
- **PIN**: pin-ok 쿠키 대신 **stateless** — load·submit이 각각 `pin` 인자로 `verifyExamPin` 재검증. → **A2 최우선(I-1)**: submit(자동제출 포함)에 PIN 스레딩 필수, 또는 pin-ok 쿠키 도입.
- `stripExamForSolving`가 `explanation`도 제거(정답 노출 방지). 서버 액션은 throw→`{status:'error'}`로 수렴(+`console.error`), 접근 실패는 granular status, 클라 `startedAt` 서버 클램프.
- **A2 주의**: **(M-1)** 없는 examId는 `ended`로 마스킹(열거 방지) — "종료" UX 오인 주의. **(M-2)** 게스트/학생 **재시험(retake) 서버 경로 없음** → A2/B 별도 처리, 클라 재시험 회귀 주의. **(degraded_local)** dev 폴백 분기 반드시 처리, 프로덕션은 hard error(spec §8).
- **미해결 이월**: 로그인 시점 학생 사칭(B), anon revoke(C) — spec §11 보안표 참조.

---

## Execution Handoff

Phase A1 계획 완료. 실행 방식 선택:
1. **Subagent-Driven (권장)** — 태스크별 신규 서브에이전트 + 태스크 사이 리뷰.
2. **Inline Execution** — 이 세션에서 executing-plans로 체크포인트 배치 실행.
