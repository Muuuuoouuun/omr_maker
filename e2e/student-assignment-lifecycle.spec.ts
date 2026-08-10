import { expect, test, type Page } from "@playwright/test";
import { resetBrowserState } from "./helpers";

const hostedMode = process.env.OMR_ASSIGNMENT_LIFECYCLE_HOSTED_MODE === "1";
const STUDENT_ID = "assignment-lifecycle-student";

async function seedLifecycleDashboard(page: Page) {
    await page.addInitScript(({ studentId }) => {
        const session = {
            studentId,
            loginId: `guest-${studentId}`,
            name: "생명주기 학생",
            groupId: "assignment-lifecycle-group",
            groupName: "생명주기반",
            isGuest: true,
            guestId: studentId,
            identityType: "guest",
        };
        const observedAt = Date.now();
        const instant = (offsetMs: number) => new Date(observedAt + offsetMs).toISOString();
        const exam = (
            id: string,
            startAt: string,
            endAt: string,
            archived = false,
        ) => ({
            id,
            title: `${id} 시험`,
            createdAt: instant(-120_000),
            startAt,
            endAt,
            archived,
            durationMin: 30,
            accessConfig: { type: "public", groupIds: [] },
            questions: [{ id: 1, number: 1, answer: 1, choices: 5, score: 10 }],
        });
        const exams = [
            exam("one-second-before-start", instant(60_000), instant(120_000)),
            exam("at-start-boundary", instant(-60_000), instant(60_000)),
            exam("one-second-before-end", instant(-60_000), instant(60_000)),
            exam("at-end-boundary", instant(-120_000), instant(0)),
            exam("archived-closed", instant(-120_000), instant(60_000), true),
            exam("malformed-lifecycle", "not-a-time", instant(60_000)),
            exam("completed-closed", instant(-120_000), instant(0)),
            exam("completed-open", instant(-60_000), instant(60_000)),
        ];
        const completed = ["completed-closed", "completed-open", "omitted-archived"].map((examId, index) => ({
            id: `attempt-${index + 1}`,
            examId,
            examTitle: examId === "omitted-archived" ? "목록에서 제외된 보관 시험" : `${examId} 시험`,
            studentName: session.name,
            studentId,
            guestId: studentId,
            identityType: "guest",
            status: "completed",
            score: 10,
            totalScore: 10,
            startedAt: instant(-120_000),
            finishedAt: instant(-90_000 + index),
            answers: { 1: 1 },
            retakeSourceAttemptId: undefined as string | undefined,
            retake: undefined as {
                sourceAttemptId: string;
                questionIds: number[];
                mode: "wrong";
                createdAt: string;
            } | undefined,
        }));
        completed.push({
            id: "attempt-retake-omitted",
            examId: "omitted-retake",
            examTitle: "목록에서 제외된 정확한 재시험",
            studentName: session.name,
            studentId,
            guestId: studentId,
            identityType: "guest",
            status: "completed",
            score: 10,
            totalScore: 10,
            startedAt: instant(-80_000),
            finishedAt: instant(-70_000),
            answers: { 1: 1 },
            retakeSourceAttemptId: "attempt-base-source",
            retake: {
                sourceAttemptId: "attempt-base-source",
                questionIds: [1],
                mode: "wrong",
                createdAt: instant(-80_000),
            },
        });
        for (const item of exams) {
            window.localStorage.setItem(`omr_exam_${item.id}`, JSON.stringify(item));
        }
        window.localStorage.setItem("omr_attempts", JSON.stringify(completed));
        window.localStorage.setItem("omr_guest_id", studentId);
        const draftKey = `omr_draft:v2:${encodeURIComponent(JSON.stringify([
            "student-assignment-draft",
            2,
            "one-second-before-end",
            studentId,
            null,
            null,
            "base",
        ]))}`;
        window.localStorage.setItem(draftKey, JSON.stringify({ scopeBinding: draftKey }));
        window.localStorage.setItem("omr_student_session_backup", JSON.stringify(session));
        window.sessionStorage.setItem("omr_student_session", JSON.stringify(session));
    }, { studentId: STUDENT_ID });
}

if (hostedMode) {
    test("hosted lifecycle proof requires an explicit disposable canonical fixture", async () => {
        throw new Error("unverified: hosted assignment lifecycle requires a disposable canonical student fixture");
    });
} else {
    test("local lifecycle fixture renders boundaries without claiming hosted authorization", async ({ page, context }) => {
        test.info().annotations.push({ type: "release-proof", description: "student_core_assignment_state" });
        await page.clock.install({ time: new Date("2035-01-01T00:00:00.000Z") });
        await resetBrowserState(page, context);
        await seedLifecycleDashboard(page);
        await page.goto("/student/dashboard");

        const lifecycleBadge = (id: string, label: string) => page
            .locator(`[data-assignment-id="${id}"] .student-assignment-meta`)
            .getByText(label, { exact: true });
        await expect(lifecycleBadge("one-second-before-start", "예정")).toBeVisible();
        await expect(lifecycleBadge("at-start-boundary", "응시 가능")).toBeVisible();
        await expect(lifecycleBadge("one-second-before-end", "응시 가능")).toBeVisible();
        await expect(lifecycleBadge("at-end-boundary", "마감")).toBeVisible();
        await expect(lifecycleBadge("archived-closed", "마감")).toBeVisible();
        await expect(lifecycleBadge("malformed-lifecycle", "확인 필요")).toBeVisible();

        for (const id of ["one-second-before-start", "at-end-boundary", "archived-closed", "malformed-lifecycle"]) {
            const row = page.locator(`[data-assignment-id="${id}"]`);
            await expect(row.getByRole("link", { name: /시작|계속 풀기/ })).toHaveCount(0);
            const disabled = row.locator('[aria-disabled="true"]');
            await expect(disabled).toBeVisible();
            await disabled.focus();
            await expect(disabled).not.toBeFocused();
        }

        await expect(page.locator('[data-assignment-id="at-start-boundary"]')
            .getByRole("link", { name: "시작" })).toBeVisible();
        await expect(page.locator('[data-assignment-id="one-second-before-end"]')
            .getByRole("link", { name: "계속 풀기" })).toBeVisible();

        const transitioning = page.locator('[data-assignment-id="one-second-before-start"]');
        await page.clock.runFor(60_000);
        await expect(transitioning.getByText("응시 가능", { exact: true })).toBeVisible();
        await expect(transitioning.getByRole("link", { name: "시작" })).toBeVisible();
        await page.clock.runFor(60_000);
        await expect(transitioning.locator(".student-assignment-meta").getByText("마감", { exact: true })).toBeVisible();
        await expect(transitioning.getByRole("link", { name: /시작|계속 풀기/ })).toHaveCount(0);

        const done = page.getByRole("heading", { name: "완료 기록" }).locator("..").locator("..");
        await expect(done.getByRole("link", { name: "복습" })).toHaveCount(4);
        await expect(done.locator('a[href^="/solve/"]')).toHaveCount(0);
        const archivedReview = page.locator('[data-assignment-id="omitted-archived"]');
        await expect(archivedReview.getByText("복습 전용", { exact: true })).toBeVisible();
        await expect(archivedReview.getByRole("link", { name: "복습" })).toHaveAttribute("href", "/student/review/attempt-3");
        await expect(archivedReview.locator('a[href^="/solve/"]')).toHaveCount(0);
        const retakeReview = page.locator('[data-assignment-id="attempt-retake-omitted"]');
        await expect(retakeReview).toContainText("목록에서 제외된 정확한 재시험");
        await expect(retakeReview.getByText("복습 전용", { exact: true })).toBeVisible();
        await expect(retakeReview.getByRole("link", { name: "복습" })).toHaveAttribute("href", "/student/review/attempt-retake-omitted");
        await expect(retakeReview.locator('a[href^="/solve/"]')).toHaveCount(0);
    });
}
