import { expect, test, type Page } from "@playwright/test";
import { continueSolveEntryIfPresent } from "./helpers";

const EXAM_ID = "solve-offline-exam";
const OFFLINE_BANNER = "오프라인 · 답안은 이 기기에 저장되고 있어요. 연결되면 자동으로 이어집니다.";

async function seedOfflineSolve(page: Page) {
    await page.addInitScript(({ examId }) => {
        if (window.sessionStorage.getItem("solve-offline-seeded") === "1") return;
        try { window.localStorage.clear(); } catch {}
        const session = {
            studentId: "solve-offline-student",
            loginId: "solve-offline-student",
            name: "오프라인학생",
            groupId: "solve-offline-group",
            groupName: "오프라인반",
            isGuest: false,
            identityType: "temporary",
        };
        const exam = {
            id: examId,
            title: "오프라인 제출 확인 시험",
            createdAt: "2026-10-01T00:00:00.000Z",
            accessConfig: { type: "public", groupIds: [] },
            questions: [1, 2].map(number => ({ id: number, number, answer: 2, choices: 5, score: 50 })),
        };
        window.localStorage.setItem(`omr_exam_${examId}`, JSON.stringify(exam));
        window.localStorage.setItem("omr_attempts", JSON.stringify([]));
        window.localStorage.setItem("omr_student_session_backup", JSON.stringify(session));
        window.sessionStorage.setItem("omr_student_session", JSON.stringify(session));
        window.sessionStorage.setItem("solve-offline-seeded", "1");
    }, { examId: EXAM_ID });
}

async function openSolve(page: Page) {
    await seedOfflineSolve(page);
    await page.goto(`/solve/${EXAM_ID}`);
    await continueSolveEntryIfPresent(page);
    await expect(page.getByRole("button", { name: "제출하기" })).toBeVisible({ timeout: 20_000 });
    const expandSheet = page.getByRole("banner").getByRole("button", { name: "답안지 펼치기" });
    if (await expandSheet.isVisible()) await expandSheet.click();
    await expect(page.getByRole("radio", { name: "문제 1번 보기 2" })).toBeVisible();
}

test.describe("solve page offline behavior", () => {
    test("offline banner and save chip follow the browser connection", async ({ page, context }) => {
        await openSolve(page);
        const banner = page.locator(".solve-offline-banner");
        const bannerRegion = page.locator(".solve-offline-banner-region");
        const saveStatus = page.locator(".solve-save-status");
        await expect(bannerRegion).toHaveAttribute("aria-live", "polite");
        await expect(banner).toHaveCount(0);

        await context.setOffline(true);
        await expect(banner).toBeVisible();
        await expect(banner).toHaveText(OFFLINE_BANNER);
        await expect(saveStatus).toHaveAttribute("data-state", "offline");
        await expect(saveStatus).toContainText("오프라인");

        // Answers keep saving to the device while offline.
        await page.getByRole("radio", { name: "문제 1번 보기 2" }).dispatchEvent("click");
        await expect.poll(() => page.evaluate(() => Object.keys(window.localStorage).some(key => key.includes("draft")))).toBe(true);

        await context.setOffline(false);
        await expect(banner).toHaveCount(0);
        await expect(saveStatus).toHaveAttribute("data-state", "saved");
    });

    test("an offline submit stays on the solve page and opens the review after reconnecting", async ({ page, context }) => {
        await openSolve(page);
        await page.getByRole("radio", { name: "문제 1번 보기 2" }).dispatchEvent("click");
        await page.getByRole("radio", { name: "문제 2번 보기 3" }).dispatchEvent("click");

        await context.setOffline(true);
        await expect(page.locator(".solve-offline-banner")).toBeVisible();
        await page.getByRole("button", { name: "제출하기" }).click();
        const confirm = page.getByRole("dialog").filter({ hasText: "제출" });
        await confirm.getByRole("button", { name: "제출하기" }).click();

        const waiting = page.locator(".solve-submission-card");
        await expect(waiting.getByRole("heading", { name: "제출 완료 · 결과는 연결되면 열립니다" })).toBeVisible({ timeout: 30_000 });
        await expect(waiting.getByRole("link", { name: "제출 기록에서 보기" })).toHaveAttribute("href", "/student/history");
        await page.waitForTimeout(1_000);
        expect(new URL(page.url()).pathname).toBe(`/solve/${EXAM_ID}`);

        await context.setOffline(false);
        await page.waitForURL(/\/student\/review\//, { timeout: 30_000 });
        await expect(page.getByRole("heading", { level: 1, name: "오프라인 제출 확인 시험" })).toBeVisible({ timeout: 30_000 });
    });
});
