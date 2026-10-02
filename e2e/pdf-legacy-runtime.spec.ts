import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { continueSolveEntryIfPresent, resetBrowserState } from "./helpers";

// Regression for the solve-page crash on browsers without the newest built-ins
// (Chromium 141, older iOS Safari / Android WebView): the modern PDF.js build
// calls Map.prototype.getOrInsertComputed on the main thread and in its worker.
// The app must load the legacy PDF.js build (core-js polyfills) everywhere, and
// a PDF failure must never take the OMR answer sheet down with it.

const EXAM_ID = "e2e-pdf-legacy-runtime-exam";
const GROUP_ID = "e2e-pdf-legacy-group";
const STUDENT_ID = "e2e-pdf-legacy-group::student-1";
const WORKER_URL = /\/(?:react-)?pdf\.worker\.min\.mjs(?:\?|$)/;

// Runs before any app code on the page and before the worker module body, so
// both globals look like a browser that never shipped these proposals.
const REMOVE_GET_OR_INSERT = `
for (const proto of [Map.prototype, WeakMap.prototype]) {
    delete proto.getOrInsert;
    delete proto.getOrInsertComputed;
}
`;

test.use({ serviceWorkers: "block" });

function pdfDataUrl(): string {
    const bytes = readFileSync(path.join(process.cwd(), "e2e/fixtures/sample-problem-2pages.pdf"));
    return `data:application/pdf;base64,${bytes.toString("base64")}`;
}

async function seedExamWithPdf(page: Page) {
    await page.evaluate((seed) => {
        const now = "2026-07-01T00:00:00.000Z";
        const exam = {
            id: seed.examId,
            title: "PDF Legacy Runtime E2E",
            createdAt: now,
            updatedAt: now,
            durationMin: 30,
            archived: false,
            pdfData: seed.pdfData,
            accessConfig: { type: "group", groupIds: [seed.groupId] },
            questions: [
                { id: 1, number: 1, label: "문항1", score: 10, answer: 2, choices: 5,
                  tags: { subject: "국어", unit: "문법", concept: "x", difficulty: "easy" } },
                { id: 2, number: 2, label: "문항2", score: 10, answer: 3, choices: 5,
                  tags: { subject: "국어", unit: "독해", concept: "y", difficulty: "medium" } },
            ],
        };
        const group = { id: seed.groupId, name: "E2E Legacy Class", region: "서울", count: 1, avgScore: 0, color: "#4f46e5" };
        const student = { id: seed.studentId, name: "레거시 학생", email: "legacy@example.com", group: "E2E Legacy Class",
            region: "서울", avatar: "#4f46e5", avgScore: 0, examsTaken: 0, lastActive: "기록 없음", trend: "flat", status: "active" };
        const session = { studentId: seed.studentId, loginId: seed.studentId, name: "레거시 학생",
            groupId: seed.groupId, groupName: "E2E Legacy Class", regionId: "서울", regionName: "서울",
            isGuest: false, identityType: "temporary" };
        window.localStorage.setItem(`omr_exam_${seed.examId}`, JSON.stringify(exam));
        window.localStorage.setItem("omr_groups", JSON.stringify([group]));
        window.localStorage.setItem("omr_students", JSON.stringify([student]));
        window.localStorage.setItem("omr_attempts", JSON.stringify([]));
        window.localStorage.setItem("omr_student_session_backup", JSON.stringify(session));
        window.sessionStorage.setItem("omr_student_session", JSON.stringify(session));
    }, { examId: EXAM_ID, groupId: GROUP_ID, studentId: STUDENT_ID, pdfData: pdfDataUrl() });
}

async function ensureAnswerPaneVisible(page: Page) {
    const expandButton = page.getByRole("button", { name: "답안지 펼치기", exact: true });
    const answerPaneTitle = page.locator(".solve-omr-pane:not(.is-collapsed) .solve-omr-pane-title", {
        hasText: "OMR 답안",
    });
    await expect.poll(async () => (
        await answerPaneTitle.isVisible().catch(() => false)
        || await expandButton.isVisible().catch(() => false)
    ), { timeout: 15_000 }).toBe(true);
    if (!(await answerPaneTitle.isVisible().catch(() => false))) await expandButton.click();
    await expect(answerPaneTitle).toBeVisible();
}

test.describe("PDF.js legacy runtime on browsers without getOrInsert*", () => {
    test("renders the problem PDF with zero page errors", async ({ page, context }) => {
        const pageErrors: string[] = [];
        page.on("pageerror", error => pageErrors.push(error.message));
        const workerRequests: string[] = [];

        await context.addInitScript({ content: REMOVE_GET_OR_INSERT });
        await page.route(WORKER_URL, async route => {
            workerRequests.push(route.request().url());
            const response = await route.fetch();
            const body = await response.text();
            await route.fulfill({ response, body: `${REMOVE_GET_OR_INSERT}\n${body}` });
        });

        await resetBrowserState(page, context);
        expect(await page.evaluate(() => "getOrInsertComputed" in Map.prototype)).toBe(false);
        await seedExamWithPdf(page);
        await page.goto(`/solve/${EXAM_ID}`);
        await continueSolveEntryIfPresent(page);

        await expect(page.locator(".react-pdf__Page__canvas")).toBeVisible({ timeout: 20_000 });
        await expect(page.getByTestId("pdf-draw-overlay")).toHaveAttribute("data-pdf-ready", "true");
        await expect(page.locator(".react-pdf__Page__textContent")).toContainText("OMR Drawing Test Page");
        await expect(page.getByTestId("pdf-pane-error")).toHaveCount(0);

        // The worker went through the stripped-down global and is the cache-busted legacy URL.
        expect(workerRequests.length).toBeGreaterThan(0);
        for (const url of workerRequests) expect(url).toMatch(/\?v=\d+\.\d+\.\d+-legacy$/);
        // The legacy main-thread build installed its core-js polyfill.
        expect(await page.evaluate(() => typeof (Map.prototype as { getOrInsertComputed?: unknown }).getOrInsertComputed)).toBe("function");
        expect(pageErrors).toEqual([]);
    });

    test("keeps OMR marking and submission usable when the PDF worker is missing", async ({ page, context }) => {
        await page.route(WORKER_URL, route => route.fulfill({ status: 404, body: "not found" }));

        await resetBrowserState(page, context);
        await seedExamWithPdf(page);
        await page.goto(`/solve/${EXAM_ID}`);
        await continueSolveEntryIfPresent(page);

        const errorCard = page.getByTestId("pdf-pane-error");
        await expect(errorCard).toBeVisible({ timeout: 20_000 });
        await expect(errorCard).toContainText("문제지를 표시하지 못했습니다.");
        await expect(errorCard).toContainText("답안 마킹과 제출은 계속할 수 있습니다.");
        await expect(page.getByRole("heading", { name: "예상치 못한 오류가 발생했습니다" })).toHaveCount(0);

        await ensureAnswerPaneVisible(page);
        const first = page.getByRole("radio", { name: "문제 1번 보기 2" });
        const second = page.getByRole("radio", { name: "문제 2번 보기 3" });
        await first.click();
        await second.click();
        await expect(first).toBeChecked();
        await expect(second).toBeChecked();
        await expect(page.getByText("모든 문제 표기 완료")).toBeVisible();

        // Retry remounts the viewer. PDF.js disables its worker for the rest of
        // the page session after a worker failure, so it fails back into the
        // same card (not the route-level error page) and keeps the answers.
        await errorCard.getByRole("button", { name: "다시 시도" }).click();
        await expect(errorCard).toBeVisible({ timeout: 20_000 });
        await expect(page.getByRole("heading", { name: "예상치 못한 오류가 발생했습니다" })).toHaveCount(0);
        await expect(first).toBeChecked();

        await page.locator(".solve-submit-button").click();
        const confirmDialog = page.getByRole("dialog", { name: "답안 제출" });
        await expect(confirmDialog).toBeVisible();
        await confirmDialog.getByRole("button", { name: "제출하기" }).click();
        await expect(page).toHaveURL(/\/student\/review\/[^/?#]+(?:[?#]|$)/, { timeout: 15_000 });
        const storedAttempts = await page.evaluate(() => JSON.parse(window.localStorage.getItem("omr_attempts") || "[]"));
        expect(storedAttempts).toHaveLength(1);
        expect(storedAttempts[0]).toMatchObject({ examId: EXAM_ID, answers: { 1: 2, 2: 3 } });
    });
});
