import { expect, test, type Locator, type Page } from "@playwright/test";

const VALID_PROOF_EPOCH = Date.now();
const MOBILE_SOLVE_DRAFT_KEY = "omr_draft_mobile-qa-exam_mobile-qa-student_base";

async function clearStorage(page: Page) {
    await page.addInitScript(() => {
        const clearedKey = "__omr_e2e_storage_cleared";
        try {
            if (window.sessionStorage.getItem(clearedKey) === "1") return;
        } catch {}
        try { window.localStorage.clear(); } catch {}
        try { window.sessionStorage.clear(); } catch {}
        try { window.sessionStorage.setItem(clearedKey, "1"); } catch {}
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

async function continueSolveEntryAsStudentIfPresent(page: Page) {
    await page.waitForFunction(() => (
        document.body.innerText.includes("시험 입장 확인")
        || !!document.querySelector(".solve-body")
    ), null, { timeout: 5_000 }).catch(() => {});

    const entryDialog = page.getByRole("dialog", { name: "시험 입장 확인" });
    if (await entryDialog.isVisible().catch(() => false)) {
        await expectTouchTarget(entryDialog.getByRole("button", { name: "학생으로 시험 보기" }));
        await entryDialog.getByRole("button", { name: "학생으로 시험 보기" }).click();
        await expect(entryDialog).toBeHidden();
    }
}

function isLocalAppUrl(urlValue: string): boolean {
    const url = new URL(urlValue);
    return url.hostname === "localhost"
        || url.hostname === "127.0.0.1"
        || url.hostname === "::1"
        || url.hostname.endsWith(".localhost");
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
        `checkedAtEpoch=${VALID_PROOF_EPOCH}`,
        "verdict=앱 실행 통과",
        "displayMode=standalone",
        "installedDisplay=yes",
        "proofStatus=pass",
        `displayEvidence=${displayEvidence}`,
        "summary=16 pass, 0 warn, 0 fail",
        `userAgent=${userAgent}`,
        "- secure-context=pass:보안 컨텍스트 (https://omr-maker-eight.vercel.app)",
        "- display-mode=pass:standalone (홈 화면 아이콘 실행 상태)",
        `- launch-proof=pass:확인됨 (${displayEvidence})`,
        "- service-worker=pass:제어 중 (script=https://omr-maker-eight.vercel.app/sw.js · controller=yes · active=activated · waiting=none · installing=none)",
        "- offline-cache=pass:준비 (caches=omr-maker-v15-shell, omr-maker-v15-runtime · required=/, /pwa-check, /offline.html, /logo.png · expected=omr-maker-v15-shell · missingCaches=none · missing=none)",
        "- manifest=pass:standalone (OMR Maker · icons 12 · screenshots 2)",
        "- viewport=pass:cover (width=device-width, initial-scale=1, viewport-fit=cover)",
        "- viewport-height=pass:동기화 (css=727px · visual=727px · inner=727px · delta=0px)",
        "- keyboard-safe-area=pass:준비 (keyboard=0px · state=closed · width=393px · offsetTop=0px · offsetLeft=0px · scale=1)",
        "- mobile-meta=pass:준비 (Android yes · iOS yes)",
        "- ios-startup-image=pass:준비 (16 images · iPhone portrait yes · iPad portrait yes · iPad landscape yes)",
        "- handoff-origin=pass:공유 가능 (https://omr-maker-eight.vercel.app/pwa-check)",
        "- overflow=pass:정상 (scroll 393px / viewport 393px)",
        "- storage=pass:사용 가능 (localStorage ok · sessionStorage ok · indexedDB ok · quota=512MB · usage=1MB · persisted=unknown)",
        "- runtime-performance=pass:쾌적 (domReady=742ms · load=980ms · response=180ms · fcp=520ms · longTasks=not-sampled · budget=3000/5000ms)",
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
        } catch {}
    });
}

test.describe("Mobile PWA entry", () => {
    test.beforeEach(async ({ page }) => {
        await clearStorage(page);
    });

    test("advertises app metadata and opens the student flow without mobile overflow", async ({ page }, testInfo) => {
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
        const viewportContent = await page.locator('meta[name="viewport"]').getAttribute("content");
        expect(viewportContent).toContain("viewport-fit=cover");
        if (testInfo.project.name.includes("ios")) {
            expect(viewportContent).not.toContain("interactive-widget=");
        } else {
            expect(viewportContent).toContain("interactive-widget=resizes-content");
        }
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
        const studentLookupInput = page.getByLabel("학생번호 또는 이메일");
        await expect(studentLookupInput).toHaveAttribute("placeholder", "선생님이 알려준 학생번호 또는 이메일");
        await expect(studentLookupInput).toHaveAttribute("inputmode", "email");
        await expect(studentLookupInput).toHaveAttribute("autocomplete", "email");
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
        await continueSolveEntryAsStudentIfPresent(page);

        const startsWithFloatingRail = await page.evaluate(() => window.matchMedia("(min-width: 600px)").matches);
        if (startsWithFloatingRail) {
            await expect(page.locator("#solve-omr-pane")).toHaveClass(/is-collapsed/);
            const floatingRailButton = page.locator(".solve-omr-rail-button");
            await expect(floatingRailButton).toBeVisible();
            await expectTouchTarget(floatingRailButton);
            await floatingRailButton.click();
        }

        await expect(page.locator(".solve-omr-scroll .omr-cardview-title").getByText("모바일 실전 시험")).toBeVisible();
        await expectTouchTarget(page.getByRole("link", { name: "OMR Maker" }));
        await expectTouchTarget(page.locator(".solve-controls .solve-collapse-button"));
        await expectTouchTarget(page.locator(".solve-controls .solve-submit-button"));
        await expectTouchTarget(page.getByRole("button", { name: "1번 문항으로 이동" }));
        const firstQuestionGroup = page.getByRole("radiogroup", { name: /문제 1번/ });
        const firstAnswer = firstQuestionGroup.getByRole("radio", { name: "문제 1번 보기 2" });
        await expect(firstQuestionGroup).toContainText("미응답");
        await expectTouchTarget(firstAnswer);
        await expect(firstAnswer).toHaveAttribute("aria-checked", "false");
        await expect(firstQuestionGroup.getByRole("radio", { name: "문제 1번 보기 1" })).toHaveAttribute("tabindex", "0");
        await expect(firstAnswer).toHaveAttribute("tabindex", "-1");
        await expectNoHorizontalOverflow(page);
        expect(await smallTargets(page, ".solve-controls button, .solve-controls label, .solve-omr-scroll .q-bubble, .solve-omr-next-button, .solve-omr-pane-close")).toEqual([]);
        const solveLayout = await page.evaluate(() => {
            const body = document.querySelector<HTMLElement>(".solve-body");
            const bodyRect = body?.getBoundingClientRect();
            const pdf = document.querySelector<HTMLElement>(".solve-pdf-pane")?.getBoundingClientRect();
            const paneElement = document.querySelector<HTMLElement>("#solve-omr-pane");
            const pane = document.querySelector<HTMLElement>("#solve-omr-pane")?.getBoundingClientRect();
            const title = document.querySelector<HTMLElement>(".solve-title")?.getBoundingClientRect();
            return {
                isTablet: window.matchMedia("(min-width: 600px) and (max-width: 1180px)").matches,
                direction: body ? getComputedStyle(body).flexDirection : null,
                panePosition: paneElement ? getComputedStyle(paneElement).position : null,
                paneBackdrop: paneElement ? getComputedStyle(paneElement).backdropFilter : null,
                paneWidth: pane?.width ?? null,
                paneRight: pane?.right ?? null,
                bodyWidth: bodyRect?.width ?? null,
                bodyRight: bodyRect?.right ?? null,
                pdfWidth: pdf?.width ?? null,
                titleWidth: title?.width ?? null,
            };
        });
        if (solveLayout.isTablet) {
            expect(solveLayout.direction).toBe("row");
            expect(solveLayout.panePosition).toBe("absolute");
            expect(solveLayout.paneBackdrop).toContain("blur");
            expect(solveLayout.paneWidth).toBeGreaterThanOrEqual(280);
            expect(solveLayout.paneWidth).toBeLessThanOrEqual(320);
            expect(Math.abs((solveLayout.bodyWidth ?? 0) - (solveLayout.pdfWidth ?? 0))).toBeLessThanOrEqual(2);
            // iPad WebKit reserves roughly one scrollbar/safe-area gutter in
            // addition to the 12px visual inset; keep the panel anchored within
            // a compact edge gutter without requiring Chromium-identical geometry.
            expect(Math.abs((solveLayout.bodyRight ?? 0) - (solveLayout.paneRight ?? 0))).toBeLessThanOrEqual(32);
            expect(solveLayout.titleWidth).toBeGreaterThanOrEqual(72);
        }
        const solveHeaderRects = await page.evaluate(() => {
            const brand = document.querySelector<HTMLElement>(".solve-brand")?.getBoundingClientRect();
            const title = document.querySelector<HTMLElement>(".solve-title")?.getBoundingClientRect();
            return brand && title ? { brandRight: brand.right, titleLeft: title.left } : null;
        });
        expect(solveHeaderRects).not.toBeNull();
        expect(solveHeaderRects!.brandRight).toBeLessThanOrEqual(solveHeaderRects!.titleLeft);

        await page.getByRole("button", { name: "1번 문항으로 이동" }).click();
        await expect(page.locator("#solve-omr-pane")).toHaveClass(/is-collapsed/);
        await expect(page.locator("#solve-omr-pane")).toHaveAttribute("aria-hidden", "true");
        await expect(page.locator("#solve-omr-pane")).toHaveAttribute("inert", "");
        const collapsedOverlay = await page.evaluate(() => {
            const body = document.querySelector<HTMLElement>(".solve-body")?.getBoundingClientRect();
            const pdf = document.querySelector<HTMLElement>(".solve-pdf-pane")?.getBoundingClientRect();
            const rail = document.querySelector<HTMLElement>(".solve-omr-rail");
            const railStyle = rail ? getComputedStyle(rail) : null;
            return {
                isFloatingOverlay: window.matchMedia("(min-width: 600px)").matches,
                pdfKeepsFullWidth: body && pdf ? Math.abs(body.width - pdf.width) <= 2 : false,
                railPosition: railStyle?.position ?? null,
                railBackdrop: railStyle?.backdropFilter ?? null,
                railVisibility: railStyle?.visibility ?? null,
            };
        });
        if (collapsedOverlay.isFloatingOverlay) {
            expect(collapsedOverlay.pdfKeepsFullWidth).toBe(true);
            expect(collapsedOverlay.railPosition).toBe("absolute");
            expect(collapsedOverlay.railBackdrop).toContain("blur");
            expect(collapsedOverlay.railVisibility).toBe("visible");
        }
        const reopenAnswerSheet = page.locator(".solve-controls .solve-collapse-button");
        await expect(reopenAnswerSheet).toHaveAttribute("aria-label", "답안지 펼치기");
        await expectTouchTarget(reopenAnswerSheet);
        await reopenAnswerSheet.click();
        await expect(page.locator("#solve-omr-pane")).not.toHaveClass(/is-collapsed/);
        await expect(page.locator("#solve-omr-pane")).toHaveAttribute("aria-hidden", "false");
        await expect(page.locator("#solve-omr-pane")).not.toHaveAttribute("inert", "");

        await firstAnswer.click();
        await expect(firstAnswer).toHaveAttribute("aria-checked", "true");
        await expect(firstAnswer).toHaveAttribute("tabindex", "0");
        await expect(firstQuestionGroup.getByRole("radio", { name: "문제 1번 보기 1" })).toHaveAttribute("tabindex", "-1");
        await firstQuestionGroup.getByRole("radio", { name: "문제 1번 보기 2" }).press("ArrowRight");
        await expect(firstQuestionGroup.getByRole("radio", { name: "문제 1번 보기 3" })).toHaveAttribute("aria-checked", "true");
        await expect(firstQuestionGroup.getByRole("radio", { name: "문제 1번 보기 3" })).toHaveAttribute("tabindex", "0");
        await expect(firstAnswer).toHaveAttribute("tabindex", "-1");
        await firstQuestionGroup.getByRole("radio", { name: "문제 1번 보기 3" }).press("ArrowLeft");
        await expect(firstAnswer).toHaveAttribute("aria-checked", "true");
        await expect.poll(async () => page.evaluate((draftKey) => {
            const draft = JSON.parse(window.localStorage.getItem(draftKey) || "{}");
            return draft.answers?.["1"];
        }, MOBILE_SOLVE_DRAFT_KEY)).toBe(2);

        await page.getByRole("radio", { name: "문제 2번 보기 4" }).click();
        await page.evaluate(() => {
            window.dispatchEvent(new Event("pagehide"));
        });
        const backgroundDraft = await page.evaluate((draftKey) => (
            JSON.parse(window.localStorage.getItem(draftKey) || "{}")
        ), MOBILE_SOLVE_DRAFT_KEY);
        expect(backgroundDraft.answers).toMatchObject({ "1": 2, "2": 4 });
        expect(backgroundDraft.drawings).toBeUndefined();

        await page.reload();
        await continueSolveEntryAsStudentIfPresent(page);
        await expect(page.locator(".solve-omr-scroll .omr-cardview-title").getByText("모바일 실전 시험")).toBeVisible();
        await expect(page.getByRole("radio", { name: "문제 1번 보기 2" })).toHaveClass(/marked/);
        await expect(page.getByRole("radio", { name: "문제 2번 보기 4" })).toHaveClass(/marked/);
        await expect(page.locator(".solve-progress")).toContainText("2/4");
        await expectNoHorizontalOverflow(page);

        await page.getByRole("radio", { name: "문제 3번 보기 1" }).click();
        await page.evaluate(() => {
            Object.defineProperty(document, "visibilityState", {
                configurable: true,
                value: "hidden",
            });
            document.dispatchEvent(new Event("visibilitychange"));
        });
        await expect.poll(async () => page.evaluate((draftKey) => {
            const draft = JSON.parse(window.localStorage.getItem(draftKey) || "{}");
            return draft.answers?.["3"];
        }, MOBILE_SOLVE_DRAFT_KEY)).toBe(1);
        await page.evaluate(() => {
            Object.defineProperty(document, "visibilityState", {
                configurable: true,
                value: "visible",
            });
            document.dispatchEvent(new Event("visibilitychange"));
        });
        const focusWarning = page.getByRole("dialog", { name: /시험 이탈 경고/ });
        await expect(focusWarning).toBeVisible();
        await expect(focusWarning).toContainText(/현재 이탈 횟수:\s*\d+회/);
        const returnToExamButton = focusWarning.getByRole("button", { name: "시험으로 돌아가기" });
        await expectTouchTarget(returnToExamButton);
        await returnToExamButton.click();
        await expect(focusWarning).toBeHidden();

        await page.getByRole("radio", { name: "문제 4번 보기 3" }).click();

        await expect(page.locator(".solve-progress")).toContainText("4/4");
        await expectNoHorizontalOverflow(page);

        await page.getByRole("button", { name: "제출하기" }).click();

        const submitDialog = page.getByRole("dialog", { name: "답안 제출" });
        await expect(submitDialog).toBeVisible();
        await expect(submitDialog).toContainText("전체 4문항 답안을 모두 선택했습니다.");
        await expectTouchTarget(submitDialog.getByRole("button", { name: "계속 풀기" }));
        await expectTouchTarget(submitDialog.getByRole("button", { name: "제출하기" }));
        await expect(submitDialog.getByRole("button", { name: "닫기" })).toBeFocused();

        await page.keyboard.press("Escape");
        await expect(submitDialog).toBeHidden();
        await expect(page.locator(".solve-submit-button")).toBeFocused();

        await page.locator(".solve-submit-button").click();
        await expect(submitDialog).toBeVisible();
        await expect(submitDialog.getByRole("button", { name: "닫기" })).toBeFocused();
        await page.keyboard.press("Shift+Tab");
        await expect(submitDialog.getByRole("button", { name: "제출하기" })).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(submitDialog.getByRole("button", { name: "닫기" })).toBeFocused();

        await submitDialog.getByRole("button", { name: "제출하기" }).click();

        await expect(page).toHaveURL(/\/student\/review\/[^/?#]+(?:[?#]|$)/);
        await expect(page.getByRole("heading", { name: "모바일 실전 시험" })).toBeVisible();
        await expect(page.getByText("100%")).toBeVisible();
        await expectNoHorizontalOverflow(page);
        expect(await smallTargets(page, ".student-review-page button, .student-review-page .btn")).toEqual([]);
        await expect(page.locator(".mobile-install-prompt")).toHaveCount(0);
        const reviewFlow = await page.evaluate(() => {
            const content = document.querySelector<HTMLElement>(".student-review-content")?.getBoundingClientRect();
            const secondary = document.querySelector<HTMLElement>(".student-review-side-card")?.getBoundingClientRect();
            return {
                compactLayout: window.matchMedia("(max-width: 760px)").matches,
                contentTop: content?.top ?? null,
                secondaryTop: secondary?.top ?? null,
            };
        });
        if (reviewFlow.compactLayout && reviewFlow.contentTop !== null && reviewFlow.secondaryTop !== null) {
            expect(reviewFlow.contentTop).toBeLessThan(reviewFlow.secondaryTop);
        }
        const reviewStatSizing = await page.evaluate(() => {
            const grid = document.querySelector<HTMLElement>(".student-review-stat-grid")?.getBoundingClientRect();
            const card = document.querySelector<HTMLElement>(".student-review-stat-grid .student-review-mini-stat")?.getBoundingClientRect();
            return grid && card ? {
                shouldStayCompact: window.matchMedia("(min-width: 761px) and (max-width: 1080px)").matches,
                gridHeight: grid.height,
                cardHeight: card.height,
            } : null;
        });
        if (reviewStatSizing?.shouldStayCompact) {
            expect(reviewStatSizing.gridHeight).toBeLessThanOrEqual(reviewStatSizing.cardHeight + 2);
        }

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
        await expect(page.getByTestId("pwa-device-check-runtime-performance")).toContainText(/쾌적|지연|측정 불가/);
        await expect(page.getByTestId("pwa-device-report")).toContainText("OMR Maker PWA device check");
        await expect(page.getByTestId("pwa-device-report")).toContainText("checkedAtEpoch=");
        await expect(page.getByTestId("pwa-device-report")).toContainText("displayMode=browser");
        await expect(page.getByTestId("pwa-device-report")).toContainText("installedDisplay=no");
        await expect(page.getByTestId("pwa-device-report")).toContainText("proofStatus=pending");
        await expect(page.getByTestId("pwa-device-report")).toContainText("displayEvidence=");
        await expect(page.getByTestId("pwa-device-report")).toContainText("viewport-height=pass:동기화");
        await expect(page.getByTestId("pwa-device-report")).toContainText("keyboard-safe-area=pass:준비");
        await expect(page.getByTestId("pwa-device-report")).toContainText("ios-startup-image=pass:준비");
        await expect(page.getByTestId("pwa-device-report")).toContainText("runtime-performance=");
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
        await expect(page.getByTestId("pwa-proof-storage-status")).toContainText("자동 저장");
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
        await expectTouchTarget(page.getByTestId("pwa-proof-clear"));
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
        expect(copiedReport).toContain("checkedAtEpoch=");
        expect(copiedReport).toContain("installedDisplay=no");
        expect(copiedReport).toContain("proofStatus=pending");
        expect(copiedReport).toContain("displayEvidence=");
        expect(copiedReport).toContain("launch-proof=warn:대기");
        expect(copiedReport).toContain("handoff-origin=");
        expect(copiedReport).toContain("offline-cache=");
        expect(copiedReport).toContain("viewport-height=pass:동기화");
        expect(copiedReport).toContain("keyboard-safe-area=pass:준비");
        expect(copiedReport).toContain("overflow=pass:정상");
        expect(copiedReport).toContain("runtime-performance=");
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

    test("keeps installed standalone app mode clean and usable", async ({ page }, testInfo) => {
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
        if (testInfo.project.name.includes("ios")) {
            expect(standaloneState.viewport).not.toContain("interactive-widget=");
        } else {
            expect(standaloneState.viewport).toContain("interactive-widget=resizes-content");
        }
        expect(standaloneState.viewportHeightVar).toMatch(/^\d+px$/);
        expect(standaloneState.viewportKeyboardVar).toMatch(/^\d+px$/);
        expect(standaloneState.viewportKeyboardState).toMatch(/open|closed/);
        expect(standaloneState.layoutHeight).toBeGreaterThan(0);

        await page.goto("/pwa-check");
        await expect(page.getByTestId("pwa-device-check-display-mode")).toContainText(/standalone|fullscreen/);
        await expect(page.getByTestId("pwa-device-check-launch-proof")).toContainText("확인됨");
        await expect(page.getByTestId("pwa-device-report")).toContainText("installedDisplay=yes");
        await expect(page.getByTestId("pwa-device-report")).toContainText("launch-proof=pass:확인됨");
        await expect(page.getByTestId("pwa-device-report")).toContainText("handoff-origin=");
        await expect(page.getByTestId("pwa-device-report")).toContainText("offline-cache=");
        await expect(page.getByTestId("pwa-device-report")).toContainText("viewport-height=pass:동기화");
        await expect(page.getByTestId("pwa-device-report")).toContainText("keyboard-safe-area=pass:준비");
        await expect(page.getByTestId("pwa-device-report")).toContainText("runtime-performance=");
        const pwaCheckUrl = page.url();
        if (isLocalAppUrl(pwaCheckUrl)) {
            await expect(page.getByTestId("pwa-device-verdict")).toContainText("실기기 검증 필요");
            await expect(page.getByTestId("pwa-device-report")).toContainText("proofStatus=pending");
        } else {
            await expect(page.getByTestId("pwa-device-verdict")).toContainText("앱 실행 통과");
            await expect(page.getByTestId("pwa-device-report")).toContainText("proofStatus=pass");
        }
        await page.getByTestId("pwa-proof-input").fill(validInstalledProofReport("android"));
        await page.getByTestId("pwa-proof-input-ios").fill(
            validInstalledProofReport("ios").replaceAll("https://omr-maker-eight.vercel.app", "https://preview.example.com"),
        );
        await expect(page.getByTestId("pwa-proof-result")).toContainText("origin 불일치");
        await expect(page.getByTestId("pwa-proof-bundle")).toHaveCount(0);

        await page.getByTestId("pwa-proof-input-ios").fill(validInstalledProofReport("ios"));
        await expect(page.getByTestId("pwa-proof-result")).toContainText("Android/iOS 리포트 통과");
        await expect(page.getByTestId("pwa-proof-storage-status")).toContainText("2/2 리포트");
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
        expect(copiedProofBundle).toContain("generatedAtEpoch=");
        expect(copiedProofBundle).toContain("requiredDevices=Android, iOS");
        expect(copiedProofBundle).toContain("origin=https://omr-maker-eight.vercel.app");
        expect(copiedProofBundle).toContain("-----BEGIN ANDROID PWA REPORT-----");
        expect(copiedProofBundle).toContain("-----BEGIN IOS PWA REPORT-----");

        await page.reload();
        await expect(page.getByRole("heading", { name: "PWA 디바이스 체크" })).toBeVisible();
        await expect(page.getByTestId("pwa-proof-input")).toHaveValue(validInstalledProofReport("android"));
        await expect(page.getByTestId("pwa-proof-input-ios")).toHaveValue(validInstalledProofReport("ios"));
        await expect(page.getByTestId("pwa-proof-result")).toContainText("Android/iOS 리포트 통과");
        await expect(page.getByTestId("pwa-proof-storage-status")).toContainText("2/2 리포트");

        await page.getByTestId("pwa-proof-clear").click();
        await expect(page.getByTestId("pwa-proof-result")).toContainText("Android/iOS 리포트 대기");
        await expect(page.getByTestId("pwa-proof-storage-status")).toContainText("자동 저장");
        await expect(page.getByTestId("pwa-proof-input")).toHaveValue("");
        await expect(page.getByTestId("pwa-proof-input-ios")).toHaveValue("");
        await expect(page.getByTestId("pwa-proof-bundle")).toHaveCount(0);
        await expectNoHorizontalOverflow(page);

        expect(consoleProblems).toEqual([]);
    });
});
