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

async function expectSyncedViewportHeight(page: Page) {
    await expect.poll(async () => page.evaluate(() => (
        getComputedStyle(document.documentElement).getPropertyValue("--app-viewport-height").trim()
    ))).toMatch(/^\d+px$/);

    return page.evaluate(() => {
        const value = getComputedStyle(document.documentElement).getPropertyValue("--app-viewport-height").trim();
        const parsedValue = Number.parseInt(value, 10);
        const visualViewportHeight = Math.round(window.visualViewport?.height || window.innerHeight);
        const layout = document.querySelector(".layout-main");

        return {
            keyboardInsetBottom: getComputedStyle(document.documentElement).getPropertyValue("--app-keyboard-inset-bottom").trim(),
            keyboardState: document.documentElement.getAttribute("data-app-keyboard"),
            layoutHeight: layout ? Math.round(layout.getBoundingClientRect().height) : 0,
            parsedValue,
            value,
            visualViewportHeight,
            viewportOffsetTop: getComputedStyle(document.documentElement).getPropertyValue("--app-visual-viewport-offset-top").trim(),
            viewportWidth: getComputedStyle(document.documentElement).getPropertyValue("--app-viewport-width").trim(),
        };
    });
}

async function expectViewportResyncsAfterPageShow(page: Page) {
    await page.evaluate(() => {
        document.documentElement.style.setProperty("--app-viewport-height", "1px");
        document.documentElement.style.setProperty("--app-keyboard-inset-bottom", "999px");
        window.dispatchEvent(new Event("pageshow"));
    });

    await expect.poll(async () => page.evaluate(() => (
        Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue("--app-viewport-height"), 10)
    ))).toBeGreaterThan(100);

    const recovered = await expectSyncedViewportHeight(page);
    expect(recovered.keyboardInsetBottom).not.toBe("999px");
    return recovered;
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
        Object.defineProperty(navigator, "share", {
            configurable: true,
            value: async (payload: ShareData) => {
                (window as Window & { __omrSharedReport?: ShareData }).__omrSharedReport = payload;
            },
        });
    });
}

function validInstalledProofReport(platform: "android" | "ios" = "android"): string {
    const isIos = platform === "ios";
    const displayEvidence = isIos
        ? "css-fullscreen=no · css-standalone=yes · ios-navigator-standalone=yes"
        : "css-fullscreen=no · css-standalone=yes · ios-navigator-standalone=no";
    const userAgent = isIos
        ? "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1"
        : "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7727.15 Mobile Safari/537.36";

    return [
        "OMR Maker PWA device check",
        "url=https://omr-maker-eight.vercel.app/pwa-check",
        "checkedAt=2026. 6. 22. 4시 10분 00초",
        "verdict=앱 실행 통과",
        "displayMode=standalone",
        "installedDisplay=yes",
        "proofStatus=pass",
        `displayEvidence=${displayEvidence}`,
        "summary=15 pass, 0 warn, 0 fail",
        `userAgent=${userAgent}`,
        "- secure-context=pass:보안 컨텍스트 (https://omr-maker-eight.vercel.app)",
        "- display-mode=pass:standalone (홈 화면 아이콘 실행 상태)",
        `- launch-proof=pass:확인됨 (${displayEvidence})`,
        "- service-worker=pass:제어 중 (script=https://omr-maker-eight.vercel.app/sw.js · controller=yes · active=activated · waiting=none · installing=none)",
        "- offline-cache=pass:준비 (caches=omr-maker-v9-shell, omr-maker-v9-runtime · required=/, /pwa-check, /offline.html, /logo.png · expected=omr-maker-v9-shell · missingCaches=none · missing=none)",
        "- manifest=pass:standalone (OMR Maker · icons 12 · screenshots 2)",
        "- viewport=pass:cover (width=device-width, initial-scale=1, viewport-fit=cover)",
        "- viewport-height=pass:동기화 (css=727px · visual=727px · inner=727px · delta=0px)",
        "- keyboard-safe-area=pass:준비 (keyboard=0px · state=closed · width=393px · offsetTop=0px · offsetLeft=0px · scale=1)",
        "- mobile-meta=pass:준비 (Android yes · iOS yes)",
        "- ios-startup-image=pass:준비 (16 images · iPhone portrait yes · iPad portrait yes · iPad landscape yes)",
        "- handoff-origin=pass:공유 가능 (https://omr-maker-eight.vercel.app/pwa-check)",
        "- overflow=pass:정상 (scroll 393px / viewport 393px)",
        "- storage=pass:사용 가능 (localStorage ok · sessionStorage ok · indexedDB ok · quota=512MB · usage=1MB · persisted=unknown)",
        "- install-prompt=pass:없음 (진단 화면에는 설치 배너 없음)",
    ].join("\n");
}

async function seedStudentSession(page: Page) {
    await page.addInitScript(() => {
        const studentSession = {
            groupId: "mobile-qa-group",
            groupName: "모바일반",
            identityType: "temporary",
            isGuest: false,
            name: "모바일학생",
            studentId: "mobile-qa-student",
        };
        const payload = JSON.stringify({ ...studentSession, savedAt: Date.now() });
        try {
            window.sessionStorage.setItem("omr_student_session", payload);
            window.localStorage.setItem("omr_student_session_backup", payload);
        } catch {}
    });
}

async function seedMobileSolveExam(page: Page) {
    await page.addInitScript(() => {
        const exam = {
            id: "mobile-qa-exam",
            title: "모바일 실전 시험",
            createdAt: "2026-06-22T00:00:00.000Z",
            durationMin: 30,
            questions: [
                { id: 1, number: 1, answer: 2, choices: 4, score: 25 },
                { id: 2, number: 2, answer: 4, choices: 4, score: 25 },
                { id: 3, number: 3, answer: 1, choices: 5, score: 25 },
                { id: 4, number: 4, answer: 3, choices: 5, score: 25 },
            ],
            updatedAt: "2026-06-22T00:00:00.000Z",
            accessConfig: { type: "public" },
        };
        const studentSession = {
            groupId: "mobile-qa-group",
            groupName: "모바일반",
            identityType: "temporary",
            isGuest: false,
            name: "모바일학생",
            studentId: "mobile-qa-student",
            createdAt: "2026-06-22T00:00:00.000Z",
        };
        const sessionPayload = JSON.stringify(studentSession);
        try {
            window.localStorage.setItem("omr_exam_mobile-qa-exam", JSON.stringify(exam));
            window.localStorage.setItem("omr_student_session_backup", sessionPayload);
            window.sessionStorage.setItem("omr_student_session", sessionPayload);
            window.localStorage.setItem("omr_solve_panel_mobile-qa-exam_mobile-qa-student", "expanded");
        } catch {}
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
        const viewportHeightState = await expectSyncedViewportHeight(page);
        expect(viewportHeightState.parsedValue).toBeGreaterThan(0);
        expect(Math.abs(viewportHeightState.parsedValue - viewportHeightState.visualViewportHeight)).toBeLessThanOrEqual(2);
        expect(viewportHeightState.viewportWidth).toMatch(/^\d+px$/);
        expect(viewportHeightState.viewportOffsetTop).toMatch(/^\d+px$/);
        expect(viewportHeightState.keyboardInsetBottom).toMatch(/^\d+px$/);
        expect(viewportHeightState.keyboardState).toMatch(/open|closed/);
        const pageShowViewportState = await expectViewportResyncsAfterPageShow(page);
        expect(Math.abs(pageShowViewportState.parsedValue - pageShowViewportState.visualViewportHeight)).toBeLessThanOrEqual(2);
        await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
        await expect(page.locator('link[rel="apple-touch-icon"]').first()).toHaveAttribute("href", "/apple-touch-icon.png");
        await expectMetaContent(page, "mobile-web-app-capable", "yes");
        await expectMetaContent(page, "apple-mobile-web-app-capable", "yes");
        const startupImages = await page.locator('link[rel="apple-touch-startup-image"]').evaluateAll(links => (
            links.map(link => ({
                href: link.getAttribute("href") || "",
                media: link.getAttribute("media") || "",
            }))
        ));
        expect(startupImages.length).toBeGreaterThanOrEqual(12);
        expect(startupImages.every(image => image.href.startsWith("/startup/"))).toBe(true);
        expect(startupImages.some(image => image.media.includes("device-width: 393px") && image.media.includes("orientation: portrait"))).toBe(true);
        expect(startupImages.some(image => image.media.includes("device-width: 834px") && image.media.includes("orientation: landscape"))).toBe(true);
        const manifestState = await page.evaluate(async () => {
            const manifestUrl = document.querySelector('link[rel="manifest"]')?.getAttribute("href") || "";
            const manifest = await fetch(manifestUrl).then(response => response.json());
            return {
                launchHandler: manifest.launch_handler?.client_mode || [],
                shortcutUrls: (manifest.shortcuts || []).map((shortcut: { url?: string }) => shortcut.url),
            };
        });
        expect(manifestState.shortcutUrls).toEqual(expect.arrayContaining(["/create", "/teacher/dashboard", "/?role=student", "/pwa-check"]));
        expect(manifestState.launchHandler).toEqual(expect.arrayContaining(["navigate-existing", "auto"]));
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

    test("keeps signed-in student app chrome touch friendly", async ({ page }) => {
        await seedStudentSession(page);

        await page.goto("/student/dashboard");

        await expect(page.getByRole("heading", { name: "모바일학생님," })).toBeVisible();
        await expectTouchTarget(page.getByRole("button", { name: "로그아웃" }));
        await expectTouchTarget(page.getByRole("link", { name: /나의 원시험 평균/ }));
        await expectNoHorizontalOverflow(page);

        await page.goto("/student/history");

        await expect(page.getByRole("heading", { name: "내 시험 기록" })).toBeVisible();
        await expectTouchTarget(page.getByRole("link", { name: "내 시험 기록", exact: true }));
        await expectTouchTarget(page.getByRole("link", { name: "시험 응시하러 가기" }));
        await expectNoHorizontalOverflow(page);

        await page.goto("/?role=teacher");

        await expect(page.getByRole("heading", { name: "환영합니다" })).toBeVisible();
        await expectTouchTarget(page.getByRole("button", { name: "역할 선택으로" }));
        await expectNoHorizontalOverflow(page);
    });

    test("lets students answer and submit an exam in the phone and tablet app shell", async ({ page }) => {
        const consoleProblems = collectConsoleProblems(page);
        await seedMobileSolveExam(page);

        await page.goto("/solve/mobile-qa-exam");

        await expect(page.locator(".solve-omr-scroll .omr-cardview-title").getByText("모바일 실전 시험")).toBeVisible();
        await expectTouchTarget(page.getByRole("link", { name: "OMR Maker" }));
        await expectTouchTarget(page.locator(".solve-controls .solve-collapse-button"));
        await expectTouchTarget(page.locator(".solve-controls .solve-submit-button"));
        await expectTouchTarget(page.getByRole("button", { name: "문제 1번 보기 2" }));
        await expectNoHorizontalOverflow(page);
        expect(await smallTargets(page, ".solve-controls button, .solve-controls label, .solve-omr-scroll .q-bubble, .solve-omr-next-button, .solve-omr-pane-close")).toEqual([]);

        await page.getByRole("button", { name: "문제 1번 보기 2" }).click();
        await page.getByRole("button", { name: "문제 2번 보기 4" }).click();
        await page.getByRole("button", { name: "문제 3번 보기 1" }).click();
        await page.getByRole("button", { name: "문제 4번 보기 3" }).click();

        await expect(page.locator(".solve-progress")).toContainText("4/4");
        await expectNoHorizontalOverflow(page);

        await page.getByRole("button", { name: "제출하기" }).click();

        const submitDialog = page.getByRole("dialog", { name: "답안 제출" });
        await expect(submitDialog).toBeVisible();
        await expect(submitDialog).toContainText("전체 4문항 답안을 모두 선택했습니다.");
        await expectTouchTarget(submitDialog.getByRole("button", { name: "계속 풀기" }));
        await expectTouchTarget(submitDialog.getByRole("button", { name: "제출하기" }));

        await submitDialog.getByRole("button", { name: "제출하기" }).click();

        await expect(page).toHaveURL(/\/student\/review\/\d+/);
        await expect(page.getByRole("heading", { name: "모바일 실전 시험" })).toBeVisible();
        await expect(page.getByText("100%")).toBeVisible();
        await expectNoHorizontalOverflow(page);

        const savedAttempt = await page.evaluate(() => {
            const attempts = JSON.parse(window.localStorage.getItem("omr_attempts") || "[]");
            return attempts.find((attempt: { examId?: string }) => attempt.examId === "mobile-qa-exam") || null;
        });
        expect(savedAttempt).toMatchObject({
            answers: { 1: 2, 2: 4, 3: 1, 4: 3 },
            examId: "mobile-qa-exam",
            score: 100,
            status: "completed",
            studentId: "mobile-qa-student",
            studentName: "모바일학생",
            totalScore: 100,
        });
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
        await expect(page.getByRole("link", { name: "앱 상태 체크" })).toHaveAttribute("href", "/pwa-check");
        await expectTouchTarget(page.getByRole("link", { name: "앱 상태 체크" }));

        await page.getByRole("link", { name: "앱 상태 체크" }).click();
        await expect(page).toHaveURL(/\/pwa-check$/);
        await expect(page.getByRole("heading", { name: "PWA 디바이스 체크" })).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await page.waitForLoadState("load");
        await page.waitForLoadState("networkidle");

        await page.goto("/");
        await expect(page.getByRole("heading", { name: "OMR Maker" })).toBeVisible();
        await page.getByRole("button", { name: /학생.*시작하기/ }).click();

        await expect(page.getByRole("heading", { name: "학습 시작" })).toBeVisible();
        await expect(page.locator(".home-page")).toHaveAttribute("data-home-role", "student");
        await expect(page.getByRole("complementary", { name: "앱 설치 안내" })).toHaveCount(0);

        await page.goto("/create");
        await triggerAndroidInstallPrompt(page);

        await expect(page.getByRole("complementary", { name: "앱 설치 안내" })).toHaveCount(0);
    });

    test("renders the device diagnostics page without blocking app entry", async ({ page }, testInfo) => {
        const consoleProblems = collectConsoleProblems(page);
        await stubClipboard(page);

        await page.goto("/pwa-check");

        await expect(page.getByRole("heading", { name: "PWA 디바이스 체크" })).toBeVisible();
        await expect(page.getByTestId("pwa-device-verdict")).toContainText("설치 실행 전");
        await expect(page.getByTestId("pwa-device-check-secure-context")).toBeVisible();
        await expect(page.getByTestId("pwa-device-check-display-mode")).toBeVisible();
        await expect(page.getByTestId("pwa-device-check-launch-proof")).toContainText("대기");
        await expect(page.getByTestId("pwa-device-check-service-worker")).toBeVisible();
        await expect(page.getByTestId("pwa-device-check-offline-cache")).toBeVisible();
        await expect(page.getByTestId("pwa-device-check-manifest")).toBeVisible();
        await expect(page.getByTestId("pwa-device-check-handoff-origin")).toContainText(/공유 가능|로컬 전용/);
        await expect(page.getByTestId("pwa-device-check-viewport-height")).toContainText("동기화");
        await expect(page.getByTestId("pwa-device-check-keyboard-safe-area")).toContainText("준비");
        await expect(page.getByTestId("pwa-device-check-ios-startup-image")).toContainText("준비");
        await expect(page.getByTestId("pwa-device-check-overflow")).toContainText("정상");
        await expect(page.getByTestId("pwa-device-check-storage")).toContainText("indexedDB ok");
        await expect(page.getByTestId("pwa-device-report")).toContainText("OMR Maker PWA device check");
        await expect(page.getByTestId("pwa-device-report")).toContainText("displayMode=browser");
        await expect(page.getByTestId("pwa-device-report")).toContainText("installedDisplay=no");
        await expect(page.getByTestId("pwa-device-report")).toContainText("proofStatus=pending");
        await expect(page.getByTestId("pwa-device-report")).toContainText("displayEvidence=");
        await expect(page.getByTestId("pwa-device-report")).toContainText("viewport-height=pass:동기화");
        await expect(page.getByTestId("pwa-device-report")).toContainText("keyboard-safe-area=pass:준비");
        await expect(page.getByTestId("pwa-device-report")).toContainText("ios-startup-image=pass:준비");
        await expect(page.getByTestId("pwa-install-proof-guide")).toContainText("실기기 설치 확인");
        await expect(page.getByTestId("pwa-install-proof-guide")).toContainText("standalone");
        await expect(page.getByTestId("pwa-install-proof-guide")).toContainText("fullscreen");
        await expect(page.getByTestId("pwa-install-proof-step-1")).toContainText("실기기 열기");
        await expect(page.getByTestId("pwa-install-proof-step-2")).toContainText("홈 화면 추가");
        await expect(page.getByTestId("pwa-install-proof-step-3")).toContainText("아이콘 실행");
        await expect(page.getByTestId("pwa-install-proof-android")).toContainText("Android");
        await expect(page.getByTestId("pwa-install-proof-ios")).toContainText("iOS");
        await expect(page.getByTestId("pwa-device-handoff")).toContainText("폰으로 열기");
        await expect(page.getByTestId("pwa-device-handoff-url")).toContainText("/pwa-check");
        await expect(page.getByTestId("pwa-device-handoff-qr")).toBeVisible();
        await expect(page.getByTestId("pwa-proof-verifier")).toBeVisible();
        await expect(page.getByTestId("pwa-proof-result")).toContainText("리포트 대기");
        await expect(page.getByTestId("pwa-proof-slot-android")).toContainText("Android");
        await expect(page.getByTestId("pwa-proof-slot-ios")).toContainText("iOS");
        await expect(page.getByTestId("pwa-proof-result-android")).toContainText("Android 리포트 대기");
        await expect(page.getByTestId("pwa-proof-result-ios")).toContainText("iOS 리포트 대기");
        await expectTouchTarget(page.getByRole("link", { name: "홈" }));
        await expectTouchTarget(page.getByTestId("pwa-device-report-copy"));
        await expectTouchTarget(page.getByTestId("pwa-device-report-share"));
        await expectTouchTarget(page.getByRole("button", { name: "검사" }));
        await expectTouchTarget(page.getByTestId("pwa-device-handoff-copy"));
        await expectTouchTarget(page.getByTestId("pwa-device-handoff-share"));
        await expectTouchTarget(page.getByTestId("pwa-install-proof-step-1"));
        await expectTouchTarget(page.getByTestId("pwa-install-proof-step-2"));
        await expectTouchTarget(page.getByTestId("pwa-install-proof-step-3"));

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
        expect(copiedReport).toContain("installedDisplay=no");
        expect(copiedReport).toContain("proofStatus=pending");
        expect(copiedReport).toContain("displayEvidence=");
        expect(copiedReport).toContain("launch-proof=warn:대기");
        expect(copiedReport).toContain("handoff-origin=");
        expect(copiedReport).toContain("offline-cache=");
        expect(copiedReport).toContain("viewport-height=pass:동기화");
        expect(copiedReport).toContain("keyboard-safe-area=pass:준비");
        expect(copiedReport).toContain("overflow=pass:정상");
        expect(copiedReport).toContain("indexedDB ok");

        const currentProofInputId = testInfo.project.name.includes("ios") ? "pwa-proof-input-ios" : "pwa-proof-input";
        const currentProofResultId = testInfo.project.name.includes("ios") ? "pwa-proof-result-ios" : "pwa-proof-result-android";
        const currentProofErrorsId = testInfo.project.name.includes("ios") ? "pwa-proof-errors-ios" : "pwa-proof-errors";

        await page.getByTestId(currentProofInputId).fill(copiedReport);
        await expect(page.getByTestId("pwa-proof-result")).toContainText("리포트 미통과");
        await expect(page.getByTestId(currentProofResultId)).toContainText("리포트 미통과");
        await expect(page.getByTestId(currentProofErrorsId)).toContainText("proofStatus must be pass");
        await expect(page.getByTestId(currentProofErrorsId)).toContainText("installedDisplay must be yes");

        await page.getByTestId("pwa-device-report-share").click();
        await expect(page.getByTestId("pwa-device-copy-status")).toContainText("공유됨");
        const sharedReport = await page.evaluate(() => (
            (window as Window & { __omrSharedReport?: ShareData }).__omrSharedReport
        ));
        expect(sharedReport?.title).toBe("OMR Maker PWA device check");
        expect(sharedReport?.text).toContain("OMR Maker PWA device check");
        expect(sharedReport?.text).toContain("proofStatus=pending");
        expect(sharedReport?.url).toContain("/pwa-check");

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
        await stubClipboard(page);

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
                layoutHeight: layout ? Math.round(layout.getBoundingClientRect().height) : 0,
                layoutPaddingBottom: layout ? window.getComputedStyle(layout).paddingBottom : null,
                promptCount: document.querySelectorAll(".mobile-install-prompt").length,
                viewport: document.querySelector('meta[name="viewport"]')?.getAttribute("content") || "",
                viewportHeightVar: getComputedStyle(document.documentElement).getPropertyValue("--app-viewport-height").trim(),
                viewportKeyboardState: document.documentElement.getAttribute("data-app-keyboard"),
                viewportKeyboardVar: getComputedStyle(document.documentElement).getPropertyValue("--app-keyboard-inset-bottom").trim(),
            };
        });

        expect(standaloneState).toMatchObject({
            displayMode: true,
            promptCount: 0,
        });
        expect(standaloneState.viewport).toContain("viewport-fit=cover");
        expect(standaloneState.viewportHeightVar).toMatch(/^\d+px$/);
        expect(standaloneState.viewportKeyboardVar).toMatch(/^\d+px$/);
        expect(standaloneState.viewportKeyboardState).toMatch(/open|closed/);
        expect(standaloneState.layoutHeight).toBeGreaterThan(0);

        await page.goto("/pwa-check");
        await expect(page.getByTestId("pwa-device-verdict")).toContainText("앱 실행 통과");
        await expect(page.getByTestId("pwa-device-check-display-mode")).toContainText(/standalone|fullscreen/);
        await expect(page.getByTestId("pwa-device-check-launch-proof")).toContainText("확인됨");
        await expect(page.getByTestId("pwa-device-report")).toContainText("installedDisplay=yes");
        await expect(page.getByTestId("pwa-device-report")).toContainText("proofStatus=pass");
        await expect(page.getByTestId("pwa-device-report")).toContainText("launch-proof=pass:확인됨");
        await expect(page.getByTestId("pwa-device-report")).toContainText("handoff-origin=");
        await expect(page.getByTestId("pwa-device-report")).toContainText("offline-cache=");
        await expect(page.getByTestId("pwa-device-report")).toContainText("viewport-height=pass:동기화");
        await expect(page.getByTestId("pwa-device-report")).toContainText("keyboard-safe-area=pass:준비");
        await page.getByTestId("pwa-proof-input").fill(validInstalledProofReport("android"));
        await page.getByTestId("pwa-proof-input-ios").fill(validInstalledProofReport("ios"));
        await expect(page.getByTestId("pwa-proof-result")).toContainText("Android/iOS 리포트 통과");
        await expect(page.getByTestId("pwa-proof-result-android")).toContainText("Android 리포트 통과");
        await expect(page.getByTestId("pwa-proof-result-ios")).toContainText("iOS 리포트 통과");
        await expect(page.getByTestId("pwa-proof-errors")).toContainText("installed home-screen launch verified");
        await expect(page.getByTestId("pwa-proof-errors-ios")).toContainText("installed home-screen launch verified");
        await expect(page.getByTestId("pwa-proof-bundle")).toContainText("Android/iOS 통합 proof");
        await expect(page.getByTestId("pwa-proof-bundle-report")).toContainText("OMR Maker PWA dual device proof");
        await expect(page.getByTestId("pwa-proof-bundle-report")).toContainText("-----BEGIN ANDROID PWA REPORT-----");
        await expect(page.getByTestId("pwa-proof-bundle-report")).toContainText("-----BEGIN IOS PWA REPORT-----");
        await expectTouchTarget(page.getByTestId("pwa-proof-bundle-copy"));
        await expectTouchTarget(page.getByTestId("pwa-proof-bundle-share"));
        await page.getByTestId("pwa-proof-bundle-copy").click();
        await expect(page.getByTestId("pwa-proof-bundle-status")).toContainText("복사됨");
        const copiedProofBundle = await page.evaluate(() => (
            (window as Window & { __omrCopiedReport?: string }).__omrCopiedReport || ""
        ));
        expect(copiedProofBundle).toContain("OMR Maker PWA dual device proof");
        expect(copiedProofBundle).toContain("requiredDevices=Android, iOS");
        expect(copiedProofBundle).toContain("-----BEGIN ANDROID PWA REPORT-----");
        expect(copiedProofBundle).toContain("-----BEGIN IOS PWA REPORT-----");
        await expectNoHorizontalOverflow(page);

        expect(consoleProblems).toEqual([]);
    });
});
