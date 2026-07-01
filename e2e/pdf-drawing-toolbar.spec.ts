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

test.describe("PDF drawing toolbar + eraser 부분/획 toggle", () => {
    test.beforeEach(async ({ page, context }) => {
        await resetBrowserState(page, context);
        await seedExamWithPdf(page, pdfDataUrl());
        await page.goto(`/solve/${EXAM_ID}`);
        // The drawing tools (incl. eraser) only render once the PDF file loads.
        await expect(page.getByLabel("지우개")).toBeVisible({ timeout: 20000 });
    });

    test("eraser reveals 부분/획 toggle, 획 active by default", async ({ page }) => {
        await page.getByLabel("지우개").click();

        const group = page.getByRole("group", { name: "지우개 방식" });
        await expect(group).toBeVisible();

        const stroke = group.getByRole("button", { name: "획", exact: true });
        const pixel = group.getByRole("button", { name: "부분", exact: true });

        await expect(stroke).toHaveAttribute("aria-pressed", "true");
        await expect(pixel).toHaveAttribute("aria-pressed", "false");
    });

    test("switching eraser modes updates pressed state", async ({ page }) => {
        await page.getByLabel("지우개").click();

        const group = page.getByRole("group", { name: "지우개 방식" });
        await expect(group).toBeVisible();

        const stroke = group.getByRole("button", { name: "획", exact: true });
        const pixel = group.getByRole("button", { name: "부분", exact: true });

        await pixel.click();
        await expect(pixel).toHaveAttribute("aria-pressed", "true");
        await expect(stroke).toHaveAttribute("aria-pressed", "false");

        await stroke.click();
        await expect(stroke).toHaveAttribute("aria-pressed", "true");
        await expect(pixel).toHaveAttribute("aria-pressed", "false");
    });

    test("switching to pen hides the eraser toggle", async ({ page }) => {
        await page.getByLabel("지우개").click();

        const group = page.getByRole("group", { name: "지우개 방식" });
        await expect(group).toBeVisible();

        await page.getByLabel("펜", { exact: true }).click();
        await expect(group).not.toBeVisible();

        await page.getByLabel("지우개").click();
        await expect(group).toBeVisible();
    });

    test("pen sets an svg data-uri cursor; eraser sets none", async ({ page }) => {
        // Our drawing overlay has no class; react-pdf renders both a page canvas
        // (.react-pdf__Page__canvas) and a hidden 0x0 canvas (.hiddenCanvasElement).
        const overlay = page.locator("canvas:not([class])");
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
    });
});
