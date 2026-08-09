import { expect, test } from "@playwright/test";
import { loginAsTeacher, resetBrowserState } from "./helpers";

test("teacher canonical screens keep hosted read failure distinct from empty and recover", async ({ page, context }) => {
    test.setTimeout(45_000);
    let failCanonicalActions = false;
    let injectedFailureCount = 0;
    await page.route("**/*", async route => {
        const request = route.request();
        if (failCanonicalActions && request.method() === "POST" && request.headers()["next-action"]) {
            const response = await route.fetch();
            const body = await response.text();
            const failedBody = body.replaceAll('"local_only"', '"service_unavailable"');
            if (failedBody !== body || body.includes('"service_unavailable"')) injectedFailureCount += 1;
            await route.fulfill({ response, body: failedBody });
            return;
        }
        await route.continue();
    });

    await resetBrowserState(page, context);
    await loginAsTeacher(page, "/teacher/dashboard");

    await page.evaluate(() => {
        window.localStorage.removeItem("omr_teacher_dashboard_cache_stale_at_v1");
        window.localStorage.removeItem("omr_attempts");
        for (const key of Object.keys(window.localStorage)) {
            if (key.startsWith("omr_exam_")) window.localStorage.removeItem(key);
        }
    });
    failCanonicalActions = true;
    await page.reload();

    const dashboardError = page.getByTestId("canonical-error-no-cache");
    await expect(dashboardError).toBeVisible();
    await expect(dashboardError).toContainText("서버 데이터를 불러오지 못했습니다");
    await expect(page.getByText("첫 시험 만들기", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "시험 출제하기" })).toHaveCount(0);

    failCanonicalActions = false;
    await dashboardError.getByTestId("canonical-dashboard-retry").click();
    await expect(dashboardError).toBeHidden();
    await expect(page.getByText("첫 시험 만들기", { exact: true })).toBeVisible();

    await page.evaluate(() => {
        const now = new Date().toISOString();
        window.localStorage.setItem("omr_teacher_dashboard_cache_stale_at_v1", now);
        window.localStorage.setItem("omr_exam_cached-dashboard", JSON.stringify({
            id: "cached-dashboard",
            title: "저장된 운영 시험",
            organizationId: "default",
            createdByUserId: "admin",
            createdAt: now,
            updatedAt: now,
            durationMin: 30,
            questions: [],
            accessConfig: { type: "public" },
        }));
    });
    failCanonicalActions = true;
    await page.reload();
    const dashboardDegraded = page.getByTestId("canonical-degraded-cache");
    await expect(dashboardDegraded).toContainText("저장된 데이터를 표시 중");
    await expect(dashboardDegraded).toContainText("마지막 저장");
    await expect(page.getByRole("button", { name: "저장된 운영 시험 분석 보기" })).toBeVisible();
    await expect(page.getByText("첫 시험 만들기", { exact: true })).toHaveCount(0);

    await page.evaluate(() => {
        window.localStorage.removeItem("omr_teacher_roster_cache_stale_at_v1");
        window.localStorage.removeItem("omr_students");
        window.localStorage.removeItem("omr_groups");
        window.localStorage.removeItem("omr_invites");
    });
    await page.goto("/teacher/users");
    const rosterError = page.getByTestId("canonical-error-no-cache");
    await expect(rosterError).toBeVisible();
    await expect(page.getByRole("button", { name: /학생 추가/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "CSV 업로드" })).toHaveCount(0);

    failCanonicalActions = false;
    await rosterError.getByTestId("canonical-roster-retry").click();
    await expect(rosterError).toBeHidden();
    await expect(page.getByRole("button", { name: "첫 학생 추가" })).toBeVisible();

    await page.goto("/create");
    const title = page.getByLabel("시험 제목");
    if (!await title.isVisible()) await page.getByRole("tab", { name: /^설정/ }).click();
    await title.fill("배포 명단 실패 검증 시험");
    await page.getByLabel("빠른 정답 입력").fill("1".repeat(20));
    failCanonicalActions = true;
    await page.locator(".create-primary-actions:visible")
        .getByRole("button", { name: "저장하고 배포하기" })
        .click();

    const distribution = page.getByRole("dialog", { name: "시험 배포하기" });
    const distributionRosterError = distribution.getByTestId("canonical-error-no-cache");
    await expect(distributionRosterError).toBeVisible();
    await expect(distribution.getByRole("button", { name: "링크 생성하기" })).toBeDisabled();

    failCanonicalActions = false;
    await distributionRosterError.getByTestId("canonical-distribution-roster-retry").click();
    await expect(distributionRosterError).toBeHidden();
    await expect(distribution.getByRole("button", { name: "링크 생성하기" })).toBeEnabled();
    expect(injectedFailureCount).toBeGreaterThan(0);
});
