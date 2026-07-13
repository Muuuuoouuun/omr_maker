import { expect, test, type Browser, type Page } from "@playwright/test";
import { openTeacherPage } from "./helpers";

test.describe.configure({ timeout: 90_000 });

type AuditTarget = {
    name: string;
    path: string;
    viewport: { width: number; height: number };
    teacher?: boolean;
};

const TARGETS: AuditTarget[] = [
    { name: "teacher-login-desktop", path: "/?role=teacher", viewport: { width: 1440, height: 900 } },
    { name: "student-login-mobile", path: "/?role=student", viewport: { width: 390, height: 844 } },
    { name: "admin-route-mobile", path: "/admin", viewport: { width: 390, height: 844 } },
    { name: "teacher-dashboard-desktop", path: "/teacher/dashboard", viewport: { width: 1440, height: 900 }, teacher: true },
    { name: "teacher-users-groups-mobile", path: "/teacher/users?tab=groups", viewport: { width: 390, height: 844 }, teacher: true },
    { name: "teacher-settings-mobile", path: "/teacher/settings", viewport: { width: 390, height: 844 }, teacher: true },
    { name: "teacher-billing-mobile", path: "/teacher/billing", viewport: { width: 390, height: 844 }, teacher: true },
    { name: "create-editor-desktop", path: "/create", viewport: { width: 1440, height: 900 }, teacher: true },
    { name: "create-editor-mobile", path: "/create", viewport: { width: 390, height: 844 }, teacher: true },
];

async function visitTarget(browser: Browser, target: AuditTarget): Promise<Page> {
    const context = await browser.newContext({ viewport: target.viewport });
    const page = await context.newPage();
    if (target.teacher) {
        await openTeacherPage(page, target.path);
    } else {
        await page.goto(target.path, { waitUntil: "domcontentloaded" });
    }
    await page.waitForLoadState("networkidle").catch(() => undefined);
    return page;
}

async function auditPage(page: Page) {
    return page.evaluate(() => {
        const isVisible = (element: Element) => {
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
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
        const allVisible = Array.from(document.querySelectorAll("body *")).filter(isVisible);
        const pageText = body.innerText || "";
        const mojibakePattern = /[\uFFFD\u00C3\u00C2]|\u00E2\u20AC|[\u00EC\u00EB\u00ED\u00EA][\u0080-\u00BF]/;

        const smallTargets = Array.from(document.querySelectorAll("button,a,input,select,textarea,[role='button']"))
            .filter(isVisible)
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
            .filter(item => item.width < 44 || item.height < 44)
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

        return {
            url: window.location.href,
            bodyOverflowX: Math.max(root.scrollWidth, body.scrollWidth) > root.clientWidth + 1,
            scrollWidth: Math.max(root.scrollWidth, body.scrollWidth),
            clientWidth: root.clientWidth,
            mojibake: mojibakePattern.test(pageText),
            smallTargets,
            clippedText,
        };
    });
}

test.describe("UI-UX PROMAX layout audit", () => {
    test.skip(({ browserName }) => browserName !== "chromium", "Layout audit runs on Chromium only.");

    test("keeps key student, teacher, and admin surfaces readable and touch-safe", async ({ browser }) => {
        const results: Array<{ name: string; result: Awaited<ReturnType<typeof auditPage>> }> = [];
        for (const target of TARGETS) {
            const page = await visitTarget(browser, target);
            results.push({ name: target.name, result: await auditPage(page) });
            await page.context().close();
        }

        console.log(JSON.stringify(results, null, 2));

        for (const { name, result } of results) {
            expect(result.mojibake, `${name} has mojibake text`).toBe(false);
            expect(result.bodyOverflowX, `${name} has body-level horizontal overflow`).toBe(false);
            expect(result.smallTargets, `${name} has touch targets below 44px`).toEqual([]);
            expect(result.clippedText, `${name} has clipped text`).toEqual([]);
        }
    });
});
