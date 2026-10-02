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

        const section = (name: "open" | "scheduled" | "invalid" | "closed") => page
            .locator(`[data-assignment-section="${name}"]`);
        const rowIn = (name: "open" | "scheduled" | "invalid" | "closed", id: string) => section(name)
            .locator(`[data-assignment-id="${id}"]`);
        const meta = (id: string) => page.locator(`[data-assignment-id="${id}"] .student-assignment-meta`);

        // The headline and the header badge count only what can be solved now.
        await expect(page.locator(".student-dashboard-headline"))
            .toHaveText("지금 풀 수 있는 시험이 2개 있어요. 그중 2개는 오늘 마감이에요.");
        await expect(page.locator(".student-assignment-open-count")).toHaveText("2");

        // 2035-01-01T00:00Z is 09:00 KST: the open rows close at 09:01 today.
        await expect(section("open").getByRole("heading", { name: /지금 풀 수 있어요/ })).toBeVisible();
        await expect(rowIn("open", "at-start-boundary")).toBeVisible();
        await expect(rowIn("open", "one-second-before-end")).toBeVisible();
        await expect(meta("at-start-boundary").getByText("오늘 09:01 마감", { exact: true })).toBeVisible();
        await expect(rowIn("scheduled", "one-second-before-start")).toBeVisible();
        await expect(meta("one-second-before-start").getByText("오늘 09:01 시작", { exact: true })).toBeVisible();
        await expect(rowIn("invalid", "malformed-lifecycle")).toBeVisible();
        await expect(meta("malformed-lifecycle").getByText("확인 필요", { exact: true })).toBeVisible();

        // Closed, never-submitted assignments are collapsed out of the way.
        const closed = section("closed");
        await expect(closed).not.toHaveAttribute("open", "");
        await expect(closed.locator("summary")).toContainText(/마감된 과제\s*2/);
        await expect(rowIn("closed", "at-end-boundary")).toBeHidden();
        await closed.locator("summary").click();
        await expect(closed).toHaveAttribute("open", "");
        await expect(meta("at-end-boundary").getByText("마감", { exact: true })).toBeVisible();
        await expect(meta("archived-closed").getByText("마감", { exact: true })).toBeVisible();
        await expect(rowIn("closed", "at-end-boundary").getByText("미응시 마감", { exact: true })).toBeVisible();

        for (const id of ["one-second-before-start", "at-end-boundary", "archived-closed", "malformed-lifecycle"]) {
            const row = page.locator(`[data-assignment-id="${id}"]`);
            await expect(row.getByRole("link", { name: /시작|계속 풀기/ })).toHaveCount(0);
            const disabled = row.locator('[aria-disabled="true"]');
            await expect(disabled).toBeVisible();
            await disabled.focus();
            await expect(disabled).not.toBeFocused();
        }

        await expect(rowIn("open", "at-start-boundary")
            .getByRole("link", { name: "시작" })).toBeVisible();
        await expect(rowIn("open", "one-second-before-end")
            .getByRole("link", { name: "계속 풀기" })).toBeVisible();

        // At the shared boundary the scheduled row opens while the two open rows close.
        await page.clock.runFor(60_000);
        await expect(rowIn("open", "one-second-before-start").getByRole("link", { name: "시작" })).toBeVisible();
        await expect(meta("one-second-before-start").getByText("오늘 09:02 마감", { exact: true })).toBeVisible();
        await expect(rowIn("closed", "at-start-boundary")).toBeVisible();
        await expect(rowIn("closed", "one-second-before-end")).toBeVisible();
        await expect(section("scheduled")).toHaveCount(0);
        await expect(page.locator(".student-dashboard-headline"))
            .toHaveText("지금 풀 수 있는 시험이 1개 있어요. 그중 1개는 오늘 마감이에요.");
        await expect(page.locator(".student-assignment-open-count")).toHaveText("1");

        await page.clock.runFor(60_000);
        const transitioned = rowIn("closed", "one-second-before-start");
        await expect(transitioned.locator(".student-assignment-meta").getByText("마감", { exact: true })).toBeVisible();
        await expect(transitioned.getByRole("link", { name: /시작|계속 풀기/ })).toHaveCount(0);
        await expect(section("open")).toHaveCount(0);
        await expect(page.locator(".student-assignment-open-count")).toHaveCount(0);
        await expect(page.locator(".student-dashboard-headline")).toHaveText("지금 풀어야 할 시험이 없어요.");

        const done = page.getByRole("heading", { name: "완료 기록" }).locator("..").locator("..");
        await expect(done.getByRole("link", { name: "복습" })).toHaveCount(4);
        await expect(done.locator('a[href^="/solve/"]')).toHaveCount(0);
        // Completed cards carry no availability pills, only the submission day.
        await expect(done.getByText(/^(응시 가능|마감|예정)$/)).toHaveCount(0);
        await expect(page.locator('[data-assignment-id="completed-open"]').getByText(/^완료 · \d{1,2}\/\d{1,2} 제출$/)).toBeVisible();
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
