import { test, expect, type Page } from "@playwright/test";
import { loginAsTeacher, resetBrowserState } from "./helpers";

const TEST_EXAM_ID = "e2e-korean-integrated-exam";
const TEST_EXAM_TITLE = "E2E 국어 통합 시험";
const TEST_GROUP_ID = "class-a";
const TEST_GROUP_NAME = "A반";
const TEST_STUDENT_ID = `${TEST_GROUP_ID}::김학생`;
const TEST_STUDENT_NAME = "김학생";

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

test.describe("Teacher and student full journey", () => {
    test.beforeEach(async ({ page, context }) => {
        await resetBrowserState(page, context);
    });

    test("covers creation entry, student submission, teacher analytics, and statistics CSV", async ({ page }) => {
        await loginAsTeacher(page, "/create");
        await expect(page.getByText("Smart Editor")).toBeVisible();
        await expect(page.getByRole("button", { name: "배포하기" })).toBeVisible();

        await seedExamAndStudent(page);
        await page.goto("/student/dashboard");
        await expect(page.getByRole("heading", { name: `${TEST_STUDENT_NAME}님,` })).toBeVisible();
        await expect(page.getByText(TEST_EXAM_TITLE)).toBeVisible();

        await page.getByRole("link", { name: "시작" }).click();
        await expect(page).toHaveURL(new RegExp(`/solve/${TEST_EXAM_ID}$`));
        await expect(page.getByText("OMR 답안")).toBeVisible();

        await page.getByRole("button", { name: "문제 1번 보기 2" }).click();
        await page.getByRole("button", { name: "문제 2번 보기 3" }).click();
        await page.getByRole("button", { name: "문제 3번 보기 1" }).click();
        await expect(page.getByText("모든 문제 표기 완료")).toBeVisible();

        await page.locator(".solve-submit-button").click();
        const confirmDialog = page.getByRole("dialog", { name: "답안 제출" });
        await expect(confirmDialog).toBeVisible();
        await confirmDialog.getByRole("button", { name: "제출하기" }).click();

        await expect(page).toHaveURL(/\/student\/review\/\d+$/);
        await expect(page.getByText("결과 리포트")).toBeVisible();
        await expect(page.getByText(TEST_EXAM_TITLE)).toBeVisible();
        await expect(page.getByText("20 / 30 점")).toBeVisible();

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
        await expect(page.getByRole("heading", { name: "Analytics Center" })).toBeVisible();
        await expect(page.getByText(TEST_EXAM_TITLE)).toBeVisible();
        await expect(page.getByRole("button", { name: "통계 CSV" })).toBeVisible();

        const [download] = await Promise.all([
            page.waitForEvent("download"),
            page.getByRole("button", { name: "통계 CSV" }).click(),
        ]);
        expect(download.suggestedFilename()).toMatch(/^dashboard-stats-\d{4}-\d{2}-\d{2}\.csv$/);

        await page.getByRole("button", { name: "시험 분석", exact: true }).click();
        await expect(page.getByText("학생별 점수 및 성취도")).toBeVisible();
        const studentScoreRow = page.getByRole("row", { name: new RegExp(`${TEST_STUDENT_NAME}.*20점`) });
        await expect(studentScoreRow).toBeVisible();
        await expect(studentScoreRow.getByRole("button", { name: "정오표(CSV)" })).toBeVisible();
    });

    test("keeps the tablet solve rail usable for answer entry", async ({ page }) => {
        await seedExamAndStudent(page);
        await page.setViewportSize({ width: 820, height: 1180 });
        await page.goto(`/solve/${TEST_EXAM_ID}`);

        await expect(page.getByRole("button", { name: "답안지 펼치기 · 0/3 · 미답 3개" })).toBeVisible();
        await page.getByRole("button", { name: "1번 보기 2", exact: true }).click();
        await expect(page.getByRole("button", { name: "답안지 펼치기 · 1/3 · 미답 2개" })).toBeVisible();

        const hasBodyOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
        expect(hasBodyOverflow).toBe(false);
    });
});
