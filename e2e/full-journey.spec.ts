import { readFile } from "node:fs/promises";
import { test, expect, type Page } from "@playwright/test";
import { continueSolveEntryIfPresent, loginAsTeacher, resetBrowserState } from "./helpers";
import { parseCsvRows } from "../src/lib/csv";

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
            startedAt: "2026-06-19T00:00:00.000Z",
            finishedAt: "2026-06-19T00:10:00.000Z",
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

async function seedExamAndStudent(page: Page) {
    await page.evaluate((seed) => {
        const now = "2026-06-19T00:00:00.000Z";
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
        const finishedAt = "2026-06-19T00:20:00.000Z";
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
            startedAt: "2026-06-19T00:00:00.000Z",
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
        await expect(page).toHaveURL(new RegExp(`/solve/${TEST_EXAM_ID}$`));
        await ensureAnswerPaneVisible(page);

        await page.getByRole("radio", { name: "문제 1번 보기 2" }).click();
        await page.getByRole("radio", { name: "문제 2번 보기 3" }).click();
        await page.getByRole("radio", { name: "문제 3번 보기 1" }).click();
        await expect(page.getByText("모든 문제 표기 완료")).toBeVisible();

        await page.locator(".solve-submit-button").click();
        const confirmDialog = page.getByRole("dialog", { name: "답안 제출" });
        await expect(confirmDialog).toBeVisible();
        await confirmDialog.getByRole("button", { name: "제출하기" }).click();

        await expect(page).toHaveURL(/\/student\/review\/[^/?#]+$/);
        await expect(page.getByText("결과 리포트")).toBeVisible();
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
        await expect(page.getByText("학생별 점수 및 성취도")).toBeVisible();
        await expect(page.getByRole("row", { name: new RegExp(`${TEST_STUDENT_NAME}.*20점`) })).toBeVisible();
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
        await expect(page.getByText(CREATED_EXAM_TITLE)).toBeVisible();

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
        await expect(page.getByText("결과 리포트")).toBeVisible();
        await expect(page.getByText(CREATED_EXAM_TITLE)).toBeVisible();
        await expect(page.getByText("100 / 100점")).toBeVisible();

        await loginAsTeacher(page, "/teacher/dashboard");
        await expect(page.getByRole("heading", { name: "분석 센터" })).toBeVisible();
        await expect(page.getByText(CREATED_EXAM_TITLE)).toBeVisible();
        await expect(page.getByRole("button", { name: "통계 CSV" })).toBeVisible();

        await page.getByRole("button", { name: "시험 분석", exact: true }).click();
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
        await expect(page).toHaveURL(new RegExp(`/solve/${TEST_EXAM_ID}$`));
        await ensureAnswerPaneVisible(page);

        await page.getByRole("radio", { name: "문제 1번 보기 2" }).click();
        await page.getByRole("radio", { name: "문제 2번 보기 3" }).click();
        await page.getByRole("radio", { name: "문제 3번 보기 1" }).click();
        await expect(page.getByText("모든 문제 표기 완료")).toBeVisible();

        await page.locator(".solve-submit-button").click();
        const confirmDialog = page.getByRole("dialog", { name: "답안 제출" });
        await expect(confirmDialog).toBeVisible();
        await confirmDialog.getByRole("button", { name: "제출하기" }).click();

        await expect(page).toHaveURL(/\/student\/review\/[^/?#]+$/);
        await expect(page.getByText("결과 리포트")).toBeVisible();
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

        await loginAsTeacher(page, "/teacher/dashboard");
        await expect(page.getByRole("heading", { name: "분석 센터" })).toBeVisible();
        await expect(page.getByText(TEST_EXAM_TITLE)).toBeVisible();
        await expect(page.getByRole("button", { name: "통계 CSV" })).toBeVisible();

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
        expect(csvRows).toContainEqual(["전체 학생", "1"]);
        expect(csvRows).toContainEqual(["평균 점수", "67"]);
        expect(csvRows).toContainEqual(["시험별 통계"]);
        expect(csvRows).toContainEqual(["완료", TEST_EXAM_TITLE, "2026. 6. 19.", "1", "1", "100", "0", "N"]);

        await page.getByRole("button", { name: "시험 분석", exact: true }).click();
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
        expect(Math.abs(layout!.bodyRight - layout!.paneRight)).toBeLessThanOrEqual(18);
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
        expect(tableMetrics.scrollWidth).toBeGreaterThan(tableMetrics.clientWidth);

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
        await expect(page.getByText("결과 리포트")).toBeVisible();
        await expect(page.getByRole("heading", { name: TEST_EXAM_TITLE })).toBeVisible();
        await expect(page.getByText("20 / 30점")).toBeVisible();
        await expect(page.getByText("오답 재시험")).toBeVisible();
        await expect(page.getByRole("link", { name: "오답만" })).toBeVisible();
        await expect(page.getByText("유형 큐")).toBeVisible();

        hasBodyOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
        expect(hasBodyOverflow).toBe(false);
    });
});
