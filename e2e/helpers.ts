import { expect, type BrowserContext, type Page } from "@playwright/test";

export async function resetBrowserState(page: Page, context: BrowserContext) {
    await context.clearCookies();
    await page.goto("/");
    await page.evaluate(() => {
        try { window.localStorage.clear(); } catch {}
        try { window.sessionStorage.clear(); } catch {}
    });
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function loginAsTeacher(page: Page, nextPath = "/teacher/dashboard") {
    await page.goto(`/?role=teacher&next=${encodeURIComponent(nextPath)}`);
    await expect(page.getByPlaceholder("admin 또는 teacher@example.com")).toBeVisible();
    await page.getByPlaceholder("admin 또는 teacher@example.com").fill("admin");
    await page.getByPlaceholder("비밀번호 입력").fill("admin123");
    await page.getByRole("button", { name: "대시보드 입장" }).click();
    await expect(page).toHaveURL(new RegExp(`${escapeRegExp(nextPath)}(?:[?#].*)?$`), { timeout: 15_000 });
}

export async function openTeacherPage(page: Page, path: string) {
    await loginAsTeacher(page, path);
}
