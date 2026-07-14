import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { resetBrowserState } from "./helpers";

const EXAM_ID = "e2e-drawing-toolbar-exam";
const GROUP_ID = "e2e-drawing-group";
const STUDENT_ID = "e2e-drawing-group::student-1";

function pdfDataUrl(): string {
    const bytes = readFileSync(path.join(process.cwd(), "e2e/fixtures/sample-problem.pdf"));
    return `data:application/pdf;base64,${bytes.toString("base64")}`;
}

async function seedExamWithPdf(page: Page, pdfData: string) {
    await page.evaluate((seed) => {
        const now = "2026-07-01T00:00:00.000Z";
        const exam = {
            id: seed.examId,
            title: "Drawing Toolbar E2E",
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
        const group = { id: seed.groupId, name: "E2E Draw Class", region: "서울", count: 1, avgScore: 0, color: "#4f46e5" };
        const student = { id: seed.studentId, name: "필기 학생", email: "draw@example.com", group: "E2E Draw Class",
            region: "서울", avatar: "#4f46e5", avgScore: 0, examsTaken: 0, lastActive: "기록 없음", trend: "flat", status: "active" };
        const session = { studentId: seed.studentId, loginId: seed.studentId, name: "필기 학생",
            groupId: seed.groupId, groupName: "E2E Draw Class", regionId: "서울", regionName: "서울",
            isGuest: false, identityType: "temporary" };
        window.localStorage.setItem(`omr_exam_${seed.examId}`, JSON.stringify(exam));
        window.localStorage.setItem("omr_groups", JSON.stringify([group]));
        window.localStorage.setItem("omr_students", JSON.stringify([student]));
        window.localStorage.setItem("omr_attempts", JSON.stringify([]));
        window.localStorage.setItem("omr_student_session_backup", JSON.stringify(session));
        window.sessionStorage.setItem("omr_student_session", JSON.stringify(session));
    }, { examId: EXAM_ID, groupId: GROUP_ID, studentId: STUDENT_ID, pdfData });
}

// The toggle buttons carry descriptive aria-labels now (see PDFViewer.tsx), so we
// select them within the "지우개 방식" group by their VISIBLE text ('획' / '부분').
function eraserModeButtons(page: Page) {
    const group = page.getByRole("group", { name: "지우개 방식" });
    return {
        group,
        stroke: group.getByRole("button").filter({ hasText: /^획$/ }),
        pixel: group.getByRole("button").filter({ hasText: /^부분$/ }),
    };
}

// Count non-transparent pixels on the drawing overlay canvas. This is the
// observable we use to prove strokes are drawn / erased / restored.
async function overlayPixelCount(page: Page): Promise<number> {
    return page.getByTestId("pdf-draw-overlay").evaluate((el) => {
        const c = el as HTMLCanvasElement;
        const ctx = c.getContext("2d");
        if (!ctx) return -1;
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) n++;
        return n;
    });
}

// main's 입장 확인 (exam-entry confirmation) modal is preserved on the beta1 solve
// page, so the drawing toolbar only mounts once entry is confirmed. Dismiss it as
// the seeded roster student (falling back to guest entry) before the toolbar checks.
async function confirmExamEntry(page: Page) {
    const asStudent = page.getByRole("button", { name: "학생으로 시험 보기" });
    const asGuest = page.getByRole("button", { name: "게스트로 시험 보기" });
    await expect(asStudent.or(asGuest).first()).toBeVisible({ timeout: 20000 });
    if (await asStudent.isVisible().catch(() => false)) {
        await asStudent.click();
    } else {
        await asGuest.click();
    }
}

test.describe("PDF drawing toolbar + eraser 부분/획 toggle", () => {
    test.beforeEach(async ({ page, context }) => {
        await resetBrowserState(page, context);
        await seedExamWithPdf(page, pdfDataUrl());
        await page.goto(`/solve/${EXAM_ID}`);
        await confirmExamEntry(page);
        // The drawing toolbar (incl. eraser) appears as soon as pdfFile is set
        // (before the PDF paints), so the eraser button is visible right away.
        await expect(page.getByLabel("지우개")).toBeVisible({ timeout: 20000 });
    });

    test("eraser reveals 부분/획 toggle, 획 active by default", async ({ page }) => {
        await page.getByLabel("지우개").click();

        const { group, stroke, pixel } = eraserModeButtons(page);
        await expect(group).toBeVisible();

        await expect(stroke).toHaveAttribute("aria-pressed", "true");
        await expect(pixel).toHaveAttribute("aria-pressed", "false");
    });

    test("switching eraser modes updates pressed state", async ({ page }) => {
        await page.getByLabel("지우개").click();

        const { group, stroke, pixel } = eraserModeButtons(page);
        await expect(group).toBeVisible();

        await pixel.click();
        await expect(pixel).toHaveAttribute("aria-pressed", "true");
        await expect(stroke).toHaveAttribute("aria-pressed", "false");

        await stroke.click();
        await expect(stroke).toHaveAttribute("aria-pressed", "true");
        await expect(pixel).toHaveAttribute("aria-pressed", "false");
    });

    test("switching to pen hides the eraser toggle", async ({ page }) => {
        await page.getByLabel("지우개").click();

        const { group } = eraserModeButtons(page);
        await expect(group).toBeVisible();

        await page.getByLabel("펜", { exact: true }).click();
        await expect(group).not.toBeVisible();

        await page.getByLabel("지우개").click();
        await expect(group).toBeVisible();
    });

    test("pen sets an svg data-uri cursor; eraser sets none in both modes", async ({ page }) => {
        const overlay = page.getByTestId("pdf-draw-overlay");
        await expect(overlay).toBeVisible();

        await page.getByLabel("펜", { exact: true }).click();
        await expect
            .poll(async () => overlay.evaluate((el) => getComputedStyle(el).cursor))
            .toContain("url(");
        const penCursor = await overlay.evaluate((el) => getComputedStyle(el).cursor);
        expect(penCursor).toContain("image/svg");

        await page.getByLabel("지우개").click();
        await expect
            .poll(async () => overlay.evaluate((el) => getComputedStyle(el).cursor))
            .toBe("none");

        // Pixel mode also suppresses the native cursor (the ring draws it).
        const { pixel } = eraserModeButtons(page);
        await pixel.click();
        await expect(pixel).toHaveAttribute("aria-pressed", "true");
        await expect
            .poll(async () => overlay.evaluate((el) => getComputedStyle(el).cursor))
            .toBe("none");
    });

    test("eraser ring is attached; dashed in 획, solid in 부분", async ({ page }) => {
        await page.getByLabel("지우개").click();

        // The ring is display:none until pointermove, so assert attachment, not visibility.
        const ring = page.getByTestId("pdf-eraser-ring");
        await expect(ring).toHaveCount(1);
        await expect(ring).toBeAttached();

        // Default is 획 (stroke) mode -> dashed border.
        await expect
            .poll(async () => ring.evaluate((el) => getComputedStyle(el).borderStyle))
            .toBe("dashed");

        // Flip to 부분 (pixel) mode -> solid border.
        const { pixel } = eraserModeButtons(page);
        await pixel.click();
        await expect(pixel).toHaveAttribute("aria-pressed", "true");
        await expect
            .poll(async () => ring.evaluate((el) => getComputedStyle(el).borderStyle))
            .toBe("solid");
    });

    test("획 stroke-erase removes a drawn stroke and Ctrl/Cmd+Z restores it", async ({ page }) => {
        const overlay = page.getByTestId("pdf-draw-overlay");
        await expect(overlay).toBeVisible();

        // --- Draw a horizontal pen stroke across the middle of the overlay ---
        await page.getByLabel("펜", { exact: true }).click();

        const box = await overlay.boundingBox();
        expect(box).not.toBeNull();
        if (!box) throw new Error("overlay has no bounding box");

        const midY = box.y + box.height * 0.5;
        const startX = box.x + box.width * 0.25;
        const endX = box.x + box.width * 0.75;

        await page.mouse.move(startX, midY);
        await page.mouse.down();
        await page.mouse.move(endX, midY, { steps: 30 });
        await page.mouse.up();

        // Fail loudly if synthetic drawing did not register.
        let drawn = 0;
        await expect
            .poll(async () => {
                drawn = await overlayPixelCount(page);
                return drawn;
            })
            .toBeGreaterThan(100);
        drawn = await overlayPixelCount(page);
        expect(drawn).toBeGreaterThan(100);

        // --- Erase it in 획 (stroke) mode (the default) ---
        await page.getByLabel("지우개").click();
        const { stroke } = eraserModeButtons(page);
        await expect(stroke).toHaveAttribute("aria-pressed", "true");

        // Drag along the same horizontal line, crossing the stroke.
        await page.mouse.move(startX, midY);
        await page.mouse.down();
        await page.mouse.move(endX, midY, { steps: 30 });
        await page.mouse.up();

        let erased = drawn;
        await expect
            .poll(async () => {
                erased = await overlayPixelCount(page);
                return erased;
            })
            .toBeLessThan(drawn * 0.2);
        erased = await overlayPixelCount(page);

        // --- Undo restores the stroke, roughly to its original pixel count ---
        // The component picks the undo modifier from the BROWSER's navigator.platform
        // (Cmd on Mac, Ctrl elsewhere), which is not necessarily the host OS Playwright
        // runs on — e.g. chromium here reports Win32. Match the browser to hit the same
        // branch the product uses.
        const browserIsMac = await page.evaluate(
            () => navigator.platform.toUpperCase().indexOf("MAC") >= 0,
        );
        const mod = browserIsMac ? "Meta" : "Control";
        await page.keyboard.press(`${mod}+z`);

        let restored = erased;
        await expect
            .poll(async () => {
                restored = await overlayPixelCount(page);
                return restored;
            })
            .toBeGreaterThan(drawn * 0.8);
        restored = await overlayPixelCount(page);

        // Sanity: the three phases are clearly distinct.
        expect(drawn).toBeGreaterThan(100);
        expect(erased).toBeLessThan(drawn * 0.2);
        expect(restored).toBeGreaterThan(drawn * 0.8);
    });
});
