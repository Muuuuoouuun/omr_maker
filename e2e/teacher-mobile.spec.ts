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

async function seedTeacherAttemptReview(page: Page) {
    await page.addInitScript(() => {
        const exam = {
            id: "teacher-mobile-review-exam",
            title: "교사 모바일 리뷰 시험",
            createdAt: "2026-07-13T00:00:00.000Z",
            updatedAt: "2026-07-13T00:00:00.000Z",
            questions: [
                { id: 1, number: 1, answer: 2, choices: 4, score: 50, label: "개념" },
                { id: 2, number: 2, answer: 4, choices: 4, score: 50, label: "응용" },
            ],
            accessConfig: { type: "public" },
        };
        const attempt = {
            id: "teacher-mobile-review-attempt",
            examId: exam.id,
            examTitle: exam.title,
            studentName: "모바일 학생",
            studentId: "teacher-mobile-student",
            studentProfileId: "teacher-mobile-student",
            groupId: "teacher-mobile-group",
            groupName: "모바일반",
            startedAt: "2026-07-13T00:00:00.000Z",
            finishedAt: "2026-07-13T00:10:00.000Z",
            score: 50,
            totalScore: 100,
            answers: { 1: 2, 2: 1 },
            status: "completed",
            studentQuestions: [{
                questionId: 2,
                questionNumber: 2,
                body: "2번 오답 근거를 알려주세요.",
                createdAt: "2026-07-13T00:11:00.000Z",
                status: "queued",
            }],
        };
        window.localStorage.setItem(`omr_exam_${exam.id}`, JSON.stringify(exam));
        window.localStorage.setItem("omr_attempts", JSON.stringify([attempt]));
    });
}

test.describe("Teacher phone and tablet app chrome", () => {
    test.beforeEach(async ({ baseURL }) => {
        test.skip(!isLocalBaseURL(baseURL), "Authenticated teacher mobile checks require local teacher login.");
    });

    test("keeps the dashboard header touch friendly", async ({ page }) => {
        await loginAsTeacher(page, "/teacher/dashboard");

        await expect(page.getByRole("heading", { name: "분석 센터" })).toBeVisible();
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

    test("keeps the teacher attempt review readable without a collapsed detail pane", async ({ page }) => {
        await seedTeacherAttemptReview(page);
        await loginAsTeacher(page, "/teacher/attempt/teacher-mobile-review-attempt");

        await expect(page.getByRole("heading", { name: "모바일 학생" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "학생 풀이 필기" })).toBeVisible();
        await expect(page.getByText("2번 오답 근거를 알려주세요.")).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await expect(page.locator(".mobile-install-prompt")).toHaveCount(0);

        const layout = await page.evaluate(() => {
            const sidebar = document.querySelector<HTMLElement>(".teacher-attempt-sidebar")?.getBoundingClientRect();
            const detail = document.querySelector<HTMLElement>(".teacher-attempt-detail")?.getBoundingClientRect();
            return sidebar && detail ? {
                compact: window.matchMedia("(max-width: 760px)").matches,
                sidebarWidth: sidebar.width,
                detailWidth: detail.width,
                detailTop: detail.top,
                sidebarBottom: sidebar.bottom,
            } : null;
        });
        expect(layout).not.toBeNull();
        expect(layout!.detailWidth).toBeGreaterThanOrEqual(300);
        expect(layout!.detailWidth).toBeGreaterThanOrEqual(layout!.sidebarWidth - 2);
        if (layout!.compact) {
            expect(layout!.detailTop).toBeGreaterThanOrEqual(layout!.sidebarBottom);
        }
    });
});
