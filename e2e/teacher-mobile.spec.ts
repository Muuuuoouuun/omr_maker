import { devices, expect, test, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { loginAsTeacher } from "./helpers";

function isLocalBaseURL(baseURL?: string): boolean {
    const url = new URL(baseURL || "http://localhost:3003");
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
}

function sortedCoordinateGroupCounts(values: number[], tolerance = 2): number[] {
    const groups: number[][] = [];
    for (const value of [...values].sort((left, right) => left - right)) {
        const currentGroup = groups[groups.length - 1];
        if (currentGroup && Math.abs(value - currentGroup[0]) <= tolerance) {
            currentGroup.push(value);
        } else {
            groups.push([value]);
        }
    }
    return groups.map(group => group.length).sort((left, right) => left - right);
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
        await expectTouchTarget(header.getByRole("link", { name: "대시보드" }));
    }
    await expectTouchTarget(header.getByRole("link", { name: "실시간 모니터링" }));
    await expectTouchTarget(header.getByRole("button", { name: /알림/ }));
    await expectTouchTarget(header.getByRole("button", { name: "교사 로그아웃" }));
    await expectTouchTarget(header.getByRole("button", { name: /모드로 전환/ }));
    expect(await smallTargets(page, ".teacher-header button, .teacher-header a[href]")).toEqual([]);
    await expectNoHorizontalOverflow(page);
}

async function seedTeacherAttemptReview(page: Page) {
    const pdfBytes = readFileSync(path.join(process.cwd(), "e2e/fixtures/sample-problem.pdf"));
    const pdfData = `data:application/pdf;base64,${pdfBytes.toString("base64")}`;
    await page.addInitScript(({ pdfData }) => {
        const exam = {
            id: "teacher-mobile-review-exam",
            title: "교사 모바일 리뷰 시험",
            createdAt: "2026-07-13T00:00:00.000Z",
            updatedAt: "2026-07-13T00:00:00.000Z",
            pdfData,
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
            drawings: {
                1: [JSON.stringify({
                    color: "#ef4444",
                    points: [{ x: 0.2, y: 0.2 }, { x: 0.3, y: 0.25 }],
                })],
            },
            handwriting: {
                schemaVersion: 1,
                status: "saved",
                plan: "pro",
                summary: { pageCount: 1, strokeCount: 1, questionCount: 1 },
                questions: {
                    2: { questionId: 2, questionNumber: 2, page: 1, strokeCount: 1 },
                },
            },
            handwritingArchived: true,
            handwritingPlan: "pro",
            drawingPageCount: 1,
            drawingStrokeCount: 1,
            questionDrawings: [
                { questionId: 2, questionNumber: 2, page: 1, strokeCount: 1 },
            ],
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
    }, { pdfData });
}

test.describe("Teacher phone and tablet app surfaces", () => {
    test.beforeEach(async ({ baseURL }) => {
        test.skip(!isLocalBaseURL(baseURL), "Authenticated teacher mobile checks require local teacher login.");
    });

    test("exposes a labeled, error-connected teacher login form", async ({ page }) => {
        await page.goto("/?role=teacher");

        const loginForm = page.getByRole("form", { name: "교사 로그인" });
        const identifier = loginForm.getByLabel("아이디 또는 이메일");
        const password = loginForm.getByLabel("비밀번호");
        await expect(identifier).toHaveAttribute("autocomplete", "username");
        await expect(password).toHaveAttribute("autocomplete", "current-password");
        await loginForm.getByRole("button", { name: "대시보드 입장" }).click();
        await expect(loginForm.getByRole("alert")).toContainText("아이디와 비밀번호를 모두 입력해주세요.");
        await expect(identifier).toHaveAttribute("aria-invalid", "true");
        await expect(password).toHaveAttribute("aria-invalid", "true");
        await expectNoHorizontalOverflow(page);
    });

    test("keeps the dashboard header touch friendly", async ({ page }) => {
        await loginAsTeacher(page, "/teacher/dashboard");

        await expect(page.getByRole("heading", { name: "분석 센터" })).toBeVisible();
        await expectTeacherHeaderTouchFriendly(page, { hasSearch: false });

        await page.locator(".teacher-header").getByRole("button", { name: /알림/ }).click();
        await expect(page.getByRole("dialog", { name: "알림 목록" })).toBeVisible();
        await expectNoHorizontalOverflow(page);
    });

    test("connects dashboard metrics to the next analysis action", async ({ page }) => {
        await loginAsTeacher(page, "/teacher/dashboard?showcase=1");

        await expect(page.getByRole("heading", { name: /김하늘 선생님/ })).toBeVisible();
        const scoreMetric = page.getByRole("button", { name: /전체 평균 점수.*점수 원인 보기/ });
        await expectTouchTarget(scoreMetric);
        await expect(scoreMetric).toContainText(/직전 시험보다 .*점 (상승|하락)/);
        await scoreMetric.click();
        await expect(page).toHaveURL(/tab=exam/);
        await expect(page.getByRole("tab", { name: "시험별 분석" })).toHaveAttribute("aria-selected", "true");

        await page.getByRole("tab", { name: "개요" }).click();
        const studentMetric = page.getByRole("button", { name: /명단 학생.*학생별 성취 보기/ });
        await expectTouchTarget(studentMetric);
        await studentMetric.click();
        await expect(page).toHaveURL(/tab=student/);
        await expect(page.getByRole("tab", { name: "학생별 분석" })).toHaveAttribute("aria-selected", "true");
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

        const workspaceTabs = page.getByRole("tablist", { name: "출제 작업 화면" });
        if ((await workspaceTabs.count()) > 0) {
            const pdfTab = workspaceTabs.getByRole("tab", { name: /문제지/ });
            const settingsTab = workspaceTabs.getByRole("tab", { name: /설정/ });
            const previewTab = workspaceTabs.getByRole("tab", { name: /미리보기/ });
            await expect(pdfTab).toHaveAttribute("aria-selected", "true");
            await settingsTab.click();
            await expect(settingsTab).toHaveAttribute("aria-selected", "true");
            await expect(page.locator("#create-settings-panel")).toBeVisible();
            await previewTab.click();
            await expect(previewTab).toHaveAttribute("aria-selected", "true");
            await expect(page.locator("#create-preview-panel")).toBeVisible();
            expect(await smallTargets(page, ".create-mobile-panel-nav button")).toEqual([]);
        } else {
            await expect(page.locator("#create-pdf-panel")).toBeVisible();
            await expect(page.locator("#create-settings-panel")).toBeVisible();
            await expect(page.locator("#create-preview-panel")).toBeVisible();
        }

        const firstQuestionEdit = page.getByRole("button", { name: "문제 1번 편집" });
        await expectTouchTarget(firstQuestionEdit);
        await firstQuestionEdit.press("Enter");
        await expect(firstQuestionEdit).toHaveAttribute("aria-pressed", "true");

        if ((await workspaceTabs.count()) > 0) {
            await workspaceTabs.getByRole("tab", { name: /설정/ }).click();
        }
        await page.getByLabel("시험 제목").fill("모바일 배포 접근성 시험");
        await page.getByLabel("빠른 정답 입력").fill("1".repeat(20));
        const distributeButton = toolbar.getByRole("button", { name: "배포하기" });
        await distributeButton.focus();
        await distributeButton.press("Enter");
        const distributeDialog = page.getByRole("dialog", { name: "시험 배포하기" });
        await expect(distributeDialog).toBeVisible();
        await expect(distributeDialog.getByRole("button", { name: "닫기" })).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(distributeDialog).toBeHidden();
        await expect(distributeButton).toBeFocused();
        await expectNoHorizontalOverflow(page);
    });

    test("keeps the teacher attempt review readable without a collapsed detail pane", async ({ page }) => {
        await seedTeacherAttemptReview(page);
        await loginAsTeacher(page, "/teacher/attempt/teacher-mobile-review-attempt");

        await expect(page.getByRole("heading", { name: "모바일 학생" })).toBeVisible();
        await expect(page.getByText("2번 오답 근거를 알려주세요.")).toBeVisible();
        await expect(page.getByRole("tab", { name: "답안" })).toBeVisible();
        await page.getByRole("tab", { name: "필기" }).click();
        await expect(page.getByRole("heading", { name: "학생 풀이 필기" })).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await expect(page.locator(".mobile-install-prompt")).toHaveCount(0);

        const handwritingPanel = page.getByRole("tabpanel", { name: "필기" });
        const sidebarBox = await handwritingPanel.locator("aside").boundingBox();
        const viewerBox = await page.getByRole("heading", { name: "학생 풀이 필기" })
            .locator("xpath=ancestor::section[1]")
            .boundingBox();
        expect(sidebarBox).not.toBeNull();
        expect(viewerBox).not.toBeNull();
        expect(viewerBox!.width).toBeGreaterThanOrEqual(300);
        expect(viewerBox!.width).toBeGreaterThanOrEqual(sidebarBox!.width - 2);
        expect(viewerBox!.y).toBeGreaterThanOrEqual(sidebarBox!.y + sidebarBox!.height);
    });

    test("lays out the mobile student result tabs as touch-friendly rows", async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await seedTeacherAttemptReview(page);
        await loginAsTeacher(page, "/teacher/attempt/teacher-mobile-review-attempt");

        const tabs = page.getByRole("tablist", { name: "학생 결과 보기" });
        const boxes = await Promise.all(["답안", "필기", "리포트", "분석"].map(
            label => tabs.getByRole("tab", { name: label }).boundingBox(),
        ));
        const tabBoxes = boxes.filter((box): box is NonNullable<typeof box> => box !== null);
        expect(tabBoxes).toHaveLength(4);
        expect(sortedCoordinateGroupCounts(tabBoxes.map(box => box.y))).toEqual([2, 2]);
        expect(sortedCoordinateGroupCounts(tabBoxes.map(box => box.x))).toEqual([2, 2]);
        for (const box of tabBoxes) expect(box.height).toBeGreaterThanOrEqual(44);
        await expect(page.getByLabel("응시 회차 선택")).toBeVisible();
        await expectNoHorizontalOverflow(page);
    });
});

test.describe("Teacher desktop Chromium result tab accessibility", () => {
    const desktopChrome = devices["Desktop Chrome"];
    test.use({
        userAgent: desktopChrome.userAgent,
        viewport: desktopChrome.viewport,
        deviceScaleFactor: desktopChrome.deviceScaleFactor,
        isMobile: desktopChrome.isMobile,
        hasTouch: desktopChrome.hasTouch,
    });

    test.beforeEach(async ({ baseURL }) => {
        test.skip(!isLocalBaseURL(baseURL), "Authenticated teacher checks require local teacher login.");
    });

    test("moves focus across result tabs before keyboard activation", async ({ page }) => {
        await seedTeacherAttemptReview(page);
        await loginAsTeacher(page, "/teacher/attempt/teacher-mobile-review-attempt");

        const tabs = page.getByRole("tablist", { name: "학생 결과 보기" });
        const answersTab = tabs.getByRole("tab", { name: "답안" });
        const handwritingTab = tabs.getByRole("tab", { name: "필기" });
        await answersTab.focus();
        const urlBeforeArrowRight = page.url();
        await answersTab.press("ArrowRight");
        await expect(handwritingTab).toBeFocused();
        await expect(answersTab).toHaveAttribute("aria-selected", "true");
        await expect(handwritingTab).toHaveAttribute("aria-selected", "false");
        await expect(page).toHaveURL(urlBeforeArrowRight);

        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(/view=handwriting/);
        await expect(page.getByRole("tab", { name: "답안" })).toHaveAttribute("aria-selected", "false");
        await expect(page.getByRole("tab", { name: "필기" })).toHaveAttribute("aria-selected", "true");
    });
});
