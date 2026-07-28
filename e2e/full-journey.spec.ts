import { readFile } from "node:fs/promises";
import { test, expect, type Page } from "@playwright/test";
import { continueSolveEntryIfPresent, loginAsTeacher, resetBrowserState } from "./helpers";
import { parseCsvRows } from "../src/lib/csv";
import { formatKoreanDate } from "../src/lib/pure";

const TEST_EXAM_ID = "e2e-korean-integrated-exam";
const TEST_EXAM_TITLE = "E2E 국어 통합 시험";
const TEST_GROUP_ID = "class-a";
const TEST_GROUP_NAME = "A반";
const TEST_STUDENT_ID = `${TEST_GROUP_ID}::김학생`;
const TEST_STUDENT_NAME = "김학생";
const TEST_STUDENT_START_CODE = "E2E777";
const CREATED_EXAM_TITLE = "E2E 생성 UI 국어 시험";
const CREATED_ANSWER_KEY = "12345123451234512345";
const SAME_NAME_GROUP_ID = "same-name-class-a";
const SAME_NAME_GROUP_NAME = "동명이인 A반";
const SAME_NAME_STUDENT_NAME = "김학생";
const SAME_NAME_FIRST_ID = "same-name-001";
const SAME_NAME_SECOND_ID = "same-name-002";
const SAME_NAME_SECOND_EMAIL = "same.second@example.edu";
const SAME_NAME_START_CODE = "ZXCV12";
const submissionReceiptEntryKey = (attemptId: string) => (
    `omr_student_submission_receipt_v2:${encodeURIComponent(attemptId)}`
);
const submissionRequestEntryKey = (attemptId: string) => (
    `omr_student_submission_request_v2:${encodeURIComponent(attemptId)}`
);
const submissionAliasEntryKey = (attemptId: string) => (
    `omr_student_submission_alias_v2:${encodeURIComponent(attemptId)}`
);

async function seedStudentRoster(page: Page) {
    await page.evaluate((seed) => {
        const group = {
            id: seed.groupId,
            name: seed.groupName,
            region: "서울",
            count: 1,
            avgScore: 0,
            color: "#4f46e5",
        };
        const student = {
            id: seed.studentId,
            name: seed.studentName,
            email: "kim.student@example.com",
            group: seed.groupName,
            region: "서울",
            avatar: "#4f46e5",
            avgScore: 0,
            examsTaken: 0,
            lastActive: "기록 없음",
            trend: "flat",
            status: "active",
        };

        window.localStorage.setItem("omr_groups", JSON.stringify([group]));
        window.localStorage.setItem("omr_students", JSON.stringify([student]));
        window.localStorage.setItem("omr_attempts", JSON.stringify([]));
    }, {
        groupId: TEST_GROUP_ID,
        groupName: TEST_GROUP_NAME,
        studentId: TEST_STUDENT_ID,
        studentName: TEST_STUDENT_NAME,
    });
}

async function seedSameNameRosterWithProtectedHistory(page: Page) {
    await page.evaluate((seed) => {
        const finishedAt = new Date().toISOString();
        const startedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        const group = {
            id: seed.groupId,
            name: seed.groupName,
            region: "서울",
            count: 2,
            avgScore: 0,
            color: "#4f46e5",
        };
        const students = [
            {
                id: seed.firstId,
                name: seed.studentName,
                email: "same.first@example.edu",
                group: seed.groupName,
                region: "서울",
                avatar: "#4f46e5",
                avgScore: 0,
                examsTaken: 1,
                lastActive: "2026. 6. 19.",
                trend: "flat",
                status: "active",
            },
            {
                id: seed.secondId,
                name: seed.studentName,
                email: seed.secondEmail,
                group: seed.groupName,
                region: "서울",
                avatar: "#10b981",
                avgScore: 0,
                examsTaken: 1,
                lastActive: "2026. 6. 19.",
                trend: "flat",
                status: "active",
            },
        ];
        const protectedAttempt = {
            id: "attempt-same-name-second",
            examId: "same-name-exam",
            examTitle: "동명이인 보호 시험",
            studentProfileId: seed.secondId,
            studentName: seed.studentName,
            studentId: seed.secondId,
            groupId: seed.groupId,
            groupName: seed.groupName,
            regionId: "서울",
            regionName: "서울",
            identityType: "temporary",
            startedAt,
            finishedAt,
            score: 0,
            totalScore: 0,
            answers: {},
            status: "completed",
            questionResults: [],
        };

        window.localStorage.setItem("omr_groups", JSON.stringify([group]));
        window.localStorage.setItem("omr_students", JSON.stringify(students));
        window.localStorage.setItem("omr_attempts", JSON.stringify([protectedAttempt]));
        window.localStorage.setItem("omr_student_codes", JSON.stringify({
            [seed.secondId]: seed.startCode,
        }));
    }, {
        groupId: SAME_NAME_GROUP_ID,
        groupName: SAME_NAME_GROUP_NAME,
        studentName: SAME_NAME_STUDENT_NAME,
        firstId: SAME_NAME_FIRST_ID,
        secondId: SAME_NAME_SECOND_ID,
        secondEmail: SAME_NAME_SECOND_EMAIL,
        startCode: SAME_NAME_START_CODE,
    });
}

async function loginAsStudent(page: Page) {
    await page.goto("/?role=student");
    await expect(page.getByText("학생 포털")).toBeVisible();
    await page.getByLabel("이름").fill(TEST_STUDENT_NAME);
    await page.getByLabel("학생번호 또는 이메일").fill("kim.student@example.com");
    await page.getByLabel("반 선택").selectOption(TEST_GROUP_ID);
    await page.getByRole("button", { name: "시험 시작하기" }).click();
    const issuedCodeDialog = page.getByRole("dialog", { name: "시작 코드가 발급되었습니다" });
    await expect(issuedCodeDialog).toBeVisible();
    await issuedCodeDialog.getByRole("button", { name: "저장했어요, 계속" }).click();
    await expect(page).toHaveURL(/\/student\/dashboard$/);
    const session = await page.evaluate(() => JSON.parse(window.sessionStorage.getItem("omr_student_session") || "null"));
    expect(session).toMatchObject({
        studentId: TEST_STUDENT_ID,
        loginId: TEST_STUDENT_ID,
        name: TEST_STUDENT_NAME,
        groupId: TEST_GROUP_ID,
        groupName: TEST_GROUP_NAME,
        regionId: "서울",
        regionName: "서울",
        isGuest: false,
        identityType: "temporary",
    });
}

async function requireStartCodeForSeedStudent(page: Page) {
    await page.evaluate((seed) => {
        const rawCodes = window.localStorage.getItem("omr_student_codes");
        let codes: Record<string, string> = {};

        try {
            const parsed = JSON.parse(rawCodes || "{}");
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                codes = parsed;
            }
        } catch {
            codes = {};
        }

        codes[seed.studentId] = seed.startCode;
        window.localStorage.setItem("omr_student_codes", JSON.stringify(codes));
        window.localStorage.removeItem("omr_student_session_backup");
        window.sessionStorage.removeItem("omr_student_session");
    }, {
        studentId: TEST_STUDENT_ID,
        startCode: TEST_STUDENT_START_CODE,
    });
}

async function ensureAnswerPaneVisible(page: Page) {
    await continueSolveEntryIfPresent(page);
    const expandButton = page.getByRole("button", { name: "답안지 펼치기", exact: true });
    if (await expandButton.isVisible().catch(() => false)) {
        await expandButton.click();
    }
    await expect(page.locator(".solve-omr-pane:not(.is-collapsed) .solve-omr-pane-title", {
        hasText: "OMR 답안",
    })).toBeVisible();
}

async function setAwayTestClock(page: Page, nowMs: number) {
    await page.evaluate((now) => {
        Date.now = () => now;
    }, nowMs);
}

async function setAwayTestVisibility(page: Page, state: "hidden" | "visible") {
    await page.evaluate((visibilityState) => {
        Object.defineProperty(document, "visibilityState", {
            configurable: true,
            value: visibilityState,
        });
        Object.defineProperty(document, "hidden", {
            configurable: true,
            value: visibilityState === "hidden",
        });
    }, state);
}

async function beginAwayWithBrowserSignals(page: Page, nowMs: number) {
    await setAwayTestClock(page, nowMs);
    await setAwayTestVisibility(page, "hidden");
    await page.evaluate(() => {
        window.dispatchEvent(new Event("blur"));
        document.dispatchEvent(new Event("visibilitychange"));
    });
}

async function finishAwayWithBrowserSignals(page: Page, nowMs: number) {
    await setAwayTestClock(page, nowMs);
    await setAwayTestVisibility(page, "visible");
    await page.evaluate(() => {
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event("focus"));
    });
}

async function readAwayCount(page: Page): Promise<number> {
    const value = await page.locator(".solve-page").getAttribute("data-away-count");
    if (value === null) throw new Error("Solve page did not expose its current away count");
    return Number(value);
}

async function seedExamAndStudent(page: Page) {
    await page.evaluate((seed) => {
        const now = new Date().toISOString();
        const exam = {
            id: seed.examId,
            title: seed.examTitle,
            createdAt: now,
            updatedAt: now,
            durationMin: 30,
            archived: false,
            accessConfig: {
                type: "group",
                groupIds: [seed.groupId],
            },
            questions: [
                {
                    id: 1,
                    number: 1,
                    label: "문법",
                    score: 10,
                    answer: 2,
                    choices: 5,
                    explanation: "높임 표현의 주체를 확인합니다.",
                    tags: {
                        subject: "국어",
                        unit: "문법",
                        concept: "높임 표현",
                        difficulty: "easy",
                        mistakeTypes: ["개념 부족"],
                    },
                },
                {
                    id: 2,
                    number: 2,
                    label: "독해",
                    score: 10,
                    answer: 3,
                    choices: 5,
                    explanation: "문단의 중심 내용을 근거로 고릅니다.",
                    tags: {
                        subject: "국어",
                        unit: "독해",
                        concept: "중심 내용",
                        difficulty: "medium",
                        mistakeTypes: ["지문 오독"],
                    },
                },
                {
                    id: 3,
                    number: 3,
                    label: "어휘",
                    score: 10,
                    answer: 4,
                    choices: 5,
                    explanation: "문맥상 가장 자연스러운 어휘를 선택합니다.",
                    tags: {
                        subject: "국어",
                        unit: "어휘",
                        concept: "문맥 어휘",
                        difficulty: "medium",
                        mistakeTypes: ["선택지 함정"],
                    },
                },
            ],
        };
        const group = {
            id: seed.groupId,
            name: seed.groupName,
            region: "서울",
            count: 1,
            avgScore: 0,
            color: "#4f46e5",
        };
        const student = {
            id: seed.studentId,
            name: seed.studentName,
            email: "kim.student@example.com",
            group: seed.groupName,
            region: "서울",
            avatar: "#4f46e5",
            avgScore: 0,
            examsTaken: 0,
            lastActive: "기록 없음",
            trend: "flat",
            status: "active",
        };
        const session = {
            studentId: seed.studentId,
            loginId: seed.studentId,
            name: seed.studentName,
            groupId: seed.groupId,
            groupName: seed.groupName,
            regionId: "서울",
            regionName: "서울",
            isGuest: false,
            identityType: "temporary",
        };

        window.localStorage.setItem(`omr_exam_${seed.examId}`, JSON.stringify(exam));
        window.localStorage.setItem("omr_groups", JSON.stringify([group]));
        window.localStorage.setItem("omr_students", JSON.stringify([student]));
        window.localStorage.setItem("omr_attempts", JSON.stringify([]));
        window.localStorage.setItem("omr_student_session_backup", JSON.stringify(session));
        window.sessionStorage.setItem("omr_student_session", JSON.stringify(session));
    }, {
        examId: TEST_EXAM_ID,
        examTitle: TEST_EXAM_TITLE,
        groupId: TEST_GROUP_ID,
        groupName: TEST_GROUP_NAME,
        studentId: TEST_STUDENT_ID,
        studentName: TEST_STUDENT_NAME,
    });
}

async function seedCompletedAttempt(page: Page) {
    await page.evaluate((seed) => {
        const finishedAt = new Date().toISOString();
        const startedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
        const base = {
            schemaVersion: 1,
            attemptId: "attempt-tablet-analytics",
            examId: seed.examId,
            examTitle: seed.examTitle,
            studentProfileId: seed.studentId,
            studentName: seed.studentName,
            studentId: seed.studentId,
            groupId: seed.groupId,
            groupName: seed.groupName,
            regionId: "서울",
            regionName: "서울",
            identityType: "temporary",
            finishedAt,
        };
        const questionResults = [
            {
                ...base,
                questionId: 1,
                questionNumber: 1,
                label: "문법",
                score: 10,
                earnedScore: 10,
                selectedAnswer: 2,
                correctAnswer: 2,
                status: "correct",
                isCorrect: true,
                isWrong: false,
                isUnanswered: false,
                subject: "국어",
                unit: "문법",
                concept: "높임 표현",
                difficulty: "easy",
                mistakeTypes: ["개념 부족"],
                timeSec: 35,
                visitCount: 1,
                revisitCount: 0,
            },
            {
                ...base,
                questionId: 2,
                questionNumber: 2,
                label: "독해",
                score: 10,
                earnedScore: 10,
                selectedAnswer: 3,
                correctAnswer: 3,
                status: "correct",
                isCorrect: true,
                isWrong: false,
                isUnanswered: false,
                subject: "국어",
                unit: "독해",
                concept: "중심 내용",
                difficulty: "medium",
                mistakeTypes: ["지문 오독"],
                timeSec: 50,
                visitCount: 2,
                revisitCount: 1,
            },
            {
                ...base,
                questionId: 3,
                questionNumber: 3,
                label: "어휘",
                score: 10,
                earnedScore: 0,
                selectedAnswer: 1,
                correctAnswer: 4,
                status: "wrong",
                isCorrect: false,
                isWrong: true,
                isUnanswered: false,
                subject: "국어",
                unit: "어휘",
                concept: "문맥 어휘",
                difficulty: "medium",
                mistakeTypes: ["선택지 함정"],
                timeSec: 40,
                visitCount: 1,
                revisitCount: 0,
            },
        ];
        const attempt = {
            id: "attempt-tablet-analytics",
            examId: seed.examId,
            examTitle: seed.examTitle,
            studentProfileId: seed.studentId,
            studentName: seed.studentName,
            studentId: seed.studentId,
            groupId: seed.groupId,
            groupName: seed.groupName,
            regionId: "서울",
            regionName: "서울",
            identityType: "temporary",
            startedAt,
            finishedAt,
            score: 20,
            totalScore: 30,
            answers: { 1: 2, 2: 3, 3: 1 },
            status: "completed",
            questionResults,
            questionTimings: [
                { questionId: 1, questionNumber: 1, totalTimeSec: 35, visitCount: 1, revisitCount: 0, answerChangeCount: 0 },
                { questionId: 2, questionNumber: 2, totalTimeSec: 50, visitCount: 2, revisitCount: 1, answerChangeCount: 1 },
                { questionId: 3, questionNumber: 3, totalTimeSec: 40, visitCount: 1, revisitCount: 0, answerChangeCount: 0 },
            ],
        };

        window.localStorage.setItem("omr_attempts", JSON.stringify([attempt]));
    }, {
        examId: TEST_EXAM_ID,
        examTitle: TEST_EXAM_TITLE,
        groupId: TEST_GROUP_ID,
        groupName: TEST_GROUP_NAME,
        studentId: TEST_STUDENT_ID,
        studentName: TEST_STUDENT_NAME,
    });
}

test.describe("Teacher and student full journey", () => {
    test.describe.configure({ timeout: 45_000 });

    test.beforeEach(async ({ page, context }) => {
        await resetBrowserState(page, context);
    });

    test("requires student ID or email before opening a roster-backed student account", async ({ page }) => {
        await seedStudentRoster(page);
        await page.goto("/?role=student");
        await expect(page.getByText("학생 포털")).toBeVisible();

        await page.getByLabel("이름").fill(TEST_STUDENT_NAME);
        await page.getByLabel("반 선택").selectOption(TEST_GROUP_ID);
        await page.getByRole("button", { name: "시험 시작하기" }).click();
        await expect(page.getByText("명단 학생은 선생님이 알려준 학생번호 또는 이메일을 입력해주세요.")).toBeVisible();
        await expect(page.getByText("명단 이메일이나 선생님이 알려준 학생번호로 본인 계정을 확인합니다.")).toBeVisible();

        await page.getByLabel("학생번호 또는 이메일").fill("kim.student@example.com");
        await page.getByRole("button", { name: "시험 시작하기" }).click();
        const issuedCodeDialog = page.getByRole("dialog", { name: "시작 코드가 발급되었습니다" });
        await expect(issuedCodeDialog).toBeVisible();
        await issuedCodeDialog.getByRole("button", { name: "저장했어요, 계속" }).click();
        await expect(page).toHaveURL(/\/student\/dashboard$/);

        const session = await page.evaluate(() => JSON.parse(window.sessionStorage.getItem("omr_student_session") || "null"));
        expect(session).toMatchObject({
            studentId: TEST_STUDENT_ID,
            loginId: TEST_STUDENT_ID,
            name: TEST_STUDENT_NAME,
            groupId: TEST_GROUP_ID,
            groupName: TEST_GROUP_NAME,
            regionId: "서울",
            regionName: "서울",
            isGuest: false,
            identityType: "temporary",
        });

        const storedCodes = await page.evaluate(() => JSON.parse(window.localStorage.getItem("omr_student_codes") || "{}"));
        expect(storedCodes[TEST_STUDENT_ID]).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    });

    test("requires lookup and start code before opening a same-name student account with history", async ({ page }) => {
        await seedSameNameRosterWithProtectedHistory(page);
        await page.goto("/?role=student");
        await expect(page.getByText("학생 포털")).toBeVisible();

        await page.getByLabel("이름").fill(SAME_NAME_STUDENT_NAME);
        await page.getByLabel("반 선택").selectOption(SAME_NAME_GROUP_ID);
        await expect(page.getByText("명단 이메일이나 선생님이 알려준 학생번호로 본인 계정을 확인합니다.")).toBeVisible();

        await page.getByRole("button", { name: "시험 시작하기" }).click();
        await expect(page.getByText("동명이인이 있습니다. 선생님이 알려준 학생번호 또는 이메일을 입력해주세요.")).toBeVisible();

        await page.getByLabel("학생번호 또는 이메일").fill("wrong@example.edu");
        await page.getByRole("button", { name: "시험 시작하기" }).click();
        await expect(page.getByText("학생번호 또는 이메일이 명단과 일치하지 않습니다.")).toBeVisible();

        await page.getByLabel("학생번호 또는 이메일").fill(SAME_NAME_SECOND_EMAIL);
        await expect(page.getByLabel("시작 코드")).toBeVisible();
        await page.getByRole("button", { name: "시험 시작하기" }).click();
        await expect(page.getByText("이미 등록된 학생입니다. 선생님이 발급한 시작 코드를 입력해주세요.")).toBeVisible();

        await page.getByLabel("시작 코드").fill("WRONG1");
        await page.getByRole("button", { name: "시험 시작하기" }).click();
        await expect(page.getByText("시작 코드가 일치하지 않습니다.")).toBeVisible();

        await page.getByLabel("시작 코드").fill(SAME_NAME_START_CODE);
        await page.getByRole("button", { name: "시험 시작하기" }).click();
        await expect(page).toHaveURL(/\/student\/dashboard$/);

        const session = await page.evaluate(() => JSON.parse(window.sessionStorage.getItem("omr_student_session") || "null"));
        expect(session).toMatchObject({
            studentId: SAME_NAME_SECOND_ID,
            loginId: `${SAME_NAME_GROUP_ID}::${SAME_NAME_STUDENT_NAME}`,
            name: SAME_NAME_STUDENT_NAME,
            groupId: SAME_NAME_GROUP_ID,
            groupName: SAME_NAME_GROUP_NAME,
            regionId: "서울",
            regionName: "서울",
            isGuest: false,
            identityType: "temporary",
        });
    });

    test("lets a start-code student submit an exam and feed teacher analytics", async ({ page }) => {
        await seedExamAndStudent(page);
        await requireStartCodeForSeedStudent(page);

        await page.goto("/?role=student");
        await expect(page.getByText("학생 포털")).toBeVisible();
        await page.getByLabel("이름").fill(TEST_STUDENT_NAME);
        await page.getByLabel("학생번호 또는 이메일").fill("kim.student@example.com");
        await page.getByLabel("반 선택").selectOption(TEST_GROUP_ID);
        await expect(page.getByLabel("시작 코드")).toBeVisible();

        await page.getByRole("button", { name: "시험 시작하기" }).click();
        await expect(page.getByText("이미 등록된 학생입니다. 선생님이 발급한 시작 코드를 입력해주세요.")).toBeVisible();

        await page.getByLabel("시작 코드").fill(TEST_STUDENT_START_CODE);
        await page.getByRole("button", { name: "시험 시작하기" }).click();
        await expect(page).toHaveURL(/\/student\/dashboard$/);
        await expect(page.getByRole("heading", { name: `${TEST_STUDENT_NAME}님,` })).toBeVisible();
        await expect(page.getByText(TEST_EXAM_TITLE)).toBeVisible();

        const session = await page.evaluate(() => JSON.parse(window.sessionStorage.getItem("omr_student_session") || "null"));
        expect(session).toMatchObject({
            studentId: TEST_STUDENT_ID,
            loginId: TEST_STUDENT_ID,
            name: TEST_STUDENT_NAME,
            groupId: TEST_GROUP_ID,
            groupName: TEST_GROUP_NAME,
            regionId: "서울",
            regionName: "서울",
            isGuest: false,
            identityType: "temporary",
        });

        await page.getByRole("link", { name: "시작" }).click();
        await expect(page).toHaveURL(new RegExp(`/solve/${TEST_EXAM_ID}$`), { timeout: 15_000 });
        await ensureAnswerPaneVisible(page);

        await page.getByRole("radio", { name: "문제 1번 보기 2" }).click();
        await page.getByRole("radio", { name: "문제 2번 보기 3" }).click();
        await page.getByRole("radio", { name: "문제 3번 보기 1" }).click();
        await expect(page.getByText("모든 문제 표기 완료")).toBeVisible();

        await page.locator(".solve-submit-button").click();
        const confirmDialog = page.getByRole("dialog", { name: "답안 제출" });
        await expect(confirmDialog).toBeVisible();
        await confirmDialog.getByRole("button", { name: "제출하기" }).click();

        await expect(page).toHaveURL(/\/student\/review\/[^/?#]+$/, { timeout: 15_000 });
        await expect(page.getByText("결과 리포트", { exact: true })).toBeVisible();
        await expect(page.getByText(TEST_EXAM_TITLE)).toBeVisible();
        await expect(page.getByText("20 / 30점")).toBeVisible();

        const storedAttempts = await page.evaluate(() => JSON.parse(window.localStorage.getItem("omr_attempts") || "[]"));
        expect(storedAttempts).toHaveLength(1);
        expect(storedAttempts[0]).toMatchObject({
            examId: TEST_EXAM_ID,
            examTitle: TEST_EXAM_TITLE,
            studentName: TEST_STUDENT_NAME,
            studentId: TEST_STUDENT_ID,
            score: 20,
            totalScore: 30,
            status: "completed",
            identityType: "temporary",
        });

        await loginAsTeacher(page, "/teacher/dashboard?tab=exam");
        await expect(page.getByRole("heading", { name: "분석 센터" })).toBeVisible();
        await page.getByRole("tab", { name: "학생·반" }).click();
        await expect(page.getByText("학생별 점수 및 성취도")).toBeVisible();
        await expect(page.getByRole("row", { name: new RegExp(`${TEST_STUDENT_NAME}.*20점`) })).toBeVisible();
    });

    test("debounces and deduplicates one away session, including the submission flush", async ({ page }) => {
        await seedExamAndStudent(page);
        await page.goto(`/solve/${TEST_EXAM_ID}`);
        await ensureAnswerPaneVisible(page);

        await beginAwayWithBrowserSignals(page, 10_000);
        await finishAwayWithBrowserSignals(page, 11_900);
        expect(await readAwayCount(page)).toBe(0);
        await expect(page.getByRole("dialog", { name: "시험 화면 이탈 안내" })).toHaveCount(0);

        await beginAwayWithBrowserSignals(page, 20_000);
        await finishAwayWithBrowserSignals(page, 22_000);
        expect(await readAwayCount(page)).toBe(1);
        const awayDialog = page.getByRole("dialog", { name: "시험 화면 이탈 안내" });
        await expect(awayDialog).toContainText(
            "시험 화면을 벗어난 기록이 제출 기록과 함께 선생님 화면에 표시됩니다.",
        );
        await awayDialog.getByRole("button", { name: "시험으로 돌아가기" }).click();

        await beginAwayWithBrowserSignals(page, 30_000);
        await finishAwayWithBrowserSignals(page, 32_000);
        expect(await readAwayCount(page)).toBe(2);
        await expect(awayDialog).toContainText(
            "시험 화면 이탈이 2회 기록되었습니다. 답안을 확인한 뒤 계속 진행해 주세요.",
        );
        await awayDialog.getByRole("button", { name: "시험으로 돌아가기" }).click();

        await beginAwayWithBrowserSignals(page, 40_000);
        await setAwayTestClock(page, 42_000);
        await page.locator(".solve-submit-button").click();
        const confirmDialog = page.getByRole("dialog", { name: "답안 제출" });
        await expect(confirmDialog).toBeVisible();
        await confirmDialog.getByRole("button", { name: "제출하기" }).click();

        await expect(page).toHaveURL(/\/student\/review\/[^/?#]+$/, { timeout: 15_000 });
        const storedAttempt = await page.evaluate(() => {
            const attempts = JSON.parse(window.localStorage.getItem("omr_attempts") || "[]");
            return attempts[0];
        });
        expect(storedAttempt.tabFociLostCount).toBe(3);
        expect(storedAttempt.focusLossEvents).toHaveLength(3);
        expect(storedAttempt.focusLossEvents.map((event: { count: number }) => event.count)).toEqual([1, 2, 3]);

        await finishAwayWithBrowserSignals(page, 42_100);
        const countAfterReturnSignals = await page.evaluate(() => {
            const attempts = JSON.parse(window.localStorage.getItem("omr_attempts") || "[]");
            return attempts[0]?.tabFociLostCount;
        });
        expect(countAfterReturnSignals).toBe(3);
    });

    test("skips the entry dialog and scopes questions when re-entering a retake from the student's own review", async ({ page }) => {
        await seedExamAndStudent(page);
        await requireStartCodeForSeedStudent(page);

        // Log in as the roster student and submit with Q3 wrong (answer key is 4).
        await page.goto("/?role=student");
        await page.getByLabel("이름").fill(TEST_STUDENT_NAME);
        await page.getByLabel("학생번호 또는 이메일").fill("kim.student@example.com");
        await page.getByLabel("반 선택").selectOption(TEST_GROUP_ID);
        await page.getByLabel("시작 코드").fill(TEST_STUDENT_START_CODE);
        await page.getByRole("button", { name: "시험 시작하기" }).click();
        await expect(page).toHaveURL(/\/student\/dashboard$/);

        await page.getByRole("link", { name: "시작" }).click();
        await expect(page).toHaveURL(new RegExp(`/solve/${TEST_EXAM_ID}$`), { timeout: 15_000 });
        await ensureAnswerPaneVisible(page);
        await page.getByRole("radio", { name: "문제 1번 보기 2" }).click();
        await page.getByRole("radio", { name: "문제 2번 보기 3" }).click();
        await page.getByRole("radio", { name: "문제 3번 보기 1" }).click();
        await page.locator(".solve-submit-button").click();
        const confirmDialog = page.getByRole("dialog", { name: "답안 제출" });
        await expect(confirmDialog).toBeVisible();
        await confirmDialog.getByRole("button", { name: "제출하기" }).click();
        await expect(page).toHaveURL(/\/student\/review\/[^/?#]+$/, { timeout: 15_000 });

        // Re-enter the wrong-answer retake from the student's own review.
        await page.getByRole("link", { name: "오답만" }).click();
        await expect(page).toHaveURL(new RegExp(`/solve/${TEST_EXAM_ID}\\?.*retakeFrom=`), { timeout: 15_000 });

        // Auto-skip: the "시험 입장 확인" dialog must not appear for the owner's retake.
        await expect(page.getByRole("dialog", { name: "시험 입장 확인" })).toBeHidden();

        // The answer pane is reachable without dismissing any dialog, scoped to Q3 only.
        const expandButton = page.getByRole("button", { name: "답안지 펼치기", exact: true });
        if (await expandButton.isVisible().catch(() => false)) {
            await expandButton.click();
        }
        await expect(page.getByRole("radio", { name: "문제 3번 보기 4" })).toBeVisible();
        await expect(page.getByRole("radio", { name: "문제 1번 보기 1" })).toHaveCount(0);
    });

    test("creates an exam through the teacher UI before student submission and analytics", async ({ page }) => {
        await loginAsTeacher(page, "/create");
        await expect(page.getByText("스마트 에디터")).toBeVisible();

        const examTitleInput = page.getByLabel("시험 제목");
        if (!(await examTitleInput.isVisible().catch(() => false))) {
            await page.getByRole("tab", { name: /^설정/ }).click();
        }
        await expect(examTitleInput).toBeVisible();
        await examTitleInput.fill(CREATED_EXAM_TITLE);
        await page.getByLabel("빠른 정답 입력").fill(CREATED_ANSWER_KEY);
        await expect(
            page.locator("#create-settings-panel .create-design-check-pill", { hasText: "20/20 정답" })
        ).toBeVisible();

        await page.getByRole("button", { name: "배포하기" }).click();
        await expect(page.getByRole("heading", { name: "시험 배포하기" })).toBeVisible();
        await expect(page.getByText("20/20 정답 · 총점 100점")).toBeVisible();
        await expect(
            page.getByText("문제지 PDF가 없으면 학생 화면에서 별도 파일 업로드가 필요합니다.")
        ).toHaveCount(2);

        await page.getByRole("button", { name: "링크 생성하기" }).click();
        await expect(page.getByRole("button", { name: "링크 복사" })).toBeVisible();
        await expect(page).toHaveURL(/\/create\?edit=/);

        const createdExamHandle = await page.waitForFunction((title) => {
            for (let index = 0; index < window.localStorage.length; index += 1) {
                const key = window.localStorage.key(index);
                if (!key?.startsWith("omr_exam_")) continue;
                const exam = JSON.parse(window.localStorage.getItem(key) || "null");
                if (exam?.title === title) return exam;
            }
            return null;
        }, CREATED_EXAM_TITLE);
        const createdExam = await createdExamHandle.jsonValue() as {
            id: string;
            title: string;
            accessConfig?: { type?: string };
            questions?: Array<{ answer?: number; score?: number }>;
        };
        expect(createdExam).toMatchObject({
            title: CREATED_EXAM_TITLE,
            accessConfig: { type: "public" },
        });
        expect(createdExam.questions).toHaveLength(20);
        expect(createdExam.questions?.map(question => question.answer).join("")).toBe(CREATED_ANSWER_KEY);

        await seedStudentRoster(page);
        await loginAsStudent(page);
        await expect(page.getByRole("heading", { name: `${TEST_STUDENT_NAME}님,` })).toBeVisible();
        await expect(page.getByText(CREATED_EXAM_TITLE).first()).toBeVisible();

        await page.getByRole("link", { name: "시작" }).click();
        await expect(page).toHaveURL(new RegExp(`/solve/${createdExam.id}$`));
        await ensureAnswerPaneVisible(page);

        for (const [index, answer] of [...CREATED_ANSWER_KEY].entries()) {
            await page.getByRole("radio", { name: `문제 ${index + 1}번 보기 ${answer}` }).click();
        }
        await expect(page.getByText("모든 문제 표기 완료")).toBeVisible();

        await page.locator(".solve-submit-button").click();
        const confirmDialog = page.getByRole("dialog", { name: "답안 제출" });
        await expect(confirmDialog).toBeVisible();
        await confirmDialog.getByRole("button", { name: "제출하기" }).click();

        await expect(page).toHaveURL(/\/student\/review\/[^/?#]+$/);
        await expect(page.getByText("결과 리포트", { exact: true })).toBeVisible();
        await expect(page.getByText(CREATED_EXAM_TITLE).first()).toBeVisible();
        await expect(page.getByText("100 / 100점")).toBeVisible();

        await loginAsTeacher(page, "/teacher/dashboard");
        await expect(page.getByRole("heading", { name: "분석 센터" })).toBeVisible();
        await expect(page.getByText(CREATED_EXAM_TITLE).first()).toBeVisible();
        await expect(page.getByRole("button", { name: "통계 CSV" })).toBeVisible();

        await page.getByRole("button", { name: "시험 분석", exact: true }).click();
        await page.getByRole("tab", { name: "학생·반" }).click();
        await expect(page.getByText("학생별 점수 및 성취도")).toBeVisible();
        await expect(page.getByRole("row", { name: new RegExp(`${TEST_STUDENT_NAME}.*100점`) })).toBeVisible();
    });

    test("covers creation entry, student submission, teacher analytics, and statistics CSV", async ({ page }) => {
        await loginAsTeacher(page, "/create");
        await expect(page.getByText("스마트 에디터")).toBeVisible();
        await expect(page.getByRole("button", { name: "배포하기" })).toBeVisible();

        await seedExamAndStudent(page);
        await page.goto("/student/dashboard");
        await expect(page.getByRole("heading", { name: `${TEST_STUDENT_NAME}님,` })).toBeVisible();
        await expect(page.getByText(TEST_EXAM_TITLE)).toBeVisible();

        await page.getByRole("link", { name: "시작" }).click();
        await expect(page).toHaveURL(new RegExp(`/solve/${TEST_EXAM_ID}$`), { timeout: 15_000 });
        await ensureAnswerPaneVisible(page);

        await page.getByRole("radio", { name: "문제 1번 보기 2" }).click();
        await page.getByRole("radio", { name: "문제 2번 보기 3" }).click();
        await page.getByRole("radio", { name: "문제 3번 보기 1" }).click();
        await expect(page.getByText("모든 문제 표기 완료")).toBeVisible();

        await page.locator(".solve-submit-button").click();
        const confirmDialog = page.getByRole("dialog", { name: "답안 제출" });
        await expect(confirmDialog).toBeVisible();
        await confirmDialog.getByRole("button", { name: "제출하기" }).click();

        await expect(page).toHaveURL(/\/student\/review\/[^/?#]+$/, { timeout: 15_000 });
        await expect(page.getByText("결과 리포트", { exact: true })).toBeVisible();
        await expect(page.getByText(TEST_EXAM_TITLE)).toBeVisible();
        await expect(page.getByText("20 / 30점")).toBeVisible();

        const storedAttempts = await page.evaluate(() => JSON.parse(window.localStorage.getItem("omr_attempts") || "[]"));
        expect(storedAttempts).toHaveLength(1);
        expect(storedAttempts[0]).toMatchObject({
            examId: TEST_EXAM_ID,
            examTitle: TEST_EXAM_TITLE,
            studentName: TEST_STUDENT_NAME,
            studentId: TEST_STUDENT_ID,
            score: 20,
            totalScore: 30,
            status: "completed",
        });
        expect(storedAttempts[0].questionResults).toHaveLength(3);
        const expectedExamDate = await page.evaluate((examId) => {
            const exam = JSON.parse(window.localStorage.getItem(`omr_exam_${examId}`) || "null");
            return exam?.createdAt || "";
        }, TEST_EXAM_ID);

        await loginAsTeacher(page, "/teacher/dashboard");
        await expect(page.getByRole("heading", { name: "분석 센터" })).toBeVisible();
        await expect(page.getByText(TEST_EXAM_TITLE)).toBeVisible();
        await expect(page.getByRole("button", { name: "통계 CSV" })).toBeVisible();
        const dashboardRosterCount = await page.evaluate(() => (
            JSON.parse(localStorage.getItem("omr_students") || "[]").length
        ));

        const [download] = await Promise.all([
            page.waitForEvent("download"),
            page.getByRole("button", { name: "통계 CSV" }).click(),
        ]);
        expect(download.suggestedFilename()).toMatch(/^dashboard-stats-\d{4}-\d{2}-\d{2}\.csv$/);
        const csvPath = await download.path();
        expect(csvPath).toBeTruthy();
        const csvText = await readFile(csvPath!, "utf8");
        expect(csvText.charCodeAt(0)).toBe(0xfeff);
        const csvRows = parseCsvRows(csvText);
        expect(csvRows[0]).toEqual(["OMR Maker 통계 내보내기"]);
        expect(csvRows).toContainEqual(["요약 통계"]);
        expect(csvRows).toContainEqual(["전체 학생", String(dashboardRosterCount)]);
        expect(csvRows).toContainEqual(["평균 점수", "67"]);
        expect(csvRows).toContainEqual(["시험별 통계"]);
        expect(csvRows).toContainEqual(["완료", TEST_EXAM_TITLE, formatKoreanDate(expectedExamDate), "1", "1", "100", "0", "N"]);

        await page.getByRole("button", { name: "시험 분석", exact: true }).click();
        await page.getByRole("tab", { name: "학생·반" }).click();
        await expect(page.getByText("학생별 점수 및 성취도")).toBeVisible();
        const studentScoreRow = page.getByRole("row", { name: new RegExp(`${TEST_STUDENT_NAME}.*20점`) });
        await expect(studentScoreRow).toBeVisible();
        const correctionCsvButton = studentScoreRow.getByRole("button", { name: "정오표(CSV)" });
        await expect(correctionCsvButton).toBeVisible();

        const [correctionDownload] = await Promise.all([
            page.waitForEvent("download"),
            correctionCsvButton.click(),
        ]);
        expect(correctionDownload.suggestedFilename().normalize("NFC")).toBe(`${TEST_STUDENT_NAME}_${TEST_EXAM_TITLE}_분석.csv`);
        const correctionCsvPath = await correctionDownload.path();
        expect(correctionCsvPath).toBeTruthy();
        const correctionCsvText = await readFile(correctionCsvPath!, "utf8");
        expect(correctionCsvText.charCodeAt(0)).toBe(0xfeff);
        const correctionRows = parseCsvRows(correctionCsvText);
        expect(correctionRows[0]).toEqual(["문항 번호", "라벨(장르)", "배점", "학생 선택", "정답", "정오"]);
        expect(correctionRows).toContainEqual(["1", "문법", "10", "2", "2", "O"]);
        expect(correctionRows).toContainEqual(["2", "독해", "10", "3", "3", "O"]);
        expect(correctionRows).toContainEqual(["3", "어휘", "10", "1", "4", "X"]);
        expect(correctionRows).toContainEqual(["장르별 통계"]);
    });

    test("keeps the tablet solve rail usable for answer entry", async ({ page }) => {
        await seedExamAndStudent(page);
        await page.setViewportSize({ width: 820, height: 1180 });
        await page.goto(`/solve/${TEST_EXAM_ID}`);
        await continueSolveEntryIfPresent(page);

        const openRail = page.getByRole("button", { name: "답안지 펼치기 · 0/3 · 미답 3개" });
        await expect(openRail).toBeVisible();
        await openRail.click();
        await page.getByRole("radio", { name: "문제 1번 보기 2", exact: true }).click();
        await page.locator(".solve-omr-pane-close").click();
        await expect(page.getByRole("button", { name: "답안지 펼치기 · 1/3 · 미답 2개" })).toBeVisible();

        const hasBodyOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
        expect(hasBodyOverflow).toBe(false);
    });

    test("keeps the desktop solve OMR as a blurred overlay without shrinking the PDF", async ({ page }) => {
        await seedExamAndStudent(page);
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(`/solve/${TEST_EXAM_ID}`);
        await continueSolveEntryIfPresent(page);

        const openRail = page.getByRole("button", { name: "답안지 펼치기 · 0/3 · 미답 3개" });
        await expect(openRail).toBeVisible();
        await openRail.click();

        const layout = await page.evaluate(() => {
            const body = document.querySelector<HTMLElement>(".solve-body")?.getBoundingClientRect();
            const pdf = document.querySelector<HTMLElement>(".solve-pdf-pane")?.getBoundingClientRect();
            const paneElement = document.querySelector<HTMLElement>("#solve-omr-pane");
            const pane = paneElement?.getBoundingClientRect();
            const paneStyle = paneElement ? getComputedStyle(paneElement) : null;
            return body && pdf && pane ? {
                bodyWidth: body.width,
                pdfWidth: pdf.width,
                bodyRight: body.right,
                paneRight: pane.right,
                paneWidth: pane.width,
                panePosition: paneStyle?.position,
                paneBackdrop: paneStyle?.backdropFilter,
            } : null;
        });

        expect(layout).not.toBeNull();
        expect(Math.abs(layout!.bodyWidth - layout!.pdfWidth)).toBeLessThanOrEqual(2);
        expect(Math.abs(layout!.bodyRight - layout!.paneRight)).toBeLessThanOrEqual(24);
        expect(layout!.panePosition).toBe("absolute");
        expect(layout!.paneBackdrop).toContain("blur");
        expect(layout!.paneWidth).toBeGreaterThanOrEqual(300);
        expect(layout!.paneWidth).toBeLessThanOrEqual(380);
        expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)).toBe(false);
    });

    test("keeps tablet teacher analytics usable with real submission data", async ({ page }) => {
        await seedExamAndStudent(page);
        await seedCompletedAttempt(page);
        await page.setViewportSize({ width: 820, height: 1180 });

        await loginAsTeacher(page, "/teacher/dashboard?tab=exam");
        await expect(page.getByRole("heading", { name: "분석 센터" })).toBeVisible();
        await page.getByRole("tab", { name: "학생·반" }).click();
        await expect(page.getByText("학생별 점수 및 성취도")).toBeVisible();

        const studentScoreRow = page.getByRole("row", { name: new RegExp(`${TEST_STUDENT_NAME}.*20점`) });
        await expect(studentScoreRow).toBeVisible();
        const tableScroller = page.getByTestId("exam-analytics-student-table-scroll");
        await expect(tableScroller).toBeVisible();
        await expect(tableScroller).toHaveJSProperty("scrollLeft", 0);

        const tableMetrics = await tableScroller.evaluate(element => ({
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
        }));
        expect(tableMetrics.scrollWidth).toBeGreaterThanOrEqual(tableMetrics.clientWidth);

        await tableScroller.evaluate(element => {
            element.scrollLeft = element.scrollWidth;
        });
        await expect(studentScoreRow.getByRole("button", { name: "정오표(CSV)" })).toBeVisible();

        const hasBodyOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
        expect(hasBodyOverflow).toBe(false);
    });

    test("keeps tablet student history and review usable with real submission data", async ({ page }) => {
        await seedExamAndStudent(page);
        await seedCompletedAttempt(page);
        await page.setViewportSize({ width: 820, height: 1180 });

        await page.goto("/student/history");
        await expect(page.getByRole("heading", { name: "내 시험 기록" })).toBeVisible();
        await expect(page.getByText("원시험 응시")).toBeVisible();
        await expect(page.getByText("1회")).toBeVisible();

        const historyCard = page.locator('a[href="/student/review/attempt-tablet-analytics"]');
        await expect(historyCard).toBeVisible();
        await expect(historyCard).toContainText(TEST_EXAM_TITLE);
        await expect(historyCard).toContainText("67%");

        let hasBodyOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
        expect(hasBodyOverflow).toBe(false);

        await historyCard.click();
        await expect(page).toHaveURL(/\/student\/review\/attempt-tablet-analytics$/);
        await expect(page.getByText("결과 리포트", { exact: true })).toBeVisible();
        await expect(page.getByRole("heading", { name: TEST_EXAM_TITLE })).toBeVisible();
        await expect(page.getByText("20 / 30점")).toBeVisible();
        await expect(page.getByText("오답 재시험")).toBeVisible();
        await expect(page.getByRole("link", { name: "오답만" })).toBeVisible();
        await expect(page.getByText("유형 큐")).toBeVisible();

        hasBodyOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
        expect(hasBodyOverflow).toBe(false);
    });

    test("keeps the solve draft when a pending replay request cannot be stored", async ({ page }) => {
        await seedExamAndStudent(page);
        await page.goto(`/solve/${TEST_EXAM_ID}`);
        await ensureAnswerPaneVisible(page);
        await page.getByRole("radio", { name: "문제 1번 보기 2" }).click();
        await page.getByRole("radio", { name: "문제 2번 보기 3" }).click();
        await page.getByRole("radio", { name: "문제 3번 보기 1" }).click();
        await expect(page.getByText("모든 문제 표기 완료")).toBeVisible();

        await page.evaluate(() => {
            const prototype = Storage.prototype as Storage & {
                __omrOriginalSetItem?: Storage["setItem"];
            };
            prototype.__omrOriginalSetItem = prototype.setItem;
            prototype.setItem = function setItem(key: string, value: string) {
                if (key.startsWith("omr_student_submission_request_v2:")) {
                    throw new DOMException("quota", "QuotaExceededError");
                }
                return prototype.__omrOriginalSetItem!.call(this, key, value);
            };
        });
        let submitActionAborted = false;
        await page.route("**/*", async route => {
            const request = route.request();
            if (!submitActionAborted && request.method() === "POST" && request.headers()["next-action"]) {
                submitActionAborted = true;
                await route.abort("internetdisconnected");
                return;
            }
            await route.continue();
        });

        await page.locator(".solve-submit-button").click();
        const confirmDialog = page.getByRole("dialog", { name: "답안 제출" });
        await expect(confirmDialog).toBeVisible();
        await confirmDialog.getByRole("button", { name: "제출하기" }).click();

        await expect(page.getByText("제출 재시도 저장 실패")).toBeVisible();
        await expect(page).toHaveURL(new RegExp(`/solve/${TEST_EXAM_ID}$`));
        expect(submitActionAborted).toBe(true);
        const durableState = await page.evaluate((draftKey) => {
            const draft = JSON.parse(window.localStorage.getItem(draftKey) || "null");
            const attempts = JSON.parse(window.localStorage.getItem("omr_attempts") || "[]");
            const requestKeys = [...Array(window.localStorage.length)]
                .map((_, index) => window.localStorage.key(index))
                .filter(key => key?.startsWith("omr_student_submission_request_v2:"));
            return {
                draft,
                attemptCount: attempts.length,
                requestKeys,
            };
        }, `omr_draft_${TEST_EXAM_ID}_${TEST_STUDENT_ID}_base`);
        expect(durableState.draft).toMatchObject({
            submissionId: expect.any(String),
            answers: { 1: 2, 2: 3, 3: 1 },
        });
        expect(durableState.attemptCount).toBe(1);
        expect(durableState.requestKeys).toEqual([]);
    });

    test("reconciles manual and automatic submission receipt retries through the real server action", async ({ page }) => {
        await page.context().addInitScript(() => {
            Object.defineProperty(navigator, "locks", {
                configurable: true,
                value: undefined,
            });
        });
        await seedStudentRoster(page);
        await loginAsStudent(page);
        await seedExamAndStudent(page);
        await seedCompletedAttempt(page);
        const confirmedAttemptId = "attempt-tablet-analytics";

        await page.evaluate(({ id, entryKey }) => {
            window.localStorage.setItem(entryKey, JSON.stringify({
                version: 2,
                revision: 1,
                receipt: {
                    attemptId: id,
                    status: "confirmed",
                    updatedAt: "2026-07-28T00:00:00.000Z",
                },
            }));
        }, { id: confirmedAttemptId, entryKey: submissionReceiptEntryKey(confirmedAttemptId) });
        await page.goto(`/student/review/${confirmedAttemptId}`);
        await expect(page.getByRole("status")).toHaveText("서버 반영 완료");
        await page.reload();
        await expect(page.getByRole("status")).toHaveText("서버 반영 완료");

        const attemptId = "attempt-manual-local";
        await page.evaluate(({ sourceId, localId }) => {
            const attempts = JSON.parse(window.localStorage.getItem("omr_attempts") || "[]");
            const source = attempts.find((attempt: { id?: string }) => attempt.id === sourceId);
            if (!source) throw new Error("manual source attempt missing");
            window.localStorage.setItem("omr_attempts", JSON.stringify([
                ...attempts,
                {
                    ...source,
                    id: localId,
                    localSubmissionProvenance: undefined,
                    finishedAt: new Date(Date.now() + 500).toISOString(),
                    questionResults: (source.questionResults || []).map((result: object) => ({
                        ...result,
                        attemptId: localId,
                    })),
                },
            ]));
        }, { sourceId: confirmedAttemptId, localId: attemptId });
        await page.evaluate(({ id, entryKey }) => {
            window.localStorage.setItem(entryKey, JSON.stringify({
                version: 2,
                revision: 2,
                receipt: {
                    attemptId: id,
                    status: "local_only",
                    updatedAt: "2026-07-28T00:00:30.000Z",
                },
            }));
        }, { id: attemptId, entryKey: submissionReceiptEntryKey(attemptId) });
        await page.goto(`/student/review/${attemptId}`);
        await expect(page.getByRole("status")).toHaveText("이 기기에만 저장됨");
        await expect(page.getByText("다른 기기에서는 이 결과를 볼 수 없습니다.")).toBeVisible();
        const crossTab = await page.context().newPage();
        await crossTab.goto(`/student/review/${attemptId}`);
        await expect(crossTab.getByRole("status")).toHaveText("이 기기에만 저장됨");

        await page.evaluate(({ id, entryKey, requestKey }) => {
            const input = {
                examId: "e2e-korean-integrated-exam",
                submissionId: "11111111-1111-4111-8111-111111111111",
                answers: { 1: 2, 2: 3, 3: 1 },
                startedAt: "2026-07-28T00:00:00.000Z",
            };
            window.localStorage.setItem(entryKey, JSON.stringify({
                version: 2,
                revision: 3,
                receipt: {
                    attemptId: id,
                    status: "pending",
                    updatedAt: "2026-07-28T00:01:00.000Z",
                },
            }));
            window.localStorage.setItem(requestKey, JSON.stringify({
                version: 2,
                revision: 1,
                request: { attemptId: id, input },
            }));
            window.dispatchEvent(new StorageEvent("storage", {
                key: entryKey,
            }));
            (window as typeof window & { receiptRetryNoReload?: string }).receiptRetryNoReload = "manual";
        }, {
            id: attemptId,
            entryKey: submissionReceiptEntryKey(attemptId),
            requestKey: submissionRequestEntryKey(attemptId),
        });
        await expect(page.getByRole("status")).toHaveText("서버 반영 대기 · 자동 재시도");
        await expect(crossTab.getByRole("status")).toHaveText("서버 반영 대기 · 자동 재시도");
        const retry = page.getByRole("button", { name: "지금 다시 시도" });
        const crossTabRetry = crossTab.getByRole("button", { name: "지금 다시 시도" });
        await expect(retry).toBeVisible();
        await expect(crossTabRetry).toBeVisible();
        expect(await page.evaluate(() => navigator.locks)).toBeUndefined();
        expect(await crossTab.evaluate(() => navigator.locks)).toBeUndefined();
        let retryActionRequests = 0;
        const countRetryAction = (request: {
            method(): string;
            headers(): Record<string, string>;
            postData(): string | null;
        }) => {
            if (
                request.method() === "POST"
                && request.headers()["next-action"]
                && request.postData()?.includes("11111111-1111-4111-8111-111111111111")
            ) {
                retryActionRequests += 1;
            }
        };
        page.on("request", countRetryAction);
        crossTab.on("request", countRetryAction);
        await Promise.all([
            retry.dispatchEvent("click"),
            crossTabRetry.dispatchEvent("click"),
        ]);
        await expect(page.getByRole("status")).toHaveText("서버 반영 완료");
        await expect(page).not.toHaveURL(new RegExp(`/student/review/${attemptId}$`));
        const manualCanonicalId = new URL(page.url()).pathname.split("/").pop() || "";
        expect(manualCanonicalId).not.toBe(attemptId);
        await expect(crossTab).toHaveURL(new RegExp(`/student/review/${manualCanonicalId}$`));
        await expect(crossTab.getByRole("status")).toHaveText("서버 반영 완료");
        expect(retryActionRequests).toBe(1);
        await crossTab.close();
        expect(await page.evaluate(() => (
            (window as typeof window & { receiptRetryNoReload?: string }).receiptRetryNoReload
        ))).toBe("manual");
        await expect(page.getByText("20 / 30점")).toBeVisible();
        const manualState = await page.evaluate(({ oldId, canonicalId, oldEntryKey, oldRequestKey, canonicalEntryKey, aliasKey }) => {
            const attempts = JSON.parse(window.localStorage.getItem("omr_attempts") || "[]");
            const canonicalEnvelope = JSON.parse(window.localStorage.getItem(canonicalEntryKey) || "null");
            const aliasEnvelope = JSON.parse(window.localStorage.getItem(aliasKey) || "null");
            return {
                oldReceipt: window.localStorage.getItem(oldEntryKey),
                oldRequest: window.localStorage.getItem(oldRequestKey),
                canonicalReceipt: canonicalEnvelope?.receipt,
                reconciliation: aliasEnvelope?.canonicalAttemptId,
                cachedOld: attempts.some((attempt: { id?: string }) => attempt.id === oldId),
                canonicalCount: attempts.filter((attempt: { id?: string }) => attempt.id === canonicalId).length,
            };
        }, {
            oldId: attemptId,
            canonicalId: manualCanonicalId,
            oldEntryKey: submissionReceiptEntryKey(attemptId),
            oldRequestKey: submissionRequestEntryKey(attemptId),
            canonicalEntryKey: submissionReceiptEntryKey(manualCanonicalId),
            aliasKey: submissionAliasEntryKey(attemptId),
        });
        expect(manualState).toEqual({
            oldReceipt: null,
            oldRequest: null,
            canonicalReceipt: expect.objectContaining({ status: "confirmed" }),
            reconciliation: manualCanonicalId,
            cachedOld: false,
            canonicalCount: 1,
        });

        const automaticLocalId = "attempt-auto-local";
        await page.evaluate(({ sourceId, autoId }) => {
            const attempts = JSON.parse(window.localStorage.getItem("omr_attempts") || "[]");
            const source = attempts.find((attempt: { id?: string }) => attempt.id === sourceId);
            if (!source) throw new Error("source attempt missing");
            const finishedAt = new Date(Date.now() + 1_000).toISOString();
            const automatic = {
                ...source,
                id: autoId,
                localSubmissionProvenance: undefined,
                finishedAt,
                questionResults: (source.questionResults || []).map((result: object) => ({
                    ...result,
                    attemptId: autoId,
                    finishedAt,
                })),
            };
            window.localStorage.setItem("omr_attempts", JSON.stringify([...attempts, automatic]));
        }, { sourceId: manualCanonicalId, autoId: automaticLocalId });
        await page.goto(`/student/review/${automaticLocalId}`);
        await expect(page.getByRole("status")).toHaveText("이 기기에만 저장됨");

        await page.evaluate(({ id, entryKey, requestKey }) => {
            window.localStorage.setItem(entryKey, JSON.stringify({
                version: 2,
                revision: 2,
                receipt: {
                    attemptId: id,
                    status: "pending",
                    updatedAt: "2026-07-28T00:03:00.000Z",
                },
            }));
            window.localStorage.setItem(requestKey, JSON.stringify({
                version: 2,
                revision: 1,
                request: {
                    attemptId: id,
                    input: {
                    examId: "e2e-korean-integrated-exam",
                    submissionId: "22222222-2222-4222-8222-222222222222",
                    answers: { 1: 2, 2: 3, 3: 1 },
                    startedAt: "2026-07-28T00:00:00.000Z",
                    },
                },
            }));
            window.dispatchEvent(new StorageEvent("storage", {
                key: entryKey,
            }));
            (window as typeof window & { receiptRetryNoReload?: string }).receiptRetryNoReload = "automatic";
        }, {
            id: automaticLocalId,
            entryKey: submissionReceiptEntryKey(automaticLocalId),
            requestKey: submissionRequestEntryKey(automaticLocalId),
        });
        await expect(page.getByRole("status")).toHaveText("서버 반영 대기 · 자동 재시도");
        await page.evaluate(() => window.dispatchEvent(new Event("online")));
        await expect(page.getByRole("status")).toHaveText("서버 반영 완료");
        await expect(page).not.toHaveURL(new RegExp(`/student/review/${automaticLocalId}$`));
        const automaticCanonicalId = new URL(page.url()).pathname.split("/").pop() || "";
        expect(automaticCanonicalId).not.toBe(automaticLocalId);
        expect(await page.evaluate(() => (
            (window as typeof window & { receiptRetryNoReload?: string }).receiptRetryNoReload
        ))).toBe("automatic");
        const automaticState = await page.evaluate(({ oldId, canonicalId, oldEntryKey, oldRequestKey, canonicalEntryKey, aliasKey }) => {
            const attempts = JSON.parse(window.localStorage.getItem("omr_attempts") || "[]");
            const canonicalEnvelope = JSON.parse(window.localStorage.getItem(canonicalEntryKey) || "null");
            const aliasEnvelope = JSON.parse(window.localStorage.getItem(aliasKey) || "null");
            return {
                oldReceipt: window.localStorage.getItem(oldEntryKey),
                oldRequest: window.localStorage.getItem(oldRequestKey),
                canonicalReceipt: canonicalEnvelope?.receipt,
                reconciliation: aliasEnvelope?.canonicalAttemptId,
                cachedOld: attempts.some((attempt: { id?: string }) => attempt.id === oldId),
                canonicalCount: attempts.filter((attempt: { id?: string }) => attempt.id === canonicalId).length,
            };
        }, {
            oldId: automaticLocalId,
            canonicalId: automaticCanonicalId,
            oldEntryKey: submissionReceiptEntryKey(automaticLocalId),
            oldRequestKey: submissionRequestEntryKey(automaticLocalId),
            canonicalEntryKey: submissionReceiptEntryKey(automaticCanonicalId),
            aliasKey: submissionAliasEntryKey(automaticLocalId),
        });
        expect(automaticState).toEqual({
            oldReceipt: null,
            oldRequest: null,
            canonicalReceipt: expect.objectContaining({ status: "confirmed" }),
            reconciliation: automaticCanonicalId,
            cachedOld: false,
            canonicalCount: 1,
        });

        const pinLocalId = "attempt-pin-local";
        await page.evaluate(({ sourceId, localId, entryKey, requestKey }) => {
            const attempts = JSON.parse(window.localStorage.getItem("omr_attempts") || "[]");
            const source = attempts.find((attempt: { id?: string }) => attempt.id === sourceId);
            if (!source) throw new Error("PIN source attempt missing");
            const pendingPinAttempt = {
                ...source,
                id: localId,
                localSubmissionProvenance: undefined,
                finishedAt: new Date(Date.now() + 2_000).toISOString(),
                questionResults: (source.questionResults || []).map((result: object) => ({
                    ...result,
                    attemptId: localId,
                })),
            };
            window.localStorage.setItem("omr_attempts", JSON.stringify([...attempts, pendingPinAttempt]));
            window.localStorage.setItem(entryKey, JSON.stringify({
                version: 2,
                revision: 1,
                receipt: {
                    attemptId: localId,
                    status: "pending",
                    updatedAt: "2026-07-28T00:04:00.000Z",
                    requiresPin: true,
                    retryMode: "manual",
                    prerequisite: "pin",
                },
            }));
            window.localStorage.setItem(requestKey, JSON.stringify({
                version: 2,
                revision: 1,
                request: {
                    attemptId: localId,
                    requiresPin: true,
                    input: {
                        examId: "e2e-korean-integrated-exam",
                        submissionId: "33333333-3333-4333-8333-333333333333",
                        answers: { 1: 2, 2: 3, 3: 1 },
                        startedAt: "2026-07-28T00:00:00.000Z",
                    },
                },
            }));
        }, {
            sourceId: automaticCanonicalId,
            localId: pinLocalId,
            entryKey: submissionReceiptEntryKey(pinLocalId),
            requestKey: submissionRequestEntryKey(pinLocalId),
        });
        await page.goto(`/student/review/${pinLocalId}`);
        await expect(page.getByRole("status")).toHaveText("서버 반영 대기 · PIN 입력 필요");
        await expect(page.getByText("자동 재시도하지 않습니다. 시험 PIN을 입력한 뒤 직접 다시 시도해주세요.")).toBeVisible();
        await page.evaluate(() => window.dispatchEvent(new Event("online")));
        await page.waitForTimeout(250);
        await expect(page).toHaveURL(new RegExp(`/student/review/${pinLocalId}$`));
        const pinRetry = page.getByRole("button", { name: "지금 다시 시도" });
        await expect(pinRetry).toBeDisabled();
        let abortedPinRetry = false;
        await page.route("**/*", async route => {
            const request = route.request();
            if (
                !abortedPinRetry
                && request.method() === "POST"
                && !!request.headers()["next-action"]
            ) {
                abortedPinRetry = true;
                await route.abort("failed");
                return;
            }
            await route.continue();
        });
        await page.getByLabel("시험 PIN").fill("1111");
        await expect(pinRetry).toBeEnabled();
        await pinRetry.click();
        await expect.poll(() => abortedPinRetry).toBe(true);
        await expect(page.getByRole("status")).toHaveText("서버 반영 대기 · PIN 입력 필요");
        await expect(page.getByLabel("시험 PIN")).toBeVisible();
        const retainedPinState = await page.evaluate(({ entryKey, requestKey }) => {
            const receipt = JSON.parse(window.localStorage.getItem(entryKey) || "null")?.receipt;
            const request = JSON.parse(window.localStorage.getItem(requestKey) || "null")?.request;
            return {
                status: receipt?.status,
                requiresPin: receipt?.requiresPin,
                retryMode: receipt?.retryMode,
                prerequisite: receipt?.prerequisite,
                requestRequiresPin: request?.requiresPin,
                hasRequest: !!request,
            };
        }, {
            entryKey: submissionReceiptEntryKey(pinLocalId),
            requestKey: submissionRequestEntryKey(pinLocalId),
        });
        expect(retainedPinState).toEqual({
            status: "pending",
            requiresPin: true,
            retryMode: "manual",
            prerequisite: "pin",
            requestRequiresPin: true,
            hasRequest: true,
        });
        await page.evaluate(() => window.dispatchEvent(new Event("online")));
        await page.waitForTimeout(250);
        await expect(page).toHaveURL(new RegExp(`/student/review/${pinLocalId}$`));
        await expect(page.getByRole("status")).toHaveText("서버 반영 대기 · PIN 입력 필요");

        await page.unroute("**/*");
        await page.getByLabel("시험 PIN").fill("2468");
        expect(await page.evaluate(() => JSON.stringify(window.localStorage))).not.toContain("2468");
        await pinRetry.click();
        await expect(page.getByRole("status")).toHaveText("서버 반영 완료");
        await expect(page).not.toHaveURL(new RegExp(`/student/review/${pinLocalId}$`));
        const pinCanonicalId = new URL(page.url()).pathname.split("/").pop() || "";
        expect(await page.evaluate(() => (
            [...Array(window.localStorage.length)]
                .map((_, index) => window.localStorage.getItem(window.localStorage.key(index) || "") || "")
                .join("")
        ))).not.toContain("2468");

        const loginLocalId = "attempt-login-local";
        const loginAction = "학생 계정으로 다시 로그인하면 서버 반영을 자동으로 다시 시도합니다.";
        await page.evaluate(({ sourceId, localId }) => {
            const attempts = JSON.parse(window.localStorage.getItem("omr_attempts") || "[]");
            const source = attempts.find((attempt: { id?: string }) => attempt.id === sourceId);
            if (!source) throw new Error("login source attempt missing");
            window.localStorage.setItem("omr_attempts", JSON.stringify([
                ...attempts,
                {
                    ...source,
                    id: localId,
                    localSubmissionProvenance: undefined,
                    finishedAt: new Date(Date.now() + 3_000).toISOString(),
                    questionResults: (source.questionResults || []).map((result: object) => ({
                        ...result,
                        attemptId: localId,
                    })),
                },
            ]));
        }, {
            sourceId: pinCanonicalId,
            localId: loginLocalId,
        });
        await page.goto(`/student/review/${loginLocalId}`);
        await expect(page.getByRole("status")).toHaveText("이 기기에만 저장됨");
        await page.evaluate(({ localId, entryKey, requestKey, actionDetail }) => {
            window.sessionStorage.setItem("omr_student_session_generation", "blocked-login-generation");
            window.localStorage.setItem(entryKey, JSON.stringify({
                version: 2,
                revision: 1,
                receipt: {
                    attemptId: localId,
                    status: "pending",
                    updatedAt: "2026-07-28T00:05:00.000Z",
                    reason: "login_required",
                    actionDetail,
                    retryMode: "manual",
                    prerequisite: "login",
                    blockedSessionGeneration: "blocked-login-generation",
                },
            }));
            window.localStorage.setItem(requestKey, JSON.stringify({
                version: 2,
                revision: 1,
                request: {
                    attemptId: localId,
                    input: {
                        examId: "e2e-korean-integrated-exam",
                        submissionId: "44444444-4444-4444-8444-444444444444",
                        answers: { 1: 2, 2: 3, 3: 1 },
                        startedAt: "2026-07-28T00:00:00.000Z",
                    },
                },
            }));
            window.dispatchEvent(new StorageEvent("storage", { key: entryKey }));
        }, {
            localId: loginLocalId,
            entryKey: submissionReceiptEntryKey(loginLocalId),
            requestKey: submissionRequestEntryKey(loginLocalId),
            actionDetail: loginAction,
        });
        await expect(page.getByRole("status")).toHaveText("서버 반영 대기 · 로그인 필요");
        await expect(page.getByText(loginAction)).toBeVisible();
        await expect(page.getByRole("link", { name: "학생 로그인으로 이동" })).toBeVisible();
        await page.evaluate(() => window.dispatchEvent(new Event("online")));
        await page.waitForTimeout(250);
        await expect(page).toHaveURL(new RegExp(`/student/review/${loginLocalId}$`));
        await page.evaluate(() => {
            window.sessionStorage.setItem("omr_student_session_generation", "restored-login-generation");
            window.dispatchEvent(new Event("omr:student-session-changed"));
        });
        await expect(page.getByRole("status")).toHaveText("서버 반영 완료");
        await expect(page).not.toHaveURL(new RegExp(`/student/review/${loginLocalId}$`));
        const loginCanonicalId = new URL(page.url()).pathname.split("/").pop() || "";

        const notStartedLocalId = "attempt-not-started-local";
        const notStartedAction = "온라인 전환 또는 화면 복귀 시 다시 시도합니다.";
        await page.evaluate(({ sourceId, localId }) => {
            const attempts = JSON.parse(window.localStorage.getItem("omr_attempts") || "[]");
            const source = attempts.find((attempt: { id?: string }) => attempt.id === sourceId);
            if (!source) throw new Error("not-started source attempt missing");
            window.localStorage.setItem("omr_attempts", JSON.stringify([
                ...attempts,
                {
                    ...source,
                    id: localId,
                    localSubmissionProvenance: undefined,
                    finishedAt: new Date(Date.now() + 4_000).toISOString(),
                    questionResults: (source.questionResults || []).map((result: object) => ({
                        ...result,
                        attemptId: localId,
                    })),
                },
            ]));
        }, { sourceId: loginCanonicalId, localId: notStartedLocalId });
        await page.goto(`/student/review/${notStartedLocalId}`);
        await expect(page.getByRole("status")).toHaveText("이 기기에만 저장됨");
        await page.evaluate(({ localId, entryKey, requestKey, actionDetail }) => {
            window.localStorage.setItem(entryKey, JSON.stringify({
                version: 2,
                revision: 1,
                receipt: {
                    attemptId: localId,
                    status: "pending",
                    updatedAt: "2026-07-28T00:06:00.000Z",
                    reason: "not_started",
                    actionDetail,
                    retryMode: "automatic",
                    prerequisite: "exam_start",
                },
            }));
            window.localStorage.setItem(requestKey, JSON.stringify({
                version: 2,
                revision: 1,
                request: {
                    attemptId: localId,
                    input: {
                        examId: "e2e-korean-integrated-exam",
                        submissionId: "55555555-5555-4555-8555-555555555555",
                        answers: { 1: 2, 2: 3, 3: 1 },
                        startedAt: "2026-07-28T00:00:00.000Z",
                    },
                },
            }));
            window.dispatchEvent(new StorageEvent("storage", { key: entryKey }));
        }, {
            localId: notStartedLocalId,
            entryKey: submissionReceiptEntryKey(notStartedLocalId),
            requestKey: submissionRequestEntryKey(notStartedLocalId),
            actionDetail: notStartedAction,
        });
        await expect(page.getByRole("status")).toHaveText("서버 반영 대기 · 시험 시작 전");
        await expect(page.getByText(notStartedAction)).toBeVisible();
        await page.getByRole("button", { name: "지금 다시 시도" }).click();
        await expect(page.getByRole("status")).toHaveText("서버 반영 완료");
        const notStartedCanonicalId = new URL(page.url()).pathname.split("/").pop() || "";

        const prunedReceiptLocalId = "attempt-pruned-confirmed";
        await page.evaluate(({ sourceId, localId }) => {
            const attempts = JSON.parse(window.localStorage.getItem("omr_attempts") || "[]");
            const source = attempts.find((attempt: { id?: string }) => attempt.id === sourceId);
            if (!source?.localSubmissionProvenance) throw new Error("confirmed provenance missing");
            window.localStorage.setItem("omr_attempts", JSON.stringify([
                ...attempts,
                {
                    ...source,
                    id: localId,
                    finishedAt: new Date(Date.now() + 5_000).toISOString(),
                    questionResults: (source.questionResults || []).map((result: object) => ({
                        ...result,
                        attemptId: localId,
                    })),
                },
            ]));
            window.localStorage.removeItem(`omr_student_submission_receipt_v2:${encodeURIComponent(localId)}`);
        }, { sourceId: notStartedCanonicalId, localId: prunedReceiptLocalId });
        await page.goto(`/student/review/${prunedReceiptLocalId}`);
        await expect(page.getByRole("status")).toHaveText("서버 반영 완료");

        await page.evaluate(() => {
            window.localStorage.removeItem("omr_student_submission_receipts_v2_migrated");
            window.localStorage.setItem(
                "omr_student_submission_receipts_v1",
                '{"requests":{"attempt-one":{"pin":"BROWSER-SECRET-2468"',
            );
        });
        await page.reload();
        await expect(page.getByRole("status")).toHaveText("서버 반영 완료");
        const quarantineMetadata = await page.evaluate(() => (
            [...Array(window.localStorage.length)]
                .flatMap((_, index) => {
                    const key = window.localStorage.key(index) || "";
                    if (!key.startsWith("omr_student_submission_quarantine_v2:")) return [];
                    return [window.localStorage.getItem(key) || ""];
                })
                .join("")
        ));
        expect(quarantineMetadata).not.toContain("BROWSER-SECRET-2468");
        expect(quarantineMetadata).toContain("byteLength");
        await expect.poll(async () => page.evaluate(() => (
            [...Array(window.localStorage.length)]
                .map((_, index) => window.localStorage.getItem(window.localStorage.key(index) || "") || "")
                .join("")
                .includes("BROWSER-SECRET-2468")
        )), { timeout: 8_000 }).toBe(false);

        await page.goto("/student/history");
        await expect(page.getByRole("heading", { name: "내 시험 기록" })).toBeVisible();
        await expect(page.locator(`a[href="/student/review/${attemptId}"]`)).toHaveCount(0);
        await expect(page.locator(`a[href="/student/review/${automaticLocalId}"]`)).toHaveCount(0);
        await expect(page.locator(`a[href="/student/review/${manualCanonicalId}"]`)).toHaveCount(1);
        await expect(page.locator(`a[href="/student/review/${automaticCanonicalId}"]`)).toHaveCount(1);
    });
});
