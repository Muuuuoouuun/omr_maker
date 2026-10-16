import { expect, test } from "@playwright/test";

// Phone geometry of the first screens: the role picker and the account forms.

test.describe("portal entry on phones", () => {
    for (const width of [320, 360, 390]) {
        test(`${width}px role cards keep their actions inside the card`, async ({ page }) => {
            await page.setViewportSize({ width, height: 760 });
            await page.goto("/");
            const cards = page.locator(".home-role-card");
            await expect(cards).toHaveCount(2);
            for (let index = 0; index < 2; index += 1) {
                const card = cards.nth(index);
                await expect(card).toBeEnabled({ timeout: 30_000 });
                const cardBox = await card.boundingBox();
                const actionBox = await card.locator(".home-role-action").boundingBox();
                expect(cardBox && actionBox).toBeTruthy();
                expect(actionBox!.x).toBeGreaterThanOrEqual(cardBox!.x);
                expect(actionBox!.x + actionBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width);
            }
        });
    }

    test("the logo badge and theme toggle scroll away instead of covering the teacher form", async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 700 });
        await page.goto("/?role=teacher");
        await expect(page.getByRole("button", { name: "대시보드 입장" })).toBeEnabled({ timeout: 30_000 });
        await page.evaluate(() => window.scrollTo({ top: 320, behavior: "instant" }));
        for (const selector of [".home-role-home-link", ".home-theme-toggle"]) {
            const floating = page.locator(selector).first();
            expect(await floating.evaluate(element => getComputedStyle(element).position), selector).not.toBe("fixed");
            await expect(floating, selector).not.toBeInViewport();
        }
        await expect(page.locator("#teacher-identifier")).toBeInViewport();
    });
});
