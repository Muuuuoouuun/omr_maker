import { expect, test } from "@playwright/test";
import { resetBrowserState } from "./helpers";

test("dashboard data failure is not presented as an empty successful dashboard and can recover", async ({ page, context }) => {
    let failCanonicalActions = false;
    let injectedFailureCount = 0;
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
        if (failCanonicalActions && route.request().method() === "POST" && route.request().headers()["next-action"]) {
            const response = await route.fetch();
            const body = await response.text();
            const failedBody = body.replaceAll('"degraded_local"', '"error"');
            if (failedBody !== body || body.includes('"error"')) injectedFailureCount += 1;
            await route.fulfill({
                response,
                body: failedBody,
            });
            return;
        }
        await route.continue();
    });
    failCanonicalActions = true;
    await page.reload();

    const errorStatus = page.getByTestId("student-dashboard-error");
    await expect(errorStatus).toBeVisible();
    await expect(errorStatus).toHaveAttribute("data-canonical-state", "error_without_cache");
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
    await expect(errorStatus.getByRole("link", { name: "로그인 안내" })).toHaveAttribute("href", "/");
    await expect(errorStatus.getByRole("link", { name: "홈으로" })).toHaveAttribute("href", "/");

    failCanonicalActions = false;
    await retryButton.click();
    await expect(errorStatus).toBeHidden();
    await expect(page.getByText("나의 원시험 평균", { exact: true })).toBeVisible();
    await expect(page.getByText("오늘은 예정된 시험이 없습니다", { exact: false })).toBeVisible();
    await expect(page.locator('[data-canonical-state="loaded_empty"]')).toBeVisible();
    expect(injectedFailureCount).toBeGreaterThan(0);
});
