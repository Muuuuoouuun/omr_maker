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
        const exam = (
            id: string,
            lifecycle: "scheduled" | "open" | "closed" | "invalid" | undefined,
            startsAt: string,
            endsAt: string,
        ) => ({
            id,
            title: `${id} 시험`,
            createdAt: "2026-08-09T00:00:00.000Z",
            startsAt,
            endsAt,
            lifecycle,
            durationMin: 30,
            accessConfig: { type: "public", groupIds: [] },
            questions: [{ id: 1, number: 1, answer: 1, choices: 5, score: 10 }],
        });
        const exams = [
            exam("one-second-before-start", "scheduled", "2026-08-09T01:00:00.000Z", "2026-08-09T02:00:00.000Z"),
            exam("at-start-boundary", "open", "2026-08-09T01:00:00.000Z", "2026-08-09T02:00:00.000Z"),
            exam("one-second-before-end", "open", "2026-08-09T00:00:00.000Z", "2026-08-09T02:00:00.000Z"),
            exam("at-end-boundary", "closed", "2026-08-09T00:00:00.000Z", "2026-08-09T02:00:00.000Z"),
            exam("archived-closed", "closed", "2026-08-09T00:00:00.000Z", "2026-08-09T03:00:00.000Z"),
            exam("malformed-lifecycle", undefined, "2026-08-09T00:00:00.000Z", "2026-08-09T03:00:00.000Z"),
            exam("completed-closed", "closed", "2026-08-09T00:00:00.000Z", "2026-08-09T02:00:00.000Z"),
            exam("completed-open", "open", "2026-08-09T00:00:00.000Z", "2026-08-09T03:00:00.000Z"),
        ];
        const completed = ["completed-closed", "completed-open"].map((examId, index) => ({
            id: `attempt-${index + 1}`,
            examId,
            examTitle: `${examId} 시험`,
            studentName: session.name,
            studentId,
            guestId: studentId,
            identityType: "guest",
            status: "completed",
            score: 10,
            totalScore: 10,
            startedAt: "2026-08-09T00:00:00.000Z",
            finishedAt: "2026-08-09T00:30:00.000Z",
            answers: { 1: 1 },
        }));
        for (const item of exams) {
            window.localStorage.setItem(`omr_exam_${item.id}`, JSON.stringify(item));
        }
        window.localStorage.setItem("omr_attempts", JSON.stringify(completed));
        window.localStorage.setItem("omr_guest_id", studentId);
        window.localStorage.setItem(`omr_draft_one-second-before-end_${studentId}_base`, "{}");
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
        await resetBrowserState(page, context);
        await seedLifecycleDashboard(page);
        await page.route("**/*", async route => {
            const request = route.request();
            if (request.method() === "POST" && request.headers()["next-action"]) {
                await route.abort("failed");
                return;
            }
            await route.continue();
        });
        await page.goto("/student/dashboard");

        const todo = page.getByRole("heading", { name: "미완료 과제" }).locator("..").locator("..");
        await expect(todo.getByText("예정", { exact: true })).toBeVisible();
        await expect(todo.getByText("응시 가능", { exact: true })).toHaveCount(2);
        await expect(todo.getByText("마감", { exact: true })).toHaveCount(4);
        await expect(todo.getByText("확인 필요", { exact: true })).toHaveCount(2);

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

        const done = page.getByRole("heading", { name: "완료 기록" }).locator("..").locator("..");
        await expect(done.getByRole("link", { name: "복습" })).toHaveCount(2);
        await expect(done.locator('a[href^="/solve/"]')).toHaveCount(0);
    });
}
