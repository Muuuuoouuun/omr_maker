import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { continueSolveEntryIfPresent } from "./helpers";

const LONG_TOKEN = "가".repeat(96);
const EXAM_ID = "student-simplification-exam";
const ATTEMPT_ID = "student-simplification-attempt";

function samplePdfDataUrl(): string {
    const bytes = readFileSync(path.join(process.cwd(), "e2e/fixtures/sample-problem.pdf"));
    return `data:application/pdf;base64,${bytes.toString("base64")}`;
}

async function seedStudentSurface(page: Page, options: { completed?: boolean; guest?: boolean } = {}) {
    await page.addInitScript(({ examId, attemptId, completed, guest, longToken, pdfData }) => {
        try { window.localStorage.clear(); } catch {}
        try { window.sessionStorage.clear(); } catch {}

        const studentId = guest ? "guest:student-simplification" : "student-simplification";
        const guestId = guest ? "student-simplification" : undefined;
        const session = {
            studentId,
            loginId: guest ? `guest-${longToken}` : studentId,
            name: `${longToken}학생`,
            groupId: "student-simplification-group",
            groupName: `${longToken}반`,
            isGuest: guest,
            identityType: guest ? "guest" : "temporary",
            guestId,
        };
        const question = {
            id: 1,
            number: 1,
            label: longToken,
            score: 10,
            answer: 2,
            choices: 5,
            explanation: `https://example.test/${longToken}`,
            tags: {
                subject: "국어",
                unit: "독해",
                concept: longToken,
                source: `https://example.test/source/${longToken}`,
                difficulty: "medium",
            },
            subQuestions: [{
                schemaVersion: 1,
                id: "long-prompt",
                prompt: `https://example.test/prompt/${longToken}`,
                kind: "free_text",
                templateId: "custom",
            }],
        };
        const exam = {
            id: examId,
            title: `${longToken}시험`,
            createdAt: "2026-08-05T00:00:00.000Z",
            durationMin: 45,
            pdfData,
            accessConfig: { type: "public", groupIds: [] },
            questions: [question],
        };
        const attempt = {
            id: attemptId,
            examId,
            examTitle: exam.title,
            studentName: session.name,
            studentId,
            guestId,
            groupId: session.groupId,
            groupName: session.groupName,
            identityType: session.identityType,
            startedAt: "2026-08-05T00:00:00.000Z",
            finishedAt: "2026-08-05T00:20:00.000Z",
            score: 0,
            totalScore: 10,
            answers: { 1: 1 },
            subQuestionAnswers: {
                1: {
                    "long-prompt": {
                        schemaVersion: 1,
                        body: `https://example.test/answer/${longToken}`,
                        reviewStatus: "reviewed",
                    },
                },
            },
            studentQuestions: [{
                questionId: 1,
                questionNumber: 1,
                body: `https://example.test/student/${longToken}`,
                createdAt: "2026-08-05T00:21:00.000Z",
                status: "answered",
                answer: {
                    body: `https://example.test/teacher/${longToken}`,
                    createdAt: "2026-08-05T00:22:00.000Z",
                    teacherName: longToken,
                },
            }],
            status: "completed",
        };

        window.localStorage.setItem(`omr_exam_${examId}`, JSON.stringify(exam));
        window.localStorage.setItem("omr_attempts", JSON.stringify(completed ? [attempt] : []));
        if (guestId) window.localStorage.setItem("omr_guest_id", guestId);
        window.localStorage.setItem("omr_student_session_backup", JSON.stringify(session));
        window.sessionStorage.setItem("omr_student_session", JSON.stringify(session));
    }, {
        examId: EXAM_ID,
        attemptId: ATTEMPT_ID,
        completed: options.completed ?? false,
        guest: options.guest ?? false,
        longToken: LONG_TOKEN,
        pdfData: samplePdfDataUrl(),
    });
}

async function expectInsideViewport(page: Page, selector: string) {
    const violations = await page.locator(selector).evaluateAll(elements => elements.flatMap(element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden" || rect.width === 0 || rect.height === 0) return [];
        return rect.left < -1 || rect.right > window.innerWidth + 1
            ? [{ left: rect.left, right: rect.right, viewport: window.innerWidth, text: element.textContent }]
            : [];
    }));
    expect(violations).toEqual([]);
}

test.describe("student UI simplification regressions", () => {
    for (const width of [320, 390]) {
        test(`${width}px keeps alternate student entry methods in one collapsed disclosure`, async ({ page }) => {
            await page.setViewportSize({ width, height: 844 });
            await page.goto("/?role=student");

            await expect(page.getByRole("heading", { name: "학습 시작" })).toBeVisible();
            await expect(page.getByText("학생 포털", { exact: true })).toHaveCount(0);
            await expect(page.getByRole("button", { name: "시험 시작하기" })).toBeVisible();

            const disclosure = page.locator("details.student-alternate-entry");
            await expect(disclosure).not.toHaveAttribute("open", "");
            await expect(page.getByRole("button", { name: "반 코드로 게스트 시험보기" })).toBeHidden();
            await disclosure.locator("summary").click();
            await expect(disclosure).toHaveAttribute("open", "");
            await expect(page.getByRole("button", { name: "반 코드로 게스트 시험보기" })).toBeVisible();
            await expect(page.getByRole("button", { name: "코드 없이 게스트로 계속하기" })).toBeVisible();
            await expectInsideViewport(page, "details.student-alternate-entry");
        });
    }

    test("320px dashboard wraps long identity copy, hides zero completion KPI, and stacks assignment CTA", async ({ page }) => {
        await page.setViewportSize({ width: 320, height: 844 });
        await seedStudentSurface(page);
        await page.goto("/student/dashboard");

        await expect(page.getByTestId("student-dashboard-loading")).toBeHidden({ timeout: 15_000 });
        await expect(page.locator(".student-dashboard-brand").getByText(/^(학생|게스트)$/)).toHaveCount(0);
        await expect(page.locator(".student-dashboard-login-id")).toHaveCount(0);
        await expect(page.getByText("완료한 원시험", { exact: true })).toHaveCount(0);

        const welcome = page.locator(".student-dashboard-welcome h1");
        await expect(welcome).toHaveAttribute("title", `${LONG_TOKEN}학생님`);
        await expect(welcome).toHaveCSS("overflow-wrap", "anywhere");

        const row = page.locator(".student-assignment-row").first();
        const title = row.locator(".student-assignment-title");
        await expect(title).toHaveAttribute("title", `${LONG_TOKEN}시험`);
        const layout = await row.evaluate(element => {
            const titleRect = element.querySelector<HTMLElement>(".student-assignment-content")!.getBoundingClientRect();
            const actionRect = element.querySelector<HTMLElement>(".student-assignment-action")!.getBoundingClientRect();
            return { titleBottom: titleRect.bottom, actionTop: actionRect.top, actionHeight: actionRect.height };
        });
        expect(layout.actionTop).toBeGreaterThanOrEqual(layout.titleBottom - 1);
        expect(layout.actionHeight).toBeGreaterThanOrEqual(44);
        await expectInsideViewport(page, ".student-assignment-row");

        const zeroGrid = page.locator(".student-dashboard-grid.is-zero-completions");
        await expect(zeroGrid).toBeVisible();
        const phoneGrid = await zeroGrid.evaluate(element => {
            const grid = element.getBoundingClientRect();
            const average = element.querySelector<HTMLElement>(".student-dashboard-average-card")!.getBoundingClientRect();
            return { gridWidth: grid.width, averageWidth: average.width };
        });
        expect(Math.abs(phoneGrid.gridWidth - phoneGrid.averageWidth)).toBeLessThanOrEqual(2);

        await page.setViewportSize({ width: 1280, height: 900 });
        const desktopGrid = await zeroGrid.evaluate(element => {
            const grid = element.getBoundingClientRect();
            const average = element.querySelector<HTMLElement>(".student-dashboard-average-card")!.getBoundingClientRect();
            const todo = element.querySelector<HTMLElement>(".student-dashboard-average-card + .col-span-2")!.getBoundingClientRect();
            return { gridLeft: grid.left, gridRight: grid.right, averageLeft: average.left, averageTop: average.top, todoRight: todo.right, todoTop: todo.top };
        });
        expect(Math.abs(desktopGrid.averageLeft - desktopGrid.gridLeft)).toBeLessThanOrEqual(2);
        expect(Math.abs(desktopGrid.todoRight - desktopGrid.gridRight)).toBeLessThanOrEqual(2);
        expect(Math.abs(desktopGrid.averageTop - desktopGrid.todoTop)).toBeLessThanOrEqual(2);
    });

    for (const width of [320, 390]) {
    test(`${width}px solve header keeps secondary tools visible outside control clipping`, async ({ page }) => {
        await page.setViewportSize({ width, height: 844 });
        await seedStudentSurface(page, { guest: true });
        await page.goto(`/solve/${EXAM_ID}`);
        await continueSolveEntryIfPresent(page);

        const tools = page.locator("details.solve-tools-disclosure");
        await expect(tools).not.toHaveAttribute("open", "");
        await expect(page.getByRole("button", { name: "제출하기" })).toBeVisible();
        await expect(page.getByRole("banner").getByRole("button", { name: /답안지 (접기|펼치기)/ })).toBeVisible();
        await expect(page.getByText("선생님 모드", { exact: true })).toBeHidden();
        await tools.locator("summary").click();
        await expect(page.getByText("선생님 모드", { exact: true })).toBeVisible();
        await expect(page.getByText("PDF 열기", { exact: true })).toBeVisible();
        const toolsPanel = tools.locator(".solve-tools-panel");
        const teacherToggle = toolsPanel.locator(".solve-teacher-toggle");
        const pdfButton = toolsPanel.locator(".solve-pdf-button");
        const themeToggle = tools.getByRole("button", { name: /모드로 전환/ });
        await expect(teacherToggle).toBeVisible();
        await expect(pdfButton).toBeVisible();
        await expect(themeToggle).toBeVisible();
        const toolBounds = await toolsPanel.evaluate(panel => {
            const panelRect = panel.getBoundingClientRect();
            const teacher = panel.querySelector<HTMLElement>(".solve-teacher-toggle")!.getBoundingClientRect();
            const checkbox = panel.querySelector<HTMLInputElement>('.solve-teacher-toggle input[type="checkbox"]')!.getBoundingClientRect();
            const label = panel.querySelector<HTMLElement>(".solve-teacher-toggle-label")!.getBoundingClientRect();
            const pdf = panel.querySelector<HTMLElement>(".solve-pdf-button")!.getBoundingClientRect();
            const theme = panel.querySelector<HTMLElement>('button[aria-label$="모드로 전환"]')!.getBoundingClientRect();
            const controls = panel.closest<HTMLElement>(".solve-controls")!;
            return {
                panel: { left: panelRect.left, right: panelRect.right, top: panelRect.top, bottom: panelRect.bottom },
                teacher: { width: teacher.width, height: teacher.height },
                checkboxRight: checkbox.right,
                labelLeft: label.left,
                pdf: { left: pdf.left, right: pdf.right, height: pdf.height },
                theme: { left: theme.left, right: theme.right, width: theme.width, height: theme.height },
                controlsOverflowX: getComputedStyle(controls).overflowX,
                viewport: { width: window.innerWidth, height: window.innerHeight },
            };
        });
        expect(toolBounds.panel.left).toBeGreaterThanOrEqual(0);
        expect(toolBounds.panel.right).toBeLessThanOrEqual(toolBounds.viewport.width);
        expect(toolBounds.panel.top).toBeGreaterThanOrEqual(0);
        expect(toolBounds.panel.bottom).toBeLessThanOrEqual(toolBounds.viewport.height);
        expect(toolBounds.controlsOverflowX).toBe("visible");
        expect(toolBounds.teacher.width).toBeGreaterThan(44);
        expect(toolBounds.teacher.height).toBeGreaterThanOrEqual(44);
        expect(toolBounds.labelLeft).toBeGreaterThanOrEqual(toolBounds.checkboxRight);
        expect(toolBounds.pdf.left).toBeGreaterThanOrEqual(toolBounds.panel.left);
        expect(toolBounds.pdf.right).toBeLessThanOrEqual(toolBounds.panel.right);
        expect(toolBounds.pdf.height).toBeGreaterThanOrEqual(44);
        expect(toolBounds.theme.left).toBeGreaterThanOrEqual(toolBounds.panel.left);
        expect(toolBounds.theme.right).toBeLessThanOrEqual(toolBounds.panel.right);
        const themeToggleBox = await themeToggle.boundingBox();
        expect(themeToggleBox?.width).toBeGreaterThanOrEqual(44);
        expect(themeToggleBox?.height).toBeGreaterThanOrEqual(44);
        const currentTheme = await page.locator("html").getAttribute("data-theme");
        const nextTheme = currentTheme === "dark" ? "light" : "dark";
        await themeToggle.click();
        await expect(page.locator("html")).toHaveAttribute("data-theme", nextTheme);

        const rows = await page.locator(".solve-header-content").evaluate(element => {
            const title = element.querySelector<HTMLElement>(".solve-title-group")!.getBoundingClientRect();
            const status = element.querySelector<HTMLElement>(".solve-status-row")!.getBoundingClientRect();
            const controls = element.querySelector<HTMLElement>(".solve-controls")!.getBoundingClientRect();
            const header = element.closest("header")!.getBoundingClientRect();
            const toolbar = document.querySelector<HTMLElement>(".pdf-viewer-toolbar")?.getBoundingClientRect();
            return {
                titleBottom: title.bottom,
                statusTop: status.top,
                statusBottom: status.bottom,
                controlsTop: controls.top,
                headerBottom: header.bottom,
                toolbarTop: toolbar?.top ?? null,
            };
        });
        expect(rows.statusTop).toBeGreaterThanOrEqual(rows.titleBottom - 1);
        expect(rows.controlsTop).toBeGreaterThanOrEqual(rows.statusBottom - 1);
        if (rows.toolbarTop !== null) expect(rows.toolbarTop).toBeGreaterThanOrEqual(rows.headerBottom - 1);
        await expectInsideViewport(page, ".solve-header, .solve-header-content, .solve-body, .pdf-viewer-toolbar");
    });
    }

    test("390px review contains long metadata, explanation, prompts, and Q&A tokens", async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await seedStudentSurface(page, { completed: true, guest: true });
        await page.goto(`/student/review/${ATTEMPT_ID}`);

        await expect(page.locator(".student-review-question-card")).toBeVisible({ timeout: 15_000 });
        const explanationButton = page.getByRole("button", { name: /^해설/ });
        if (await explanationButton.isVisible()) await explanationButton.click();
        await expect(page.locator(".student-review-explanation")).toBeVisible();
        await expect(page.locator(".student-review-question-box")).toBeVisible();

        await expectInsideViewport(page, [
            ".student-review-meta-chip",
            ".student-review-recommendation-row span",
            ".student-review-recommendation-row small",
            ".student-review-explanation",
            ".student-review-question-card .student-review-long-copy",
            ".student-review-question-box",
        ].join(","));

        const longCopyStyles = await page.locator(".student-review-long-copy").evaluateAll(elements => elements.map(element => ({
            minWidth: getComputedStyle(element).minWidth,
            overflowWrap: getComputedStyle(element).overflowWrap,
            maxWidth: getComputedStyle(element).maxWidth,
        })));
        expect(longCopyStyles.length).toBeGreaterThanOrEqual(4);
        expect(longCopyStyles.every(style => style.minWidth === "0px" && style.overflowWrap === "anywhere" && style.maxWidth === "100%"))
            .toBe(true);
    });
});
