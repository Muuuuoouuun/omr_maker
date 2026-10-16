import { expect, test } from "@playwright/test";

test.describe("intro storytelling page", () => {
    test("keeps one main landmark and one level-one heading on every width", async ({ page }) => {
        for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
            await page.setViewportSize(viewport);
            await page.goto("/intro");
            await expect(page).toHaveTitle(/OMR Maker/);
            await expect(page.locator("main")).toHaveCount(1);
            await expect(page.locator("main h1")).toHaveCount(1);
            await expect(page.getByRole("heading", { level: 1 })).toContainText("선생님의 시험이 시작됩니다");
            const width = await page.evaluate(() => ({
                client: document.documentElement.clientWidth,
                scroll: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
            }));
            expect(width.scroll, `${viewport.width}px should not scroll horizontally`).toBeLessThanOrEqual(width.client);
        }
    });

    test("hands the hero demo CTA to the teacher portal with the showcase card in view", async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto("/intro");

        await page.getByRole("link", { name: "가입 없이 데모 보기" }).click();
        await expect(page).toHaveURL(/\/\?role=teacher&intent=demo$/);

        // The portal's own button still starts the demo; it only scrolls into view.
        const demoButton = page.getByRole("button", { name: "데모 계정으로 둘러보기" });
        await expect(demoButton).toBeEnabled({ timeout: 15_000 });
        await expect(demoButton).toBeInViewport();
    });

    test("is reachable from the public role choice", async ({ page }) => {
        await page.goto("/");

        const introLink = page.getByRole("link", { name: "처음이신가요? 서비스 소개 보기" });
        await expect(introLink).toHaveAttribute("href", "/intro");
        await introLink.click();
        await expect(page).toHaveURL(/\/intro$/);
        await expect(page.getByRole("heading", { level: 1 })).toContainText("선생님의 시험이 시작됩니다");
    });
});
