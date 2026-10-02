import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { continueSolveEntryIfPresent } from "./helpers";

// Plan A2: phone and tablet solve geometry. Viewports are set per test, so the
// spec runs on the desktop Chromium project (and WebKit where enabled).

const EXAM_ID = "solve-mobile-layout-exam";
const STUDENT_ID = "solve-mobile-layout-class::student-1";
const SAMPLE_PDF_DATA_URL = `data:application/pdf;base64,${readFileSync(
    path.join(process.cwd(), "e2e/fixtures/sample-problem-2pages.pdf"),
).toString("base64")}`;

async function seedSolveExam(page: Page) {
    await page.addInitScript(({ examId, pdfData, studentId }) => {
        if (window.sessionStorage.getItem("solve-mobile-layout-seeded") === "1") return;
        try { window.localStorage.clear(); } catch {}
        const session = {
            createdAt: "2026-10-01T00:00:00.000Z",
            groupId: "solve-mobile-layout-class",
            groupName: "레이아웃반",
            identityType: "temporary",
            isGuest: false,
            loginId: studentId,
            name: "레이아웃학생",
            studentId,
        };
        const exam = {
            id: examId,
            title: "폰과 태블릿에서 문제지와 답안지를 함께 보는 국어 평가",
            createdAt: "2026-10-01T00:00:00.000Z",
            updatedAt: "2026-10-01T00:00:00.000Z",
            durationMin: 35,
            pdfData,
            accessConfig: { type: "public", groupIds: [] },
            questions: Array.from({ length: 12 }, (_, index) => ({
                id: index + 1,
                number: index + 1,
                answer: (index % 5) + 1,
                choices: 5,
                score: 5,
                label: `문항 ${index + 1}`,
                pdfLocation: { page: 1, x: 0.15 + (index % 4) * 0.2, y: 0.2 + Math.floor(index / 4) * 0.2 },
            })),
        };
        window.localStorage.setItem(`omr_exam_${examId}`, JSON.stringify(exam));
        window.localStorage.setItem("omr_attempts", JSON.stringify([]));
        window.localStorage.setItem("omr_student_session_backup", JSON.stringify(session));
        window.sessionStorage.setItem("omr_student_session", JSON.stringify(session));
        window.sessionStorage.setItem("solve-mobile-layout-seeded", "1");
    }, { examId: EXAM_ID, pdfData: SAMPLE_PDF_DATA_URL, studentId: STUDENT_ID });
}

async function openSolve(page: Page, viewport: { width: number; height: number }) {
    await page.setViewportSize(viewport);
    await seedSolveExam(page);
    await page.goto(`/solve/${EXAM_ID}`);
    await continueSolveEntryIfPresent(page);
    await expect(page.locator(".solve-body")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".react-pdf__Page__canvas")).toBeVisible({ timeout: 30_000 });
}

async function box(page: Page, selector: string) {
    const rect = await page.locator(selector).first().boundingBox();
    expect(rect, `${selector} should have a layout box`).not.toBeNull();
    return rect!;
}

test.describe("solve layout on phones", () => {
    for (const { width, height, minScrollHeight } of [
        { width: 320, height: 568, minScrollHeight: 140 },
        { width: 393, height: 727, minScrollHeight: Math.ceil(727 * 0.3) },
        { width: 393, height: 852, minScrollHeight: Math.ceil(852 * 0.3) },
    ]) {
        test(`${width}x${height} keeps a readable PDF above the expanded answer sheet`, async ({ page }) => {
            await openSolve(page, { width, height });

            // PO decision A-4: the sheet stays expanded on first phone entry.
            const pane = page.locator("#solve-omr-pane");
            await expect(pane).not.toHaveClass(/is-collapsed/);

            await expect.poll(async () => (await box(page, ".pdf-viewer-scroll")).height)
                .toBeGreaterThanOrEqual(minScrollHeight);

            const toolbar = await box(page, ".pdf-viewer-toolbar");
            expect(toolbar.height).toBeLessThanOrEqual(60);
            await expect(page.locator(".pdf-viewer-file")).toBeHidden();
            await expect(page.locator(".pdf-viewer-bottom-toolbar")).toBeHidden();
            await expect(page.locator(".pdf-viewer-controls input[type='text']")).toBeVisible();
            await expect(page.getByRole("button", { name: /^필기 도구/ })).toBeVisible();

            const pdf = await box(page, ".solve-pdf-pane");
            const omr = await box(page, "#solve-omr-pane");
            expect(omr.y).toBeGreaterThanOrEqual(pdf.y + pdf.height - 2);
            expect(omr.width).toBeGreaterThanOrEqual(width - 2);
            expect(omr.height).toBeGreaterThanOrEqual(160);
            expect(omr.y + omr.height).toBeLessThanOrEqual(height + 1);
        });
    }

    for (const viewport of [{ width: 320, height: 568 }, { width: 393, height: 727 }]) {
        test(`${viewport.width}x${viewport.height} drawing tools open over the page without resizing it`, async ({ page }) => {
            await openSolve(page, viewport);
            const scroll = page.locator(".pdf-viewer-scroll");
            const before = await scroll.boundingBox();

            const toggle = page.getByRole("button", { name: /^필기 도구/ });
            await expect(toggle).toHaveAttribute("aria-expanded", "false");
            await expect(page.getByRole("toolbar", { name: "PDF 필기 도구" })).toHaveCount(0);
            await toggle.click();
            await expect(toggle).toHaveAttribute("aria-expanded", "true");
            const popover = page.locator(".pdf-viewer-drawing-popover");
            await expect(popover).toBeVisible();
            await expect(popover.getByRole("toolbar", { name: "PDF 필기 도구" })).toBeVisible();

            const after = await scroll.boundingBox();
            expect(after?.height).toBe(before?.height);
            expect(after?.y).toBe(before?.y);

            const pane = await box(page, ".solve-pdf-pane");
            const popoverBox = await box(page, ".pdf-viewer-drawing-popover");
            expect(popoverBox.x).toBeGreaterThanOrEqual(pane.x - 1);
            expect(popoverBox.x + popoverBox.width).toBeLessThanOrEqual(pane.x + pane.width + 1);
            expect(popoverBox.y + popoverBox.height).toBeLessThanOrEqual(pane.y + pane.height + 1);

            await popover.getByLabel("펜", { exact: true }).click();
            await expect(toggle).toHaveAccessibleName("필기 도구 · 펜");
            expect((await scroll.boundingBox())?.height).toBe(before?.height);

            await page.keyboard.press("Escape");
            await expect(popover).toHaveCount(0);
            await expect(toggle).toHaveAttribute("aria-expanded", "false");
            await expect(toggle).toBeFocused();
        });
    }

    for (const viewport of [{ width: 320, height: 568 }, { width: 393, height: 727 }]) {
        test(`${viewport.width}x${viewport.height} collapsed sheet leaves a bottom dock that still marks answers`, async ({ page }) => {
            await openSolve(page, viewport);
            const expandedScroll = await box(page, ".pdf-viewer-scroll");

            await page.locator(".solve-controls").getByRole("button", { name: "답안지 접기" }).click();
            await expect(page.locator("#solve-omr-pane")).toHaveClass(/is-collapsed/);

            const dock = page.locator(".solve-omr-rail");
            await expect(dock).toBeVisible();
            const dockBox = await box(page, ".solve-omr-rail");
            const pdf = await box(page, ".solve-pdf-pane");
            expect(dockBox.height).toBeGreaterThanOrEqual(50);
            expect(dockBox.height).toBeLessThanOrEqual(64);
            expect(dockBox.width).toBeGreaterThanOrEqual(viewport.width - 2);
            expect(dockBox.y).toBeGreaterThanOrEqual(pdf.y + pdf.height - 2);
            expect(dockBox.y + dockBox.height).toBeLessThanOrEqual(viewport.height + 1);
            await expect.poll(async () => (await box(page, ".pdf-viewer-scroll")).height)
                .toBeGreaterThan(expandedScroll.height);

            const bubble = dock.getByRole("button", { name: "1번 보기 3", exact: true });
            const bubbleBox = await bubble.boundingBox();
            expect(bubbleBox?.x ?? -1).toBeGreaterThanOrEqual(0);
            expect((bubbleBox?.x ?? 0) + (bubbleBox?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
            expect(bubbleBox?.height ?? 0).toBeGreaterThanOrEqual(44);
            await bubble.click();
            await expect(bubble).toHaveAttribute("aria-pressed", "true");
            await expect(page.locator(".solve-progress")).toContainText("1/12");

            await page.locator(".solve-controls").getByRole("button", { name: "답안지 펼치기" }).click();
            await expect(page.locator("#solve-omr-pane")).not.toHaveClass(/is-collapsed/);
            await expect(dock).toBeHidden();
            await expect(page.getByRole("radio", { name: "문제 1번 보기 3", exact: true })).toBeChecked();
        });
    }
});

test.describe("solve layout on tablets", () => {
    for (const viewport of [
        { width: 1180, height: 820 },
        { width: 1024, height: 768 },
        { width: 1194, height: 834 },
    ]) {
        test(`${viewport.width}x${viewport.height} keeps the page and pen toolbar in view with the sheet collapsed`, async ({ page }) => {
            await openSolve(page, viewport);
            await expect(page.locator("#solve-omr-pane")).toHaveClass(/is-collapsed/);

            await page.getByLabel("펜", { exact: true }).click();
            await expect(page.getByRole("group", { name: "펜 옵션" })).toBeVisible();

            const expectInView = async () => {
                const pane = await box(page, ".solve-pdf-pane");
                const header = await box(page, ".solve-header");
                const pdfPage = await box(page, ".react-pdf__Page");
                // The body must not be scrolled sideways or grown past the
                // viewport (that shifted the page left / pushed the header up).
                expect(pane.x).toBeGreaterThanOrEqual(-1);
                expect(pane.x + pane.width).toBeLessThanOrEqual(viewport.width + 1);
                expect(pane.y + pane.height).toBeLessThanOrEqual(viewport.height + 1);
                expect(header.y).toBeGreaterThanOrEqual(-1);
                expect(pdfPage.x).toBeGreaterThanOrEqual(pane.x - 1);

                const toolbar = await box(page, ".pdf-viewer-toolbar");
                for (const control of [
                    page.getByRole("button", { name: "확대" }),
                    page.getByRole("button", { name: "이 페이지의 모든 필기 삭제" }),
                    page.getByRole("button", { name: "필압 끄기" }),
                ]) {
                    const controlBox = await control.boundingBox();
                    expect(controlBox).not.toBeNull();
                    expect(controlBox!.x).toBeGreaterThanOrEqual(toolbar.x - 1);
                    expect(controlBox!.x + controlBox!.width).toBeLessThanOrEqual(Math.min(viewport.width, toolbar.x + toolbar.width) + 1);
                }
            };
            await expectInView();

            // Selecting a question scrolls the sheet's card into view; that
            // must not scroll the clipped solve body or page instead.
            await page.locator(".solve-controls").getByRole("button", { name: "답안지 펼치기" }).click();
            await expect(page.locator("#solve-omr-pane")).not.toHaveClass(/is-collapsed/);
            await page.getByRole("radio", { name: "문제 9번 보기 2", exact: true }).click();
            await page.locator(".solve-controls").getByRole("button", { name: "답안지 접기" }).click();
            await expect(page.locator("#solve-omr-pane")).toHaveClass(/is-collapsed/);
            await page.waitForTimeout(400);
            await expectInView();
        });
    }
});
