import { expect, test, type Locator, type Page } from "@playwright/test";
import { loginAsTeacher } from "./helpers";

function isLocalBaseURL(baseURL?: string): boolean {
    const url = new URL(baseURL || "http://localhost:3003");
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
}

async function expectNoHorizontalOverflow(page: Page) {
    await expect.poll(async () => page.evaluate(() => (
        document.documentElement.scrollWidth > document.documentElement.clientWidth
    ))).toBe(false);
}

async function expectTouchTarget(locator: Locator) {
    await expect(locator).toHaveCount(1);
    await expect(locator).toBeVisible();
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    expect(Math.round(box?.width || 0)).toBeGreaterThanOrEqual(44);
    expect(Math.round(box?.height || 0)).toBeGreaterThanOrEqual(44);
}

async function smallTargets(page: Page, selector: string) {
    return page.evaluate((selector) => {
        return [...document.querySelectorAll<HTMLElement>(selector)]
            .filter((element) => {
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return rect.width > 0
                    && rect.height > 0
                    && style.display !== "none"
                    && style.visibility !== "hidden";
            })
            .map((element) => {
                const rect = element.getBoundingClientRect();
                return {
                    label: (element.getAttribute("aria-label") || element.textContent || element.tagName).trim().replace(/\s+/g, " "),
                    tag: element.tagName.toLowerCase(),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height),
                };
            })
            .filter(target => target.width < 44 || target.height < 44);
    }, selector);
}

async function expectTeacherHeaderTouchFriendly(page: Page, options: { hasSearch: boolean }) {
    const header = page.locator(".teacher-header").first();

    await expect(header).toBeVisible();
    if (options.hasSearch) {
        await expectTouchTarget(header.getByRole("button", { name: "빠른 검색" }));
        await expectTouchTarget(header.getByRole("link", { name: "Dashboard" }));
    }
    await expectTouchTarget(header.getByRole("link", { name: "실시간 모니터링" }));
    await expectTouchTarget(header.getByRole("button", { name: /알림/ }));
    await expectTouchTarget(header.getByRole("button", { name: "교사 로그아웃" }));
    await expectTouchTarget(header.getByRole("button", { name: /모드로 전환/ }));
    expect(await smallTargets(page, ".teacher-header button, .teacher-header a[href]")).toEqual([]);
    await expectNoHorizontalOverflow(page);
}

test.describe("Teacher phone and tablet app chrome", () => {
    test.beforeEach(async ({ baseURL }) => {
        test.skip(!isLocalBaseURL(baseURL), "Authenticated teacher mobile checks require local teacher login.");
    });

    test("keeps the dashboard header touch friendly", async ({ page }) => {
        await loginAsTeacher(page, "/teacher/dashboard");

        await expect(page.getByRole("heading", { name: "Analytics Center" })).toBeVisible();
        await expectTeacherHeaderTouchFriendly(page, { hasSearch: false });

        await page.locator(".teacher-header").getByRole("button", { name: /알림/ }).click();
        await expect(page.getByRole("dialog", { name: "알림 목록" })).toBeVisible();
        await expectNoHorizontalOverflow(page);
    });

    test("keeps operational teacher headers touch friendly", async ({ page }) => {
        for (const route of [
            { path: "/teacher/live", heading: "응시 결과 확인" },
            { path: "/teacher/settings", heading: "설정" },
            { path: "/teacher/billing", heading: "결제 및 플랜" },
        ]) {
            await loginAsTeacher(page, route.path);

            await expect(page.getByRole("heading", { name: route.heading })).toBeVisible();
            await expectTeacherHeaderTouchFriendly(page, { hasSearch: true });
        }
    });

    test("keeps the exam creation toolbar touch friendly", async ({ page }) => {
        await loginAsTeacher(page, "/create");

        const toolbar = page.locator(".create-editor-actions");
        await expect(toolbar).toBeVisible();
        await expectTouchTarget(toolbar.getByRole("button", { name: /되돌리기/ }));
        await expectTouchTarget(toolbar.getByRole("button", { name: /다시 실행/ }));
        await expectTouchTarget(toolbar.locator("label", { hasText: "문제지 업로드" }));
        await expectTouchTarget(toolbar.locator("label", { hasText: "답지 업로드" }));
        await expectTouchTarget(toolbar.getByRole("button", { name: /이미지 저장/ }));
        await expectTouchTarget(toolbar.getByRole("button", { name: "배포하기" }));
        await expectTouchTarget(toolbar.getByRole("button", { name: "교사 로그아웃" }));
        await expectTouchTarget(toolbar.getByRole("button", { name: /모드로 전환/ }));
        expect(await smallTargets(page, ".create-editor-actions button, .create-editor-actions label")).toEqual([]);
        await expectNoHorizontalOverflow(page);
    });
});
