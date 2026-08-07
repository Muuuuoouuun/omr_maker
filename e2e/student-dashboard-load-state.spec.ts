import { expect, test } from "@playwright/test";
import { resetBrowserState } from "./helpers";

test("dashboard data failure is not presented as an empty successful dashboard and can recover", async ({ page, context }) => {
    await resetBrowserState(page, context);

    await page.goto("/?role=student");
    await page.getByText("다른 방법으로 참여", { exact: true }).click();
    await page.getByRole("button", { name: "코드 없이 게스트로 계속하기" }).click();
    await expect(page).toHaveURL(/\/student\/dashboard$/, { timeout: 15_000 });
    await expect(page.getByText("나의 원시험 평균", { exact: true })).toBeVisible();

    await page.addInitScript(() => {
        const originalGetItem = Storage.prototype.getItem;
        let failedOnce = false;

        Storage.prototype.getItem = function (key: string) {
            if (
                !failedOnce
                && window.location.pathname === "/student/dashboard"
                && this === window.localStorage
                && key === "omr_attempts"
            ) {
                failedOnce = true;
                throw new Error("E2E forced local assignment read failure");
            }
            return originalGetItem.call(this, key);
        };
    });
    await page.route("**/*", async (route) => {
        if (route.request().method() === "POST" && route.request().headers()["next-action"]) {
            await route.abort("failed");
            return;
        }
        await route.continue();
    });
    await page.reload();

    const errorStatus = page.getByTestId("student-dashboard-error");
    await expect(errorStatus).toBeVisible();
    await expect(errorStatus).toHaveAttribute("role", "status");
    await expect(errorStatus).toHaveAttribute("aria-live", "polite");
    await expect(errorStatus.getByRole("heading", { name: "학습 현황을 불러오지 못했습니다" })).toBeVisible();
    await expect(errorStatus).toContainText("저장공간");
    await expect(page.locator(".student-dashboard-user")).toContainText("Guest Student");

    await expect(page.getByText("나의 원시험 평균", { exact: true })).toHaveCount(0);
    await expect(page.getByText("오늘은 예정된 시험이 없습니다", { exact: false })).toHaveCount(0);
    await expect(page.getByText("모든 과제를 완료했습니다!", { exact: true })).toHaveCount(0);

    const retryButton = errorStatus.getByTestId("student-dashboard-retry");
    await retryButton.focus();
    await expect(retryButton).toBeFocused();
    await expect(errorStatus.getByRole("link", { name: "학생 로그인" })).toHaveAttribute("href", "/?role=student");
    await expect(errorStatus.getByRole("link", { name: "홈으로" })).toHaveAttribute("href", "/");

    await retryButton.click();
    await expect(errorStatus).toBeHidden();
    await expect(page.getByText("나의 원시험 평균", { exact: true })).toBeVisible();
    await expect(page.getByText("오늘은 예정된 시험이 없습니다", { exact: false })).toBeVisible();
});
