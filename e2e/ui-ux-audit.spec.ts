import { expect, test, type Browser, type Page } from "@playwright/test";
import { openTeacherPage } from "./helpers";

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
    { name: "student-login-mobile", path: "/?role=student", expectedText: "학생 포털", viewport: { width: 390, height: 844 } },
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
    if (target.teacher) {
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

        await openTeacherPage(page, "/teacher/dashboard?showcase=1&tab=overview");
        await expect(page.locator(".mockup-dashboard-tabs")).toBeVisible();
        const actionMotion = await readMotion(".mockup-primary-action");
        const cardMotion = await readMotion(".mockup-panel");
        const tabMotion = await readMotion('.mockup-dashboard-tabs button[aria-selected="true"]', "::after");

        await openTeacherPage(page, "/create");
        await page.getByRole("button", { name: "정답 인식 마법사 열기" }).click();
        await expect(page.getByRole("dialog", { name: "정답 PDF 불러오기" })).toBeVisible();
        const modalMotion = await readMotion('[role="dialog"]');

        expectEveryDuration(actionMotion, "0.16s");
        expectEveryDuration(cardMotion, "0.21s");
        expectEveryDuration(modalMotion, "0.21s");
        expectEveryDuration(tabMotion, "0.21s");
        for (const snapshot of [actionMotion, cardMotion, modalMotion, tabMotion]) {
            expect(snapshot.timing).toContain("cubic-bezier(0.2, 0.8, 0.2, 1)");
            expect(snapshot.distance).toBe(".375rem");
            expectRestrainedProperties(snapshot);
        }

        await page.emulateMedia({ reducedMotion: "reduce" });
        for (const [selector, pseudo] of [
            [".btn-primary", undefined],
            ['[role="dialog"]', undefined],
        ] as const) {
            const reduced = await readMotion(selector, pseudo);
            expect(reduced.duration.split(", ").every(duration => duration === "0.001s")).toBe(true);
            expect(reduced.distance).toBe("0rem");
            expectRestrainedProperties(reduced);
        }

        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.locator("html").evaluate(element => element.setAttribute("data-motion", "off"));
        const disabled = await readMotion(".btn-primary");
        expect(disabled.duration.split(", ").every(duration => duration === "0.001s")).toBe(true);
        expect(disabled.distance).toBe("0rem");
        expectRestrainedProperties(disabled);
    });

    test("keeps one visible landing landmark and one role-specific level-one heading", async ({ browser }) => {
        const landingStates = [
            { name: "initial", path: "/", expectedText: "OMR Maker", heading: "OMR Maker" },
            { name: "teacher", path: "/?role=teacher", expectedText: "교사 포털", heading: "환영합니다" },
            { name: "student", path: "/?role=student", expectedText: "학생 포털", heading: "학습 시작" },
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
