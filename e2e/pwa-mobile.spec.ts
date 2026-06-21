import { expect, test, type Locator, type Page } from "@playwright/test";

async function clearStorage(page: Page) {
    await page.addInitScript(() => {
        try { window.localStorage.clear(); } catch {}
        try { window.sessionStorage.clear(); } catch {}
    });
}

function collectConsoleProblems(page: Page): string[] {
    const problems: string[] = [];
    page.on("console", message => {
        if (message.type() === "error" || message.type() === "warning") {
            problems.push(`${message.type()}: ${message.text()}`);
        }
    });
    return problems;
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

async function expectMetaContent(page: Page, name: string, content: string) {
    await expect.poll(async () => page.evaluate(({ name }) => (
        document.querySelectorAll(`meta[name="${name}"]`).length
    ), { name })).toBeGreaterThan(0);

    const values = await page.evaluate(({ name }) => {
        const metas = [...document.querySelectorAll(`meta[name="${name}"]`)];
        return metas.map(meta => meta.getAttribute("content"));
    }, { name });
    expect(values.every(value => value === content)).toBe(true);
}

async function triggerAndroidInstallPrompt(page: Page) {
    await page.evaluate(() => {
        const event = new Event("beforeinstallprompt", { cancelable: true }) as Event & {
            prompt: () => Promise<void>;
            userChoice: Promise<{ outcome: "accepted"; platform: string }>;
        };

        event.prompt = async () => undefined;
        event.userChoice = Promise.resolve({ outcome: "accepted", platform: "web" });
        window.dispatchEvent(event);
    });
}

async function emulateStandaloneDisplay(page: Page) {
    await page.addInitScript(() => {
        const originalMatchMedia = window.matchMedia.bind(window);

        window.matchMedia = (query: string): MediaQueryList => {
            if (query.includes("(display-mode: standalone)") || query.includes("(display-mode: fullscreen)")) {
                return {
                    matches: true,
                    media: query,
                    onchange: null,
                    addEventListener: () => undefined,
                    addListener: () => undefined,
                    dispatchEvent: () => false,
                    removeEventListener: () => undefined,
                    removeListener: () => undefined,
                };
            }

            return originalMatchMedia(query);
        };

        Object.defineProperty(window.navigator, "standalone", {
            configurable: true,
            value: true,
        });
    });
}

async function stubClipboard(page: Page) {
    await page.addInitScript(() => {
        Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: {
                writeText: async (text: string) => {
                    (window as Window & { __omrCopiedReport?: string }).__omrCopiedReport = text;
                },
            },
        });
    });
}

test.describe("Mobile PWA entry", () => {
    test.beforeEach(async ({ page }) => {
        await clearStorage(page);
    });

    test("advertises app metadata and opens the student flow without mobile overflow", async ({ page }) => {
        const consoleProblems = collectConsoleProblems(page);

        await page.goto("/");

        await expect(page).toHaveTitle("OMR Maker");
        await expect(page.getByRole("heading", { name: "OMR Maker" })).toBeVisible();
        await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
        await expect(page.locator('link[rel="apple-touch-icon"]').first()).toHaveAttribute("href", "/apple-touch-icon.png");
        await expectMetaContent(page, "mobile-web-app-capable", "yes");
        await expectMetaContent(page, "apple-mobile-web-app-capable", "yes");
        await expectTouchTarget(page.locator('button[aria-label$="모드로 전환"]'));
        await expectTouchTarget(page.getByRole("button", { name: /학생.*시작하기/ }));
        await expectTouchTarget(page.getByRole("button", { name: /교사.*대시보드/ }));
        await expectNoHorizontalOverflow(page);

        await page.getByRole("button", { name: /학생.*시작하기/ }).click();

        await expect(page.getByRole("heading", { name: "학습 시작" })).toBeVisible();
        await page.getByPlaceholder("이름을 입력하세요").fill("모바일학생");
        await expect(page.getByPlaceholder("이름을 입력하세요")).toHaveValue("모바일학생");
        await expect(page.getByPlaceholder("동명이인일 때 입력")).toHaveAttribute("inputmode", "email");
        await expect(page.getByPlaceholder("동명이인일 때 입력")).toHaveAttribute("autocomplete", "email");
        await expectNoHorizontalOverflow(page);
        expect(consoleProblems).toEqual([]);
    });

    test("shows platform install guidance and suppresses it on work screens", async ({ page }, testInfo) => {
        await page.goto("/");
        await expect(page.getByRole("heading", { name: "OMR Maker" })).toBeVisible();

        if (testInfo.project.name.includes("ios")) {
            await expect(page.getByRole("complementary", { name: "앱 설치 안내" })).toBeVisible({ timeout: 3500 });
            await expect(page.getByText("공유 메뉴에서 홈 화면에 추가를 선택하세요.")).toBeVisible();
        } else {
            await page.waitForTimeout(250);
            await triggerAndroidInstallPrompt(page);
            await expect(page.getByRole("complementary", { name: "앱 설치 안내" })).toBeVisible({ timeout: 2500 });
            await expect(page.getByRole("button", { name: "설치", exact: true })).toBeVisible();
        }

        await page.goto("/create");
        await triggerAndroidInstallPrompt(page);

        await expect(page.getByRole("complementary", { name: "앱 설치 안내" })).toHaveCount(0);
    });

    test("renders the device diagnostics page without blocking app entry", async ({ page }) => {
        const consoleProblems = collectConsoleProblems(page);
        await stubClipboard(page);

        await page.goto("/pwa-check");

        await expect(page.getByRole("heading", { name: "PWA 디바이스 체크" })).toBeVisible();
        await expect(page.getByTestId("pwa-device-verdict")).toContainText("설치 실행 전");
        await expect(page.getByTestId("pwa-device-check-secure-context")).toBeVisible();
        await expect(page.getByTestId("pwa-device-check-display-mode")).toBeVisible();
        await expect(page.getByTestId("pwa-device-check-launch-proof")).toContainText("대기");
        await expect(page.getByTestId("pwa-device-check-service-worker")).toBeVisible();
        await expect(page.getByTestId("pwa-device-check-manifest")).toBeVisible();
        await expect(page.getByTestId("pwa-device-check-overflow")).toContainText("정상");
        await expect(page.getByTestId("pwa-device-report")).toContainText("OMR Maker PWA device check");
        await expect(page.getByTestId("pwa-device-report")).toContainText("displayMode=browser");
        await expect(page.getByTestId("pwa-device-report")).toContainText("displayEvidence=");
        await expect(page.getByTestId("pwa-device-handoff")).toContainText("폰으로 열기");
        await expect(page.getByTestId("pwa-device-handoff-url")).toContainText("/pwa-check");
        await expect(page.getByTestId("pwa-device-handoff-qr")).toBeVisible();
        await expectTouchTarget(page.getByRole("link", { name: "홈" }));
        await expectTouchTarget(page.getByTestId("pwa-device-report-copy"));
        await expectTouchTarget(page.getByRole("button", { name: "검사" }));
        await expectTouchTarget(page.getByTestId("pwa-device-handoff-copy"));
        await expectTouchTarget(page.getByTestId("pwa-device-handoff-share"));

        await page.getByTestId("pwa-device-handoff-copy").click();
        await expect(page.getByTestId("pwa-device-handoff-status")).toContainText("복사됨");
        const copiedHandoffUrl = await page.evaluate(() => (
            (window as Window & { __omrCopiedReport?: string }).__omrCopiedReport || ""
        ));
        expect(copiedHandoffUrl).toContain("/pwa-check");

        await page.getByTestId("pwa-device-report-copy").click();
        await expect(page.getByTestId("pwa-device-copy-status")).toContainText("복사됨");
        const copiedReport = await page.evaluate(() => (
            (window as Window & { __omrCopiedReport?: string }).__omrCopiedReport || ""
        ));
        expect(copiedReport).toContain("OMR Maker PWA device check");
        expect(copiedReport).toContain("displayMode=browser");
        expect(copiedReport).toContain("displayEvidence=");
        expect(copiedReport).toContain("launch-proof=warn:대기");
        expect(copiedReport).toContain("overflow=pass:정상");

        await triggerAndroidInstallPrompt(page);
        await expect(page.getByRole("complementary", { name: "앱 설치 안내" })).toHaveCount(0);
        await expectNoHorizontalOverflow(page);

        await page.getByRole("link", { name: "학생 시작" }).click();

        await expect(page.getByRole("heading", { name: "학습 시작" })).toBeVisible();
        await expectNoHorizontalOverflow(page);
        expect(consoleProblems).toEqual([]);
    });

    test("keeps installed standalone app mode clean and usable", async ({ page }) => {
        const consoleProblems = collectConsoleProblems(page);
        await emulateStandaloneDisplay(page);

        await page.goto("/");
        await expect(page.getByRole("heading", { name: "OMR Maker" })).toBeVisible();
        await expect.poll(async () => page.evaluate(() => (
            window.matchMedia("(display-mode: standalone)").matches
        ))).toBe(true);

        await triggerAndroidInstallPrompt(page);
        await page.waitForTimeout(1000);
        await expect(page.getByRole("complementary", { name: "앱 설치 안내" })).toHaveCount(0);
        await expectNoHorizontalOverflow(page);

        await page.getByRole("button", { name: /학생.*시작하기/ }).click();

        await expect(page.getByRole("heading", { name: "학습 시작" })).toBeVisible();
        await expect(page.getByPlaceholder("이름을 입력하세요")).toHaveCSS("font-size", "16px");
        await expectNoHorizontalOverflow(page);

        const standaloneState = await page.evaluate(() => {
            const layout = document.querySelector(".layout-main");
            const header = document.querySelector(".header");

            return {
                displayMode: window.matchMedia("(display-mode: standalone)").matches,
                headerPaddingTop: header ? window.getComputedStyle(header).paddingTop : null,
                layoutPaddingBottom: layout ? window.getComputedStyle(layout).paddingBottom : null,
                promptCount: document.querySelectorAll(".mobile-install-prompt").length,
                viewport: document.querySelector('meta[name="viewport"]')?.getAttribute("content") || "",
            };
        });

        expect(standaloneState).toMatchObject({
            displayMode: true,
            promptCount: 0,
        });
        expect(standaloneState.viewport).toContain("viewport-fit=cover");

        await page.goto("/pwa-check");
        await expect(page.getByTestId("pwa-device-verdict")).toContainText("앱 실행 통과");
        await expect(page.getByTestId("pwa-device-check-display-mode")).toContainText(/standalone|fullscreen/);
        await expect(page.getByTestId("pwa-device-check-launch-proof")).toContainText("확인됨");
        await expect(page.getByTestId("pwa-device-report")).toContainText("launch-proof=pass:확인됨");
        await expectNoHorizontalOverflow(page);

        expect(consoleProblems).toEqual([]);
    });
});
