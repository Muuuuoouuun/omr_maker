import { expect, test, type Page } from "@playwright/test";
import { continueSolveEntryIfPresent } from "./helpers";
import type { Attempt, Exam } from "../src/types/omr";

const tabletViewports = [
    { name: "iPad portrait", width: 820, height: 1180, orientation: "portrait" as const },
    { name: "iPad landscape", width: 1180, height: 820, orientation: "landscape" as const },
];

const layoutRoutes = [
    "/teacher/dashboard",
    "/teacher/live",
    "/teacher/users",
    "/teacher/settings",
    "/teacher/billing",
    "/student/dashboard",
    "/student/history",
    "/solve/tablet-exam",
    "/student/review/tablet-attempt",
];

function tabletExam(): Exam {
    return {
        id: "tablet-exam",
        title: "Tablet Layout Exam",
        createdAt: "2026-04-23T00:00:00.000Z",
        durationMin: 45,
        accessConfig: { type: "public", groupIds: [] },
        questions: Array.from({ length: 24 }, (_, idx) => ({
            id: idx + 1,
            number: idx + 1,
            label: idx < 8 ? "A" : idx < 16 ? "B" : "C",
            score: 4,
            answer: (idx % 5) + 1,
            pdfLocation: {
                page: 1,
                x: 0.18 + (idx % 4) * 0.18,
                y: 0.18 + Math.floor(idx / 4) * 0.1,
            },
        })),
    };
}

function tabletAttempts(): Attempt[] {
    return [
        {
            id: "tablet-attempt",
            examId: "tablet-exam",
            examTitle: "Tablet Layout Exam",
            studentName: "Tablet Student",
            studentId: "student-tablet",
            guestId: "guest-tablet",
            startedAt: "2026-04-23T00:10:00.000Z",
            finishedAt: "2026-04-23T00:40:00.000Z",
            score: 76,
            totalScore: 96,
            answers: Object.fromEntries(Array.from({ length: 24 }, (_, idx) => [idx + 1, (idx % 5) + 1])),
            drawings: {
                1: [
                    JSON.stringify({
                        color: "#ef4444",
                        points: [
                            { x: 0.18, y: 0.2 },
                            { x: 0.28, y: 0.24 },
                            { x: 0.34, y: 0.18 },
                        ],
                    }),
                ],
            },
            status: "completed",
        },
    ];
}

async function seedTabletStorage(page: Page) {
    await page.addInitScript(({ exam, attempts, panelKey }) => {
        try { window.localStorage.clear(); } catch {}
        try { window.sessionStorage.clear(); } catch {}
        window.localStorage.setItem(`omr_exam_${exam.id}`, JSON.stringify(exam));
        window.localStorage.setItem("omr_attempts", JSON.stringify(attempts));
        window.localStorage.setItem("omr_guest_id", "guest-tablet");
        window.localStorage.setItem(panelKey, "expanded");
        window.sessionStorage.setItem("omr_student_session", JSON.stringify({
            name: "Tablet Student",
            groupId: "group-tablet",
            groupName: "Tablet Class",
            isGuest: true,
            guestId: "guest-tablet",
        }));
    }, {
        exam: tabletExam(),
        attempts: tabletAttempts(),
        panelKey: "omr_solve_panel_tablet-exam_guest:guest-tablet_base",
    });
}

async function expectNoCriticalOverflow(page: Page) {
    const result = await page.evaluate(() => {
        const viewportWidth = window.innerWidth;
        const scrollWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
        const selectors = [
            "header",
            "main",
            ".layout-main",
            ".header-content",
            ".solve-header-content",
            ".solve-body",
            ".solve-pdf-pane",
            ".solve-omr-pane",
            ".pdf-viewer-container",
            ".pdf-viewer-toolbar",
            ".omr-cardview",
            ".bento-grid",
        ];

        const criticalOverflow = selectors.flatMap(selector =>
            Array.from(document.querySelectorAll<HTMLElement>(selector)).map(element => {
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return {
                    selector,
                    left: Math.round(rect.left),
                    right: Math.round(rect.right),
                    width: Math.round(rect.width),
                    visible: rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden",
                };
            })
        ).filter(item => item.visible && (item.left < -2 || item.right > viewportWidth + 2));

        return { viewportWidth, scrollWidth, criticalOverflow };
    });

    expect(result.scrollWidth, `page scrollWidth exceeded viewport: ${JSON.stringify(result)}`)
        .toBeLessThanOrEqual(result.viewportWidth + 2);
    expect(result.criticalOverflow, `critical layout overflow: ${JSON.stringify(result.criticalOverflow)}`)
        .toEqual([]);
}

test.describe("tablet layout", () => {
    for (const viewport of tabletViewports) {
        for (const route of layoutRoutes) {
            test(`${viewport.name} keeps ${route} inside the viewport`, async ({ page }) => {
                await page.setViewportSize({ width: viewport.width, height: viewport.height });
                await seedTabletStorage(page);
                await page.goto(route);
                if (route.startsWith("/solve/")) await continueSolveEntryIfPresent(page);
                await page.waitForTimeout(150);
                await expect(page.locator("body")).toBeVisible();
                await expectNoCriticalOverflow(page);
            });
        }

        test(`${viewport.name} uses the expected solve layout`, async ({ page }) => {
            await page.setViewportSize({ width: viewport.width, height: viewport.height });
            await seedTabletStorage(page);
            await page.goto("/solve/tablet-exam");
            await continueSolveEntryIfPresent(page);
            await page.waitForTimeout(150);

            const solveMetrics = await page.evaluate(() => {
                const body = document.querySelector<HTMLElement>(".solve-body");
                const pdf = document.querySelector<HTMLElement>(".solve-pdf-pane");
                const omr = document.querySelector<HTMLElement>(".solve-omr-pane");
                const firstBubble = document.querySelector<HTMLElement>(".q-bubble");
                if (!body || !pdf || !omr || !firstBubble) return null;

                const bodyStyle = window.getComputedStyle(body);
                const pdfRect = pdf.getBoundingClientRect();
                const omrRect = omr.getBoundingClientRect();
                const bubbleRect = firstBubble.getBoundingClientRect();
                return {
                    direction: bodyStyle.flexDirection,
                    pdfBottom: Math.round(pdfRect.bottom),
                    omrTop: Math.round(omrRect.top),
                    omrWidth: Math.round(omrRect.width),
                    bubbleSize: Math.min(Math.round(bubbleRect.width), Math.round(bubbleRect.height)),
                };
            });

            expect(solveMetrics).not.toBeNull();
            if (!solveMetrics) return;

            if (viewport.width <= 768) {
                expect(solveMetrics.direction).toBe("column");
                expect(solveMetrics.omrTop).toBeGreaterThanOrEqual(solveMetrics.pdfBottom - 2);
                expect(solveMetrics.omrWidth).toBeGreaterThanOrEqual(viewport.width - 2);
            } else {
                expect(solveMetrics.direction).toBe("row");
                const expectedCompactPanelWidth = Math.max(280, Math.min(320, Math.floor(viewport.width * 0.32))) - 2;
                expect(solveMetrics.omrWidth).toBeGreaterThanOrEqual(expectedCompactPanelWidth);
            }
            expect(solveMetrics.bubbleSize).toBeGreaterThanOrEqual(30);
        });
    }
});
