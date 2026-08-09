import { expect, test, type Browser, type Page } from "@playwright/test";
import { loginAsShowcaseTeacher, openTeacherPage } from "./helpers";

test.describe.configure({ timeout: 90_000 });

type AuditTarget = {
    name: string;
    path: string;
    expectedText: string;
    viewport: { width: number; height: number };
    teacher?: boolean;
    initialTheme?: "light" | "dark";
};

const TARGETS: AuditTarget[] = [
    { name: "teacher-login-desktop", path: "/?role=teacher", expectedText: "교사 포털", viewport: { width: 1440, height: 900 } },
    { name: "student-login-mobile", path: "/?role=student", expectedText: "학습 시작", viewport: { width: 390, height: 844 } },
    { name: "admin-route-mobile", path: "/admin", expectedText: "관리자 기능은 교사 포털에서 관리합니다", viewport: { width: 390, height: 844 } },
    { name: "teacher-dashboard-desktop", path: "/teacher/dashboard", expectedText: "분석 센터", viewport: { width: 1440, height: 900 }, teacher: true },
    { name: "teacher-showcase-mobile-dark-preference", path: "/teacher/dashboard?showcase=1&tab=exam", expectedText: "시험별 통계", viewport: { width: 390, height: 844 }, teacher: true, initialTheme: "dark" },
    { name: "teacher-users-groups-mobile", path: "/teacher/users?tab=groups", expectedText: "사용자 관리", viewport: { width: 390, height: 844 }, teacher: true },
    { name: "teacher-settings-mobile", path: "/teacher/settings", expectedText: "설정", viewport: { width: 390, height: 844 }, teacher: true },
    { name: "teacher-billing-mobile", path: "/teacher/billing", expectedText: "결제 및 플랜", viewport: { width: 390, height: 844 }, teacher: true },
    { name: "create-editor-desktop", path: "/create", expectedText: "설정", viewport: { width: 1440, height: 900 }, teacher: true },
    { name: "create-editor-mobile", path: "/create", expectedText: "설정", viewport: { width: 390, height: 844 }, teacher: true },
];

async function visitTarget(browser: Browser, target: AuditTarget): Promise<Page> {
    const context = await browser.newContext({ viewport: target.viewport });
    const page = await context.newPage();
    if (target.initialTheme) {
        await page.addInitScript(theme => window.localStorage.setItem("omr_theme", theme), target.initialTheme);
    }
    if (target.teacher && target.path.includes("showcase=1")) {
        await loginAsShowcaseTeacher(page);
        if (!page.url().endsWith(target.path)) {
            await page.goto(target.path, { waitUntil: "domcontentloaded" });
        }
    } else if (target.teacher) {
        await openTeacherPage(page, target.path);
    } else {
        await page.goto(target.path, { waitUntil: "domcontentloaded" });
    }
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.waitForFunction(
        expectedText => (document.body.innerText || "").includes(expectedText),
        target.expectedText,
        { timeout: 15_000 },
    ).catch(() => undefined);
    return page;
}

async function auditPage(page: Page, target: AuditTarget) {
    return page.evaluate(({ expectedText, expectedPath }) => {
        const isVisible = (element: Element) => {
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.visibility !== "hidden"
                && style.display !== "none"
                && style.opacity !== "0"
                && rect.width > 0
                && rect.height > 0;
        };
        const labelFor = (element: Element) => {
            const text = (
                (element as HTMLElement).innerText ||
                element.getAttribute("aria-label") ||
                element.getAttribute("title") ||
                element.getAttribute("placeholder") ||
                element.tagName.toLowerCase()
            ).replace(/\s+/g, " ").trim();
            return text.slice(0, 80);
        };
        const hasOwnText = (element: Element) => Array.from(element.childNodes)
            .some(node => node.nodeType === Node.TEXT_NODE && (node.textContent || "").trim().length > 1);
        const isTextSurface = (element: Element) => {
            const tag = element.tagName.toLowerCase();
            if (["span", "strong", "em", "p", "h1", "h2", "h3", "h4", "h5", "h6", "button", "a", "label", "li", "td", "th"].includes(tag)) {
                return true;
            }
            return element.children.length === 0 || hasOwnText(element);
        };
        const root = document.documentElement;
        const body = document.body;
        const minimumTargetSize = root.clientWidth <= 640 ? 44 : 24;
        const allVisible = Array.from(document.querySelectorAll("body *")).filter(isVisible);
        const pageText = body.innerText || "";
        const mojibakePattern = /[\uFFFD\u00C3\u00C2]|\u00E2\u20AC|[\u00EC\u00EB\u00ED\u00EA][\u0080-\u00BF]/;
        const frameworkErrorPattern = /Application error|Runtime Error|Unhandled Runtime Error|Build Error|Failed to compile/i;
        const normalizedPageText = pageText.replace(/\s+/g, " ").trim();
        const currentPath = window.location.pathname;

        const interactiveTargets = Array.from(
            document.querySelectorAll("button,a,input,select,textarea,[role='button']"),
        );
        const isNonInteractiveFileUploadProxy = (element: Element) => (
            element instanceof HTMLInputElement
            && element.type === "file"
            && element.getAttribute("aria-hidden") === "true"
            && element.getAttribute("tabindex") === "-1"
            && element.tabIndex < 0
        );
        const excludedFileUploadProxies = interactiveTargets
            .filter(isNonInteractiveFileUploadProxy)
            .map(element => ({
                tag: element.tagName.toLowerCase(),
                type: (element as HTMLInputElement).type,
                ariaHidden: element.getAttribute("aria-hidden"),
                tabIndex: (element as HTMLElement).tabIndex,
            }));
        const smallTargets = interactiveTargets
            .filter(isVisible)
            .filter(element => !isNonInteractiveFileUploadProxy(element))
            .map(element => {
                const rect = element.getBoundingClientRect();
                return {
                    label: labelFor(element),
                    tag: element.tagName.toLowerCase(),
                    className: (element as HTMLElement).className?.toString() || "",
                    parentClassName: (element.parentElement as HTMLElement | null)?.className?.toString() || "",
                    width: Math.round(rect.width),
                    height: Math.round(rect.height),
                };
            })
            .filter(item => item.width < minimumTargetSize || item.height < minimumTargetSize)
            .slice(0, 12);

        const clippedText = allVisible
            .filter(element => {
                const htmlElement = element as HTMLElement;
                const style = window.getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                if (rect.width < 4 || rect.height < 4 || !isTextSurface(element)) return false;
                const hasText = (htmlElement.innerText || "").trim().length > 1;
                if (!hasText) return false;
                const overflowed = htmlElement.scrollWidth > htmlElement.clientWidth + 2;
                const clips = ["hidden", "clip", "scroll", "auto"].includes(style.overflowX);
                return overflowed && clips;
            })
            .map(element => {
                const htmlElement = element as HTMLElement;
                const rect = element.getBoundingClientRect();
                return {
                    label: labelFor(element),
                    tag: element.tagName.toLowerCase(),
                    className: (element as HTMLElement).className?.toString() || "",
                    parentClassName: (element.parentElement as HTMLElement | null)?.className?.toString() || "",
                    width: Math.round(rect.width),
                    height: Math.round(rect.height),
                    scrollWidth: htmlElement.scrollWidth,
                    clientWidth: htmlElement.clientWidth,
                };
            })
            .slice(0, 12);

        // Body-level overflow checks miss surfaces that grow beyond the viewport
        // while an ancestor clips the document. Audit semantic layout surfaces by
        // their actual bounding boxes, but ignore children of intentional scrollers.
        const offViewportSurfaces = Array.from(document.querySelectorAll("main, main > *, main section, main article"))
            .filter(isVisible)
            .filter(element => {
                const rect = element.getBoundingClientRect();
                if (rect.left >= -1 && rect.right <= root.clientWidth + 1) return false;
                let ancestor = element.parentElement;
                while (ancestor && ancestor !== body) {
                    const overflowX = window.getComputedStyle(ancestor).overflowX;
                    if (overflowX === "auto" || overflowX === "scroll") return false;
                    ancestor = ancestor.parentElement;
                }
                return true;
            })
            .map(element => {
                const rect = element.getBoundingClientRect();
                return {
                    label: labelFor(element),
                    tag: element.tagName.toLowerCase(),
                    className: (element as HTMLElement).className?.toString() || "",
                    left: Math.round(rect.left),
                    right: Math.round(rect.right),
                    viewportWidth: root.clientWidth,
                };
            })
            .slice(0, 12);

        return {
            url: window.location.href,
            pageTitle: document.title,
            pathMatches: currentPath === expectedPath,
            expectedTextFound: normalizedPageText.includes(expectedText),
            meaningfulTextLength: normalizedPageText.length,
            headingCount: document.querySelectorAll("h1,h2,h3,[role='heading']").length,
            frameworkError: frameworkErrorPattern.test(normalizedPageText)
                || !!document.querySelector("[data-nextjs-dialog-overlay], [data-next-badge-root='true'] [role='dialog']"),
            bodyOverflowX: Math.max(root.scrollWidth, body.scrollWidth) > root.clientWidth + 1,
            scrollWidth: Math.max(root.scrollWidth, body.scrollWidth),
            clientWidth: root.clientWidth,
            mojibake: mojibakePattern.test(pageText),
            smallTargets,
            excludedFileUploadProxies,
            clippedText,
            offViewportSurfaces,
        };
    }, {
        expectedText: target.expectedText,
        expectedPath: new URL(target.path, "http://localhost").pathname,
    });
}

test.describe("UI-UX PROMAX layout audit", () => {
    test.skip(({ browserName }) => browserName !== "chromium", "Layout audit runs on Chromium only.");

    test("keeps aria-hidden interactive controls in the touch target audit", async ({ page }) => {
        await page.setContent(`
            <main>
                <h1>Audit fixture</h1>
                <button
                    type="button"
                    aria-hidden="true"
                    style="width: 12px; height: 12px; min-width: 0; min-height: 0"
                >
                    Hidden interactive target
                </button>
                <input
                    type="file"
                    aria-hidden="true"
                    tabindex="-1"
                    style="position: absolute; width: 1px; height: 1px"
                />
            </main>
        `);

        const result = await auditPage(page, {
            name: "aria-hidden-interactive-fixture",
            path: "/",
            expectedText: "Audit fixture",
            viewport: { width: 390, height: 844 },
        });

        expect(result.smallTargets).toEqual([
            expect.objectContaining({
                label: "Hidden interactive target",
                tag: "button",
                height: 12,
            }),
        ]);
        expect(result.smallTargets[0]?.width).toBeLessThan(44);
        expect(result.excludedFileUploadProxies).toEqual([
            {
                tag: "input",
                type: "file",
                ariaHidden: "true",
                tabIndex: -1,
            },
        ]);
    });

    test("uses balanced motion for primary actions, cards, modal panels, and tab indicators", async ({ page }) => {
        type MotionSnapshot = {
            duration: string;
            property: string;
            timing: string;
            distance: string;
        };
        type AnimationSnapshot = {
            name: string;
            duration: string;
            timing: string;
            distance: string;
            activeAnimations: Array<{ playState: AnimationPlayState; duration: number | null }>;
        };
        const readMotion = async (selector: string, pseudo?: "::after"): Promise<MotionSnapshot> => (
            page.locator(selector).first().evaluate((element, pseudoElement) => {
                const style = window.getComputedStyle(element, pseudoElement || null);
                const rootStyle = window.getComputedStyle(document.documentElement);
                return {
                    duration: style.transitionDuration,
                    property: style.transitionProperty,
                    timing: style.transitionTimingFunction,
                    distance: rootStyle.getPropertyValue("--motion-distance").trim(),
                };
            }, pseudo)
        );
        const expectRestrainedProperties = (snapshot: MotionSnapshot) => {
            expect(snapshot.property).not.toMatch(/(^|, )all(,|$)|width|height|margin|padding|flex-basis/);
        };
        const expectEveryDuration = (snapshot: MotionSnapshot, duration: string) => {
            expect(snapshot.duration.split(", ").every(value => value === duration)).toBe(true);
        };
        const readAnimation = async (selector: string): Promise<AnimationSnapshot> => (
            page.locator(selector).first().evaluate(element => {
                const style = window.getComputedStyle(element);
                const rootStyle = window.getComputedStyle(document.documentElement);
                return {
                    name: style.animationName,
                    duration: style.animationDuration,
                    timing: style.animationTimingFunction,
                    distance: rootStyle.getPropertyValue("--motion-distance").trim(),
                    activeAnimations: element.getAnimations().map(animation => ({
                        playState: animation.playState,
                        duration: typeof animation.effect?.getTiming().duration === "number"
                            ? animation.effect.getTiming().duration as number
                            : null,
                    })),
                };
            })
        );

        await loginAsShowcaseTeacher(page);
        await expect(page.locator(".mockup-dashboard-tabs")).toBeVisible();
        const actionMotion = await readMotion(".mockup-primary-action");
        const cardMotion = await readMotion(".mockup-panel");
        const tabMotion = await readMotion('.mockup-dashboard-tabs button[aria-pressed="true"]', "::after");

        await openTeacherPage(page, "/create");
        await page.getByRole("button", { name: "정답 인식 마법사 열기" }).click();
        await expect(page.getByRole("dialog", { name: "정답 PDF 불러오기" })).toBeVisible();
        const modalAnimation = await readAnimation('[role="dialog"]');

        expectEveryDuration(actionMotion, "0.16s");
        expectEveryDuration(cardMotion, "0.21s");
        expectEveryDuration(tabMotion, "0.21s");
        for (const snapshot of [actionMotion, cardMotion, tabMotion]) {
            expect(snapshot.timing).toContain("cubic-bezier(0.2, 0.8, 0.2, 1)");
            expect(snapshot.distance).toBe(".375rem");
            expectRestrainedProperties(snapshot);
        }
        expect(modalAnimation.name).toBe("balancedDialogEnter");
        expect(modalAnimation.duration).toBe("0.21s");
        expect(modalAnimation.timing).toContain("cubic-bezier(0.2, 0.8, 0.2, 1)");
        expect(modalAnimation.distance).toBe(".375rem");
        expect(modalAnimation.activeAnimations).toContainEqual({
            playState: "running",
            duration: 210,
        });

        await page.emulateMedia({ reducedMotion: "reduce" });
        const reducedAction = await readMotion(".btn-primary");
        expect(reducedAction.duration.split(", ").every(duration => duration === "0.001s")).toBe(true);
        expect(reducedAction.distance).toBe("0rem");
        expectRestrainedProperties(reducedAction);
        const reducedModal = await readAnimation('[role="dialog"]');
        expect(reducedModal.duration).toBe("0.001s");
        expect(reducedModal.distance).toBe("0rem");

        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.locator("html").evaluate(element => element.setAttribute("data-motion", "off"));
        const disabled = await readMotion(".btn-primary");
        expect(disabled.duration.split(", ").every(duration => duration === "0.001s")).toBe(true);
        expect(disabled.distance).toBe("0rem");
        expectRestrainedProperties(disabled);
        const disabledModal = await readAnimation('[role="dialog"]');
        expect(disabledModal.duration).toBe("0.001s");
        expect(disabledModal.distance).toBe("0rem");
    });

    test("app motion-off renders mounted CountUp values final without an active RAF animation", async ({ page }) => {
        await page.addInitScript(() => {
            window.localStorage.setItem("omr_settings", JSON.stringify({
                theme: { motion: false },
            }));
            const firstFrameState = window as typeof window & {
                __omrFirstCountUpFrame?: Array<{
                    target: string | null;
                    motion: string | null;
                    raf: string | null;
                    text: string;
                }>;
            };
            const observer = new MutationObserver(() => {
                const countUps = Array.from(document.querySelectorAll("[data-count-up-value]"));
                if (countUps.length === 0) return;
                observer.disconnect();
                window.requestAnimationFrame(() => {
                    firstFrameState.__omrFirstCountUpFrame = countUps.map(element => ({
                        target: element.getAttribute("data-count-up-value"),
                        motion: element.getAttribute("data-count-up-motion"),
                        raf: element.getAttribute("data-count-up-raf"),
                        text: element.textContent?.replace(/[^\d.-]/g, "") || "",
                    }));
                });
            });
            observer.observe(document, { childList: true, subtree: true });
        });
        await loginAsShowcaseTeacher(page);
        await expect(page.locator("html")).toHaveAttribute("data-motion", "off");

        const countUps = page.locator("[data-count-up-value]");
        await expect(countUps.first()).toBeVisible();
        const snapshots = await countUps.evaluateAll(elements => elements.map(element => ({
            target: element.getAttribute("data-count-up-value"),
            motion: element.getAttribute("data-count-up-motion"),
            raf: element.getAttribute("data-count-up-raf"),
            text: element.textContent?.replace(/[^\d.-]/g, "") || "",
        })));

        expect(snapshots.length).toBeGreaterThan(0);
        for (const snapshot of snapshots) {
            expect(snapshot.motion).toBe("reduced");
            expect(snapshot.raf).toBe("idle");
            expect(Number(snapshot.text)).toBe(Number(snapshot.target));
        }
        await expect.poll(() => page.evaluate(() => (
            window as typeof window & {
                __omrFirstCountUpFrame?: Array<{
                    target: string | null;
                    motion: string | null;
                    raf: string | null;
                    text: string;
                }>;
            }
        ).__omrFirstCountUpFrame)).not.toBeUndefined();
        const capturedFirstFrame = await page.evaluate(() => (
            window as typeof window & {
                __omrFirstCountUpFrame?: Array<{
                    target: string | null;
                    motion: string | null;
                    raf: string | null;
                    text: string;
                }>;
            }
        ).__omrFirstCountUpFrame || []);
        expect(capturedFirstFrame.length).toBeGreaterThan(0);
        for (const snapshot of capturedFirstFrame) {
            expect(snapshot.motion).toBe("reduced");
            expect(snapshot.raf).toBe("idle");
            expect(Number(snapshot.text)).toBe(Number(snapshot.target));
        }

        await page.locator("html").evaluate(element => element.setAttribute("data-motion", "on"));
        await expect(countUps.first()).toHaveAttribute("data-count-up-motion", "animated");
        await page.emulateMedia({ reducedMotion: "reduce" });
        await expect(countUps.first()).toHaveAttribute("data-count-up-motion", "reduced");
        await expect(countUps.first()).toHaveAttribute("data-count-up-raf", "idle");
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await expect(countUps.first()).toHaveAttribute("data-count-up-motion", "animated");
        await page.locator("html").evaluate(element => element.setAttribute("data-motion", "off"));
        await expect(countUps.first()).toHaveAttribute("data-count-up-motion", "reduced");
        await expect(countUps.first()).toHaveAttribute("data-count-up-raf", "idle");
    });

});

test.describe("Cross-browser personal growth report acceptance", () => {
    test("keeps the personal growth chart contained, readable, and still when motion is off", async ({ page }) => {
        let consolePhase = "setup";
        const consoleIssues: Array<{ phase: string; type: string; text: string; url: string }> = [];
        const pageErrors: Array<{ phase: string; message: string }> = [];
        page.on("console", message => {
            if (message.type() !== "warning" && message.type() !== "error") return;
            consoleIssues.push({ phase: consolePhase, type: message.type(), text: message.text(), url: message.location().url });
        });
        page.on("pageerror", error => {
            pageErrors.push({ phase: consolePhase, message: error.stack || error.message });
        });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.addInitScript(() => {
            const forceMotion = window.sessionStorage.getItem("qa_growth_motion") === "on";
            window.localStorage.setItem("omr_settings", JSON.stringify({ theme: { motion: false } }));
            if (forceMotion) {
                window.localStorage.setItem("omr_settings", JSON.stringify({ theme: { motion: true } }));
            }
        });
        consolePhase = "showcase-dashboard";
        await loginAsShowcaseTeacher(page);
        await page.goto("/teacher/dashboard?showcase=1&tab=student");
        await page.getByRole("link", { name: /결과 분석 열기/ }).first().click();
        consolePhase = "report";
        await page.getByRole("tab", { name: "리포트", exact: true }).click();

        const growth = page.getByRole("region", { name: "개인 성장", exact: true });
        await expect(growth).toBeVisible();
        const chartShell = growth.getByRole("region", { name: "개인 성장 그래프 가로 스크롤 영역" });
        await expect(chartShell).toBeVisible();
        const requiredViewports = [
            { width: 1440, height: 900 },
            { width: 1024, height: 768 },
            { width: 760, height: 844 },
            { width: 390, height: 844 },
            { width: 320, height: 720 },
        ];
        const viewportAudits: Array<{
            width: number;
            actualViewportWidth: number;
            chartClientWidth: number;
            chartScrollWidth: number;
            documentClientWidth: number;
            documentScrollWidth: number;
            overflowX: string;
            horizontalScrollRegions: string[];
            animated: string[];
        }> = [];

        for (const viewport of requiredViewports) {
            await page.setViewportSize(viewport);
            await expect(chartShell).toBeVisible();
            const audit = await chartShell.evaluate(element => {
                const root = document.documentElement;
                const body = document.body;
                const animated = Array.from(element.querySelectorAll("*"))
                    .filter(node => getComputedStyle(node).animationName !== "none")
                    .map(node => getComputedStyle(node).animationName);
                const horizontalScrollRegions = Array.from(document.querySelectorAll<HTMLElement>("*"))
                    .filter(node => {
                        const overflowX = getComputedStyle(node).overflowX;
                        return node.scrollWidth > node.clientWidth && (overflowX === "auto" || overflowX === "scroll");
                    })
                    .map(node => node.getAttribute("aria-label") || node.tagName.toLowerCase());
                return {
                    actualViewportWidth: window.innerWidth,
                    chartClientWidth: element.clientWidth,
                    chartScrollWidth: element.scrollWidth,
                    documentClientWidth: root.clientWidth,
                    documentScrollWidth: Math.max(root.scrollWidth, body.scrollWidth),
                    overflowX: getComputedStyle(element).overflowX,
                    horizontalScrollRegions,
                    animated,
                };
            });
            viewportAudits.push({ width: viewport.width, ...audit });
        }

        expect(viewportAudits.map(audit => audit.width)).toEqual(requiredViewports.map(viewport => viewport.width));
        for (const audit of viewportAudits) {
            expect(audit.actualViewportWidth, `actual viewport at ${audit.width}px`).toBe(audit.width);
            expect(audit.documentScrollWidth, `document overflow at ${audit.width}px`).toBe(audit.documentClientWidth);
        }
        for (const width of [760, 320]) {
            const audit = viewportAudits.find(result => result.width === width)!;
            expect(audit.chartScrollWidth, `chart should scroll at ${width}px`).toBeGreaterThan(audit.chartClientWidth);
            expect(audit.overflowX).toBe("auto");
            expect(audit.horizontalScrollRegions).toEqual(["개인 성장 그래프 가로 스크롤 영역"]);
        }
        expect(viewportAudits.find(audit => audit.width === 390)!.animated).toEqual([]);
        await expect(growth.getByText(/등 \/ \d+명/).first()).toBeVisible();
        await growth.getByRole("tab", { name: "추세만" }).click();
        await expect(growth.getByRole("tab", { name: "추세만" })).toHaveAttribute("aria-selected", "true");
        await expect(chartShell).toBeVisible();

        const headerContainment = await page.locator("header .header-content").evaluate(element => {
            const headerRect = element.closest("header")!.getBoundingClientRect();
            const childRects = Array.from(element.children).map(child => child.getBoundingClientRect());
            return {
                headerTop: headerRect.top,
                headerBottom: headerRect.bottom,
                children: childRects.map(rect => ({ top: rect.top, bottom: rect.bottom })),
            };
        });
        for (const child of headerContainment.children) {
            expect(child.top).toBeGreaterThanOrEqual(headerContainment.headerTop);
            expect(child.bottom).toBeLessThanOrEqual(headerContainment.headerBottom);
        }

        await page.evaluate(() => window.sessionStorage.setItem("qa_growth_motion", "on"));
        await page.emulateMedia({ reducedMotion: "reduce" });
        consolePhase = "reduced-reload";
        await page.reload();
        const reducedGrowth = page.getByRole("region", { name: "개인 성장", exact: true });
        await expect(reducedGrowth).toBeVisible();
        const reducedAnimations = await reducedGrowth.locator("[data-testid='growth-chart-shell'] *").evaluateAll(elements => (
            elements
                .filter(element => getComputedStyle(element).animationName !== "none")
                .map(element => getComputedStyle(element).animationName)
        ));
        expect(reducedAnimations).toEqual([]);

        await page.setViewportSize({ width: 1024, height: 768 });
        consolePhase = "print";
        await page.emulateMedia({ media: "print", reducedMotion: "reduce" });
        const printTable = reducedGrowth.getByRole("table", { name: "개인 성장 데이터" });
        await expect(printTable).toBeVisible();
        const printChartPresentation = await reducedGrowth.locator("[data-testid='growth-chart-shell']").evaluate(element => {
            const style = getComputedStyle(element.parentElement!);
            return { clipPath: style.clipPath, opacity: style.opacity, width: style.width };
        });
        expect(printChartPresentation).toEqual({ clipPath: "inset(50%)", opacity: "0", width: "1px" });
        expect(
            consoleIssues.filter(issue => /width\(0\).*height\(0\).*chart/i.test(issue.text)),
            JSON.stringify(consoleIssues, null, 2),
        ).toEqual([]);
        expect(
            consoleIssues.filter(issue => issue.type === "error"),
            JSON.stringify(consoleIssues, null, 2),
        ).toEqual([]);
        expect(pageErrors, JSON.stringify(pageErrors, null, 2)).toEqual([]);
    });
});

test.describe("UI-UX PROMAX layout audit continued", () => {
    test.skip(({ browserName }) => browserName !== "chromium", "Layout audit runs on Chromium only.");

    test("keeps one visible landing landmark and one role-specific level-one heading", async ({ browser }) => {
        const landingStates = [
            { name: "initial", path: "/", expectedText: "OMR Maker", heading: "OMR Maker" },
            { name: "teacher", path: "/?role=teacher", expectedText: "교사 포털", heading: "환영합니다" },
            { name: "student", path: "/?role=student", expectedText: "학습 시작", heading: "학습 시작" },
        ] as const;

        for (const state of landingStates) {
            const page = await visitTarget(browser, {
                name: state.name,
                path: state.path,
                expectedText: state.expectedText,
                viewport: { width: 1440, height: 900 },
            });
            const main = page.locator("main");
            const levelOneHeadings = page.locator("h1");
            const activeHeading = page.getByRole("heading", { level: 1, name: state.heading, exact: true });

            await expect(main, `${state.name} should have exactly one main landmark in the DOM`).toHaveCount(1);
            await expect(page.locator("main:visible"), `${state.name} should have exactly one visible main landmark`).toHaveCount(1);
            await expect(levelOneHeadings, `${state.name} should not retain a hidden duplicate h1`).toHaveCount(1);
            await expect(page.locator("h1:visible"), `${state.name} should have exactly one visible h1`).toHaveCount(1);
            await expect(activeHeading, `${state.name} should expose its active role heading`).toBeVisible();
            await expect(main.filter({ has: activeHeading }), `${state.name} h1 should belong to main content`).toHaveCount(1);
            expect(
                await page.locator(".brand-logo").evaluateAll(logos => logos.every(logo => logo.tagName !== "H1")),
                `${state.name} decorative product branding should not compete as a heading`,
            ).toBe(true);

            await page.context().close();
        }
    });

    test("keeps the landing role choices balanced on desktop and compact on mobile", async ({ browser }) => {
        for (const viewport of [
            { name: "desktop", width: 1440, height: 900, minimumCardWidth: 400 },
            { name: "mobile", width: 390, height: 844, minimumCardWidth: 160 },
        ]) {
            const page = await visitTarget(browser, {
                name: `landing-${viewport.name}`,
                path: "/",
                expectedText: "OMR Maker",
                viewport,
            });
            const cards = page.locator(".home-role-card");
            await expect(cards).toHaveCount(2);
            const boxes = await cards.evaluateAll(elements => elements.map(element => {
                const rect = element.getBoundingClientRect();
                return { width: Math.round(rect.width), x: Math.round(rect.x), y: Math.round(rect.y) };
            }));
            const pageWidth = await page.evaluate(() => ({
                clientWidth: document.documentElement.clientWidth,
                scrollWidth: document.documentElement.scrollWidth,
            }));

            expect(Math.abs(boxes[0].y - boxes[1].y), `${viewport.name} role cards should share one row`).toBeLessThanOrEqual(2);
            expect(boxes.every(box => box.width >= viewport.minimumCardWidth), `${viewport.name} role cards should use the available width`).toBe(true);
            expect(boxes[1].x, `${viewport.name} teacher card should follow the student card horizontally`).toBeGreaterThan(boxes[0].x);
            expect(pageWidth.scrollWidth, `${viewport.name} landing should not overflow horizontally`).toBeLessThanOrEqual(pageWidth.clientWidth);

            await page.context().close();
        }
    });

    test("lets keyboard users bypass repeated teacher header controls", async ({ browser }) => {
        const page = await visitTarget(browser, {
            name: "teacher-settings-skip-link",
            path: "/teacher/settings",
            expectedText: "프로필 상태",
            viewport: { width: 1440, height: 900 },
            teacher: true,
        });
        const skipLink = page.getByRole("link", { name: "본문으로 건너뛰기", exact: true });
        const main = page.locator("main#main-content");

        await expect(skipLink).toHaveAttribute("href", "#main-content");
        await expect(main).toHaveCount(1);
        await expect(main).toHaveAttribute("tabindex", "-1");
        const restingSkipLink = await skipLink.evaluate(element => {
            const rect = element.getBoundingClientRect();
            return { bottom: Math.round(rect.bottom), opacity: getComputedStyle(element).opacity };
        });
        expect(restingSkipLink.opacity).toBe("0");
        expect(restingSkipLink.bottom).toBeLessThanOrEqual(0);

        await page.keyboard.press("Tab");
        await expect(skipLink).toBeFocused();
        await expect(skipLink).toBeVisible();
        await expect(skipLink).toHaveCSS("opacity", "1");
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(/#main-content$/);
        await expect(main).toBeFocused();

        await page.context().close();
    });

    test("keeps key student, teacher, and admin surfaces readable and touch-safe", async ({ browser }) => {
        const results: Array<{ name: string; result: Awaited<ReturnType<typeof auditPage>> }> = [];
        for (const target of TARGETS) {
            const page = await visitTarget(browser, target);
            results.push({ name: target.name, result: await auditPage(page, target) });
            await page.context().close();
        }

        console.log(JSON.stringify(results, null, 2));

        for (const { name, result } of results) {
            expect(result.pageTitle, `${name} has the wrong document title`).toContain("OMR Maker");
            expect(result.pathMatches, `${name} redirected to the wrong route: ${result.url}`).toBe(true);
            expect(result.expectedTextFound, `${name} did not render its expected screen identity`).toBe(true);
            expect(result.meaningfulTextLength, `${name} rendered an empty or near-empty shell`).toBeGreaterThan(40);
            expect(result.headingCount, `${name} has no semantic heading`).toBeGreaterThan(0);
            expect(result.frameworkError, `${name} shows a framework error overlay`).toBe(false);
            expect(result.mojibake, `${name} has mojibake text`).toBe(false);
            expect(result.bodyOverflowX, `${name} has body-level horizontal overflow`).toBe(false);
            expect(result.smallTargets, `${name} has touch targets below 44px`).toEqual([]);
            expect(result.clippedText, `${name} has clipped text`).toEqual([]);
            expect(result.offViewportSurfaces, `${name} has a surface clipped outside the viewport`).toEqual([]);
        }
    });
});
