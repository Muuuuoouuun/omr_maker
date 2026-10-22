import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { continueSolveEntryIfPresent } from "./helpers";

const targetHost = new URL(process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1").hostname;
test.skip(!["127.0.0.1", "localhost", "[::1]"].includes(targetHost), "local student fixtures require a local server");

const EXAM_ID = "student-empty-state-exam";

async function seedStudent(page: Page, attempts: Array<{ status: "completed" | "in_progress"; score: number }> = [], requiredQuestion = 0) {
    await page.addInitScript(({ examId, records, requiredQuestion }) => {
        if (window.sessionStorage.getItem("student-empty-state-seeded") === "1") return;
        const session = {
            studentId: "guest:student-empty-state",
            guestId: "student-empty-state",
            loginId: "guest-student-empty-state",
            name: "빈 상태 학생",
            groupId: "student-empty-state-class",
            groupName: "테스트반",
            isGuest: true,
            identityType: "guest",
        };
        const exam = {
            id: examId,
            title: "종이 문제지 답안 작성",
            createdAt: "2026-10-01T00:00:00.000Z",
            durationMin: 35,
            accessConfig: { type: "public", groupIds: [] },
            questions: Array.from({ length: 12 }, (_, index) => ({
                id: index + 1,
                number: index + 1,
                choices: 5,
                answer: 2,
                score: 10,
                ...(requiredQuestion === index + 1 ? {
                    subQuestions: [{ schemaVersion: 1, id: "required-reason", prompt: "답의 근거를 적어주세요.", kind: "free_text", templateId: "custom", required: true }],
                } : {}),
            })),
        };
        window.localStorage.setItem(`omr_exam_${examId}`, JSON.stringify(exam));
        window.localStorage.setItem("omr_attempts", JSON.stringify(records.map((record, index) => ({
            id: `empty-state-attempt-${index}`,
            examId,
            examTitle: exam.title,
            studentId: session.studentId,
            guestId: session.guestId,
            studentName: session.name,
            groupId: session.groupId,
            identityType: "guest",
            startedAt: "2026-10-01T00:00:00.000Z",
            finishedAt: record.status === "completed" ? "2026-10-01T00:20:00.000Z" : "",
            totalScore: 100,
            answers: {},
            ...record,
        }))));
        window.localStorage.setItem("omr_guest_id", session.guestId);
        window.localStorage.setItem("omr_student_session_backup", JSON.stringify(session));
        window.sessionStorage.setItem("omr_student_session", JSON.stringify(session));
        window.sessionStorage.setItem("student-empty-state-seeded", "1");
    }, { examId: EXAM_ID, records: attempts, requiredQuestion });
}

test.describe("student average without completed attempts", () => {
    for (const fixture of [
        { label: "no attempts", records: [], expected: "아직 제출 기록이 없어요" },
        { label: "only an in-progress attempt", records: [{ status: "in_progress" as const, score: 100 }], expected: "아직 제출 기록이 없어요" },
        { label: "a genuine zero and an unfinished attempt", records: [{ status: "completed" as const, score: 0 }, { status: "in_progress" as const, score: 100 }], expected: "0%" },
    ]) {
        test(fixture.label, async ({ page }, testInfo) => {
            await seedStudent(page, fixture.records);
            await page.goto("/student/dashboard");
            const average = page.locator(".student-dashboard-average-card");
            await expect(average).toContainText(fixture.expected);
            await expect(average).toHaveAttribute("href", "/student/history");
            if (fixture.expected !== "0%") await expect(average).not.toContainText("%");
            await page.screenshot({ path: testInfo.outputPath("student-dashboard-desktop.png"), fullPage: true });
        });
    }
});

test.describe("phone answer sheet without a PDF", () => {
    for (const viewport of [{ width: 320, height: 568 }, { width: 393, height: 852 }]) {
        test(`${viewport.width}px keeps the empty PDF action compact and preserves marking after restore and PDF open`, async ({ page }, testInfo) => {
            await page.setViewportSize(viewport);
            await seedStudent(page);
            await page.goto(`/solve/${EXAM_ID}`);
            await continueSolveEntryIfPresent(page);

            const action = page.getByRole("region", { name: "종이 문제지로 답안 작성" });
            await expect(action).toBeVisible();
            await expect(page.locator(".pdf-viewer-container")).toBeHidden();
            const bounds = await page.locator(".solve-body").evaluate(element => {
                const body = element.getBoundingClientRect();
                const pdf = element.querySelector(".solve-pdf-pane")!.getBoundingClientRect();
                const omr = element.querySelector("#solve-omr-pane")!.getBoundingClientRect();
                return { body: body.height, pdf: pdf.height, omr: omr.height };
            });
            expect(bounds.pdf).toBeLessThanOrEqual(112);
            expect(bounds.omr).toBeGreaterThanOrEqual(bounds.body - bounds.pdf - 2);
            const openButton = action.getByRole("button", { name: "문제지 PDF 열기" });
            expect((await openButton.boundingBox())?.height).toBeGreaterThanOrEqual(44);
            await page.screenshot({ path: testInfo.outputPath("student-no-pdf-mobile.png") });

            const answer = page.getByRole("radio", { name: "문제 1번 보기 2" });
            await answer.click();
            await expect(answer).toHaveAttribute("aria-checked", "true");
            await page.reload();
            await continueSolveEntryIfPresent(page);
            await expect(answer).toHaveAttribute("aria-checked", "true");

            const chooser = page.waitForEvent("filechooser");
            await openButton.click();
            await (await chooser).setFiles(path.join(process.cwd(), "e2e/fixtures/sample-problem.pdf"));
            await expect(page.locator(".react-pdf__Page__canvas")).toBeVisible({ timeout: 30_000 });
            await expect(action).toHaveCount(0);
            await expect(answer).toHaveAttribute("aria-checked", "true");
        });
    }

    test("submit opens the first missing required response and accepts it before confirmation", async ({ page }) => {
        await page.setViewportSize({ width: 393, height: 852 });
        await seedStudent(page, [], 12);
        await page.goto(`/solve/${EXAM_ID}`);
        await continueSolveEntryIfPresent(page);
        await page.getByRole("button", { name: "제출하기", exact: true }).click();
        const response = page.getByRole("region", { name: "12번 심화 응답" });
        await expect(response).toBeVisible();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await response.getByRole("textbox").fill("문제에서 확인한 근거입니다.");
        await page.getByRole("button", { name: "제출하기", exact: true }).click();
        await expect(page.getByRole("dialog")).toBeVisible();
    });
});
