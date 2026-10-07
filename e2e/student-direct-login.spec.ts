import { test, expect } from "@playwright/test";

for (const viewport of [{ name: "desktop", width: 1280, height: 900 }, { name: "mobile", width: 390, height: 844 }]) {
    test(`student can open direct login without an invite on ${viewport.name}`, async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
        await page.setViewportSize(viewport);
        await page.goto("/?role=student");
        await expect(page).toHaveURL(/\/\?role=student$/);
        await expect(page).toHaveTitle(/OMR/i);
        await expect(page.getByLabel("학생 로그인 ID")).toBeVisible();
        await expect(page.getByLabel("시작 코드", { exact: true })).toHaveAttribute("type", "password");
        await expect(page.getByRole("button", { name: "내 시험으로 이동" })).toBeVisible();
        await expect(page.getByText("Runtime Error", { exact: true })).toHaveCount(0);
        await page.screenshot({ path: `/tmp/omr-direct-login-${viewport.name}.png`, fullPage: true, animations: "disabled" });
        await page.getByRole("button", { name: "내 시험으로 이동" }).click();
        await expect(page.locator(".student-direct-login-form").getByRole("alert")).toContainText("학생 로그인 ID와 시작 코드를 입력해주세요.");
        const layout = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
        expect(layout.scroll).toBeLessThanOrEqual(layout.width);
        expect(errors).toEqual([]);
    });
}

test("missing student sessions lead to direct credential login", async ({ page }) => {
    await page.goto("/student/dashboard");
    await expect(page.getByRole("heading", { name: "학생 로그인이 필요합니다" })).toBeVisible();
    await page.getByRole("link", { name: "학생 로그인", exact: true }).click();
    await expect(page.getByLabel("학생 로그인 ID")).toBeVisible();
    await expect(page).toHaveURL(/\/\?role=student$/);
});

// Both isolated local fixtures neutralize student backend configuration and use no live credentials.
test("an unavailable student backend cannot create a direct-login session", async ({ page, context }) => {
    await page.goto("/?role=student");
    await page.getByLabel("학생 로그인 ID").fill("synthetic-direct-login-student");
    await page.getByLabel("시작 코드", { exact: true }).fill("ABC234");
    await page.getByRole("button", { name: "내 시험으로 이동" }).click();
    await expect(page.locator(".student-direct-login-form").getByRole("alert")).toContainText("학생 인증 서버에 연결하지 못했습니다.");
    expect((await context.cookies()).some(cookie => cookie.name === "omr_student_server_session")).toBe(false);
    await expect(page).toHaveURL(/\/\?role=student$/);
    const persistedCredential = await page.evaluate(() => Object.values(localStorage).some(value => value.includes("ABC234")));
    expect(persistedCredential).toBe(false);
});
