import { devices, expect, test, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { registerCanonicalRemoteFixture } from "./fixtures/canonical-remote-fixture";
import { loginAsShowcaseTeacher, loginAsTeacher } from "./helpers";
import { mintTeacherToken } from "../src/lib/teacherAuth";
import { createSignedTeacherSessionCookie, TEACHER_SERVER_SESSION_COOKIE } from "../src/lib/teacherServerSession";
import {
    createTeacherSession,
    LEGACY_TEACHER_TOKEN_KEY,
    TEACHER_SESSION_KEY,
    type TeacherSessionIdentity,
} from "../src/lib/teacherSession";
import type { RosterSnapshot } from "../src/lib/rosterPersistence";

const CANONICAL_TEACHER_IDENTITY: TeacherSessionIdentity = {
    teacherId: "admin",
    email: "admin@example.com",
    displayName: "E2E Admin",
    organizationId: "default",
    organizationName: "E2E Workspace",
    memberRole: "admin",
    sessionAuthority: "bootstrap",
    accountSessionGeneration: 1,
};

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

async function authenticateCanonicalTeacher(page: Page, baseURL?: string) {
    const token = mintTeacherToken();
    const session = createTeacherSession(token, Date.now(), CANONICAL_TEACHER_IDENTITY);
    const signedCookie = createSignedTeacherSessionCookie(token, CANONICAL_TEACHER_IDENTITY);
    if (!signedCookie) throw new Error("canonical teacher fixture cookie is invalid");
    const origin = new URL(baseURL || "http://localhost:3003").origin;

    await page.context().clearCookies();
    await page.context().addCookies([{
        name: TEACHER_SERVER_SESSION_COOKIE,
        value: signedCookie,
        url: origin,
        httpOnly: true,
        sameSite: "Lax",
        secure: false,
    }]);
    const seedSession = ({ storedSession, sessionKey, legacyTokenKey }: {
        storedSession: ReturnType<typeof createTeacherSession>;
        sessionKey: string;
        legacyTokenKey: string;
    }) => {
        window.sessionStorage.setItem(sessionKey, JSON.stringify(storedSession));
        window.sessionStorage.setItem(legacyTokenKey, storedSession.token);
    };
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate(seedSession, {
        storedSession: session,
        sessionKey: TEACHER_SESSION_KEY,
        legacyTokenKey: LEGACY_TEACHER_TOKEN_KEY,
    });
    await page.addInitScript(seedSession, {
        storedSession: session,
        sessionKey: TEACHER_SESSION_KEY,
        legacyTokenKey: LEGACY_TEACHER_TOKEN_KEY,
    });
}

async function loginWithCanonicalDashboard(page: Page, baseURL: string | undefined, roster: RosterSnapshot) {
    await authenticateCanonicalTeacher(page, baseURL);
    await page.request.get("/teacher/dashboard");
    const remoteFixture = await registerCanonicalRemoteFixture(page);
    const actionIds = remoteFixture.activateEmptyTeacherDashboard(roster);
    await page.goto("/teacher/dashboard");
    for (const [actionName, actionId] of Object.entries(actionIds)) {
        await expect.poll(
            () => remoteFixture.rewrittenActionIds.has(actionId),
            { timeout: 15_000, message: `Expected intercepted ${actionName}` },
        ).toBe(true);
    }
}

async function loginWithCanonicalRoster(page: Page, baseURL: string | undefined, roster: RosterSnapshot) {
    await authenticateCanonicalTeacher(page, baseURL);
    await page.request.get("/teacher/users");
    const remoteFixture = await registerCanonicalRemoteFixture(page);
    const { loadRoster } = remoteFixture.activateRoster(roster);
    await page.goto("/teacher/users");
    await expect.poll(
        () => remoteFixture.rewrittenActionIds.has(loadRoster),
        { timeout: 15_000 },
    ).toBe(true);
}

async function drawingOverlayPixelCount(locator: Locator): Promise<number> {
    return locator.evaluate(element => {
        const canvas = element as HTMLCanvasElement;
        const context = canvas.getContext("2d");
        if (!context) return -1;
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let visiblePixels = 0;
        for (let index = 3; index < pixels.length; index += 4) {
            if (pixels[index] !== 0) visiblePixels += 1;
        }
        return visiblePixels;
    });
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

async function expectTeacherHeaderTouchFriendly(page: Page, options: { hasDashboardShortcut: boolean }) {
    const header = page.locator(".teacher-header").first();
    const liveAction = header.locator(".teacher-header-live-action");

    await expect(header).toBeVisible();
    await expectTouchTarget(header.getByRole("button", { name: "빠른 검색" }));
    await expectTouchTarget(header.getByRole("button", { name: /알림/ }));
    if (await page.evaluate(() => window.matchMedia("(max-width: 640px)").matches)) {
        await expect(liveAction).toBeHidden();
    } else {
        await expectTouchTarget(liveAction);
    }

    const accountTrigger = header.getByRole("button", { name: "교사 계정 메뉴" });
    await expectTouchTarget(accountTrigger);
    await accountTrigger.click();
    const accountMenu = header.getByRole("menu", { name: "교사 계정" });
    await expect(accountMenu).toBeVisible();
    if (options.hasDashboardShortcut) {
        await expectTouchTarget(accountMenu.getByRole("menuitem", { name: "대시보드" }));
    } else {
        await expect(accountMenu.getByRole("menuitem", { name: "대시보드" })).toHaveCount(0);
    }
    await expectTouchTarget(accountMenu.getByRole("menuitem", { name: "실시간 모니터링" }));
    await expectTouchTarget(accountMenu.getByRole("menuitem", { name: "설정" }));
    await expectTouchTarget(accountMenu.getByRole("menuitem", { name: "요금제 및 결제" }));
    await expectTouchTarget(accountMenu.getByRole("menuitem", { name: "교사 로그아웃" }));
    await expectTouchTarget(accountMenu.getByRole("menuitem", { name: /모드로 전환/ }));

    const menuItems = accountMenu.getByRole("menuitem");
    await expect(menuItems.first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menuItems.nth(1)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(menuItems.first()).toBeFocused();
    await page.keyboard.press("End");
    await expect(menuItems.last()).toBeFocused();
    await page.keyboard.press("Home");
    await expect(menuItems.first()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(accountMenu).toBeHidden();
    await expect(accountTrigger).toBeFocused();

    await accountTrigger.click();
    await expect(menuItems.first()).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(accountMenu).toBeHidden();
    await expect(accountTrigger).toBeFocused();

    await accountTrigger.click();
    await expect(menuItems.first()).toBeFocused();
    await page.keyboard.press("End");
    await expect(menuItems.last()).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(accountMenu).toBeHidden();
    await page.keyboard.press("ArrowDown");
    await expect(accountMenu).toBeHidden();
    expect(await smallTargets(page, ".teacher-header button, .teacher-header a[href]")).toEqual([]);
    await expectNoHorizontalOverflow(page);
}

async function seedTeacherAttemptReview(page: Page) {
    const pdfBytes = readFileSync(path.join(process.cwd(), "e2e/fixtures/sample-problem.pdf"));
    const pdfData = `data:application/pdf;base64,${pdfBytes.toString("base64")}`;
    await page.addInitScript(({ pdfData }) => {
        const exam = {
            id: "teacher-mobile-review-exam",
            organizationId: "default",
            createdByUserId: "admin",
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
            organizationId: "default",
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
                1: ["M 120 180 L 210 180 L 210 260"],
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
        const returnedFeedback = {
            id: `feedback:${attempt.id}`,
            attemptId: attempt.id,
            examId: exam.id,
            organizationId: "default",
            studentProfileId: attempt.studentProfileId,
            teacherUserId: "admin",
            status: "returned",
            revision: 1,
            summary: "모바일 필기 검토 완료",
            questionComments: [],
            downloadPolicy: {
                allowStudentDownload: false,
                allowAnnotatedPdfDownload: false,
                watermarkStudentName: true,
            },
            delivery: {
                notificationStatus: "sent",
                notificationChannel: "in_app",
                openCount: 0,
            },
            returnedAt: "2026-07-13T00:12:00.000Z",
            createdAt: "2026-07-13T00:11:00.000Z",
            updatedAt: "2026-07-13T00:12:00.000Z",
        };
        window.localStorage.setItem(`omr_exam_${exam.id}`, JSON.stringify(exam));
        window.localStorage.setItem("omr_attempts", JSON.stringify([attempt]));
        // The shared E2E server intentionally runs on Free. Returned feedback is
        // the supported read-only path for viewing archived handwriting after a downgrade.
        window.localStorage.setItem("omr_attempt_feedback", JSON.stringify([returnedFeedback]));
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
        test.info().annotations.push({ type: "release-proof", description: "ux_accessibility_responsiveness_teacher_mobile" });
        await loginAsTeacher(page, "/teacher/dashboard");

        await expect(page.getByRole("main", { name: "분석 센터" })).toBeVisible();
        await expectTeacherHeaderTouchFriendly(page, { hasDashboardShortcut: false });

        await page.locator(".teacher-header").getByRole("button", { name: /알림/ }).click();
        await expect(page.getByRole("dialog", { name: "알림 목록" })).toBeVisible();
        await expectNoHorizontalOverflow(page);
    });

    test("collapses an empty teacher dashboard to one onboarding action", async ({ page, baseURL }) => {
        await loginWithCanonicalDashboard(page, baseURL, { students: [], groups: [], invites: [] });

        const main = page.getByRole("main");
        await expect(main.getByRole("link", { name: "첫 시험 만들기" })).toBeVisible();
        await expect(main.getByRole("group", { name: "대시보드 보기" })).toHaveCount(0);
        await expect(main.getByText("빠른 작업", { exact: true })).toHaveCount(0);
        await expect(main.getByRole("button", { name: "통계 CSV" })).toHaveCount(0);
        await expect(main.locator(".overview-exam-summary-table")).toHaveCount(0);
        await expectNoHorizontalOverflow(page);
    });

    test("keeps dashboard analytics available for a groups-only roster", async ({ page, baseURL }) => {
        await loginWithCanonicalDashboard(page, baseURL, {
            students: [],
            groups: [{
                id: "group-without-students",
                name: "신규 등록반",
                region: "서울",
                count: 0,
                avgScore: 0,
                color: "#4f46e5",
            }],
            invites: [],
        });

        const main = page.getByRole("main");
        await expect(main.getByRole("group", { name: "대시보드 보기" })).toBeVisible();
        await expect(main.locator(".dashboard-empty-onboarding")).toHaveCount(0);
        await expectNoHorizontalOverflow(page);
    });

    test("connects dashboard metrics to the next analysis action", async ({ page }) => {
        test.setTimeout(60_000);
        await loginAsShowcaseTeacher(page);

        await expect(page.getByRole("heading", { name: "대시보드", exact: true })).toBeVisible();
        const scoreMetric = page.getByRole("button", { name: /전체 평균 점수.*점수 원인 보기/ });
        await expectTouchTarget(scoreMetric);
        await expect(scoreMetric).toContainText(/직전 시험보다 .*점 (상승|하락)/);
        await scoreMetric.click();
        await expect(page).toHaveURL(/tab=exam/, { timeout: 25_000 });
        await expect(page.getByRole("button", { name: "시험별 분석" })).toHaveAttribute("aria-pressed", "true");

        await page.getByRole("button", { name: "개요", exact: true }).click();
        const studentMetric = page.getByRole("button", { name: /명단 학생.*학생별 성취 보기/ });
        await expectTouchTarget(studentMetric);
        await studentMetric.click();
        await expect(page).toHaveURL(/tab=student/, { timeout: 25_000 });
        await expect(page.getByRole("button", { name: "학생별 분석" })).toHaveAttribute("aria-pressed", "true");
        await expectNoHorizontalOverflow(page);
    });

    test("progressively reveals showcase exam results on a 390px phone", async ({ page }) => {
        test.setTimeout(60_000);
        await page.setViewportSize({ width: 390, height: 844 });
        await loginAsShowcaseTeacher(page);
        await page.goto("/teacher/exam/mock-final-comprehensive");

        await expect(page.getByRole("heading", { name: "[예시] 기말고사 대비 종합평가" })).toBeVisible();
        await expect(page.locator(".teacher-exam-results-table")).toBeHidden();

        const cards = page.getByTestId("teacher-exam-mobile-result-card");
        await expect(cards).toHaveCount(6);
        await expect(cards.first()).toContainText("강은우");

        const moreButton = page.getByRole("button", { name: /다음 6명 보기/ });
        await expect(moreButton).toContainText("다음 6명 보기");
        await moreButton.click();
        await expect(cards).toHaveCount(12);

        await page.getByLabel("결과 정렬").selectOption("name");
        await expect(cards).toHaveCount(6);
        await expect(cards.first()).toContainText("강다은");
        const sortedMoreButton = page.getByRole("button", { name: /다음 6명 보기/ });
        await expect(sortedMoreButton).toBeVisible();
        await sortedMoreButton.click();
        await expect(cards).toHaveCount(12);
        await expectNoHorizontalOverflow(page);
    });

    test("replaces the student roster table with compact cards on a 390px phone", async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await loginAsShowcaseTeacher(page);
        await page.goto("/teacher/users");

        await expect(page.getByRole("heading", { name: "사용자 관리" })).toBeVisible();
        await expect(page.getByRole("status", { name: "데모 명단 안내" })).toBeVisible();
        await expect(page.getByText("명단 분석", { exact: true })).toBeVisible();
        await expect(page.locator(".teacher-users-table-scroll")).toBeHidden();

        const cards = page.getByTestId("teacher-users-mobile-card");
        await expect(cards).toHaveCount(24);
        const firstCard = cards.first();
        await expect(firstCard).toContainText("김민준");
        await expect(firstCard).toContainText("3학년 A반");
        await expect(firstCard).toContainText("서울");
        await expect(firstCard.getByLabel("평균 55점")).toBeVisible();
        await expect(firstCard.getByLabel("응시 3회")).toBeVisible();
        await expect(firstCard.getByLabel("최근 활동 1시간 전")).toBeVisible();
        await expectTouchTarget(firstCard.getByRole("button", { name: "김민준 상세 보기" }));
        await expectNoHorizontalOverflow(page);
    });

    test("shows only empty-state roster actions when no students exist", async ({ page, baseURL }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await loginWithCanonicalRoster(page, baseURL, { students: [], groups: [], invites: [] });

        await expect(page.getByText("아직 등록된 학생이 없습니다")).toBeVisible();
        await expect(page.getByRole("button", { name: "학생 추가" })).toHaveCount(1);
        await expect(page.getByRole("button", { name: "CSV 업로드" })).toHaveCount(1);
        await expect(page.getByPlaceholder("이름, 이메일, 반, 지역 검색")).toHaveCount(0);
        await expect(page.locator(".teacher-users-table-scroll")).toHaveCount(0);
        await expect(page.getByText("명단 분석", { exact: true })).toHaveCount(0);
        await expectNoHorizontalOverflow(page);
    });

    test("keeps mobile roster search and detail actions clear of data-source toasts", async ({ page }) => {
        test.setTimeout(45_000);
        await page.setViewportSize({ width: 390, height: 844 });
        await loginAsShowcaseTeacher(page);
        await page.goto("/teacher/users");

        const search = page.getByPlaceholder("이름, 이메일, 반, 지역 검색");
        await search.fill("이서연");
        const cards = page.getByTestId("teacher-users-mobile-card");
        await expect(cards).toHaveCount(1);
        await expect(cards.first()).toContainText("이서연");
        await cards.first().getByRole("button", { name: "이서연 상세 보기" }).click();
        await expect(page.getByRole("heading", { name: "학생 상세" })).toBeVisible({ timeout: 15_000 });

        // Showcase/demo already has a persistent inline source notice. Startup
        // fallback information must not stack fixed toasts over mobile actions.
        await expect(page.getByRole("region", { name: "알림" })).toHaveCount(0);
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
            await expectTeacherHeaderTouchFriendly(page, { hasDashboardShortcut: true });
        }
    });

    test("keeps billing secondary content expanded on desktop and collapsed on phones", async ({ page }) => {
        await page.addInitScript(() => {
            window.localStorage.setItem("omr_plan_invoices", JSON.stringify([{
                id: "LOCAL-2026-08-0001",
                date: "2026-08-04",
                amount: 49000,
                status: "local_record",
                desc: "Pro 플랜 · 로컬 변경 기록",
            }]));
        });
        await page.setViewportSize({ width: 1280, height: 900 });
        await loginAsTeacher(page, "/teacher/billing");

        const desktopAcademy = page.locator(".billing-academy-desktop");
        const desktopHistory = page.locator(".billing-history-desktop");
        const historyDownload = desktopHistory.getByRole("button", { name: "전체 기록 다운로드" });
        await expect(desktopAcademy).toBeVisible();
        await expect(desktopHistory).toBeVisible();
        await expect(historyDownload).toBeEnabled();
        await historyDownload.focus();
        await expect(historyDownload).toBeFocused();
        await expect(page.locator(".billing-academy-disclosure")).toBeHidden();
        await expect(page.locator(".billing-history-disclosure")).toBeHidden();

        await page.setViewportSize({ width: 390, height: 844 });
        const mobileAcademy = page.locator(".billing-academy-disclosure");
        const mobileHistory = page.locator(".billing-history-disclosure");
        await expect(desktopAcademy).toBeHidden();
        await expect(desktopHistory).toBeHidden();
        await expect(mobileAcademy).toBeVisible();
        await expect(mobileHistory).toBeVisible();
        await expect(mobileAcademy).not.toHaveAttribute("open", "");
        await expect(mobileHistory).not.toHaveAttribute("open", "");
        await mobileHistory.locator("summary").click();
        await expect(mobileHistory).toHaveAttribute("open", "");
        await expect(mobileHistory.getByRole("button", { name: "전체 기록 다운로드" })).toBeVisible();
    });

    test("keeps the exam creation toolbar touch friendly", async ({ page }) => {
        await loginAsTeacher(page, "/create");

        const toolbar = page.locator(".create-editor-actions");
        await expect(toolbar).toBeVisible();
        await expectTouchTarget(toolbar.getByRole("button", { name: /되돌리기/ }));
        await expectTouchTarget(toolbar.getByRole("button", { name: /다시 실행/ }));
        const pdfMenuTrigger = toolbar.getByRole("button", { name: "PDF 관리" });
        await expectTouchTarget(pdfMenuTrigger);
        await pdfMenuTrigger.click();
        const pdfMenu = page.getByRole("menu", { name: "PDF 관리" });
        await expect(pdfMenu.getByRole("menuitem", { name: "문제지 PDF 선택" })).toBeFocused();
        await expectTouchTarget(pdfMenu.getByRole("menuitem", { name: "문제지 PDF 선택" }));
        await expectTouchTarget(pdfMenu.getByRole("menuitem", { name: "답지 PDF 선택" }));
        const [menuBox, viewport] = await Promise.all([
            pdfMenu.boundingBox(),
            page.evaluate(() => ({ width: document.documentElement.clientWidth, height: document.documentElement.clientHeight })),
        ]);
        expect(menuBox).not.toBeNull();
        expect(menuBox!.width).toBeGreaterThan(0);
        expect(menuBox!.height).toBeGreaterThan(0);
        expect(menuBox!.x).toBeGreaterThanOrEqual(0);
        expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(viewport.width);
        expect(menuBox!.y).toBeGreaterThanOrEqual(0);
        expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(viewport.height);
        await page.keyboard.press("Tab");
        await expect(pdfMenu).toBeHidden();
        await expect(pdfMenuTrigger).toBeFocused();
        await pdfMenuTrigger.click();
        await page.keyboard.press("Escape");
        await expect(pdfMenu).toBeHidden();
        await expect(pdfMenuTrigger).toBeFocused();
        await pdfMenuTrigger.click();
        await expect(pdfMenu).toBeVisible();
        await toolbar.getByRole("button", { name: /되돌리기/ }).focus();
        await expect(pdfMenu).toBeHidden();
        await pdfMenuTrigger.click();
        await expect(pdfMenu).toBeVisible();
        await page.locator("#create-pdf-panel").click({ position: { x: 8, y: 200 } });
        await expect(pdfMenu).toBeHidden();
        const completionActions = page.locator(".create-primary-actions:visible");
        await expectTouchTarget(completionActions.getByRole("button", { name: "초안 저장" }));
        await expectTouchTarget(completionActions.getByRole("button", { name: "배포하기" }));
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
        const distributeButton = completionActions.getByRole("button", { name: "배포하기" });
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

    test("uses the tabbed create workspace at the 1180px intermediate width", async ({ page }) => {
        await page.setViewportSize({ width: 1180, height: 820 });
        await loginAsTeacher(page, "/create");

        const tabs = page.getByRole("tablist", { name: "출제 작업 화면" });
        await expect(tabs).toBeVisible();
        const [tabsBox, workspaceBox, viewport] = await Promise.all([
            tabs.boundingBox(),
            page.locator(".create-workspace").boundingBox(),
            page.evaluate(() => ({ width: document.documentElement.clientWidth, height: document.documentElement.clientHeight })),
        ]);
        expect(tabsBox).not.toBeNull();
        expect(workspaceBox).not.toBeNull();
        expect(tabsBox!.x).toBeGreaterThanOrEqual(0);
        expect(tabsBox!.x + tabsBox!.width).toBeLessThanOrEqual(viewport.width);
        expect(workspaceBox!.x).toBeGreaterThanOrEqual(0);
        expect(workspaceBox!.x + workspaceBox!.width).toBeLessThanOrEqual(viewport.width);
        await expect(page.locator(".create-resizer").first()).toBeHidden();
        await expect(page.locator("#create-pdf-panel")).toBeVisible();
        await expect(page.locator("#create-settings-panel")).toBeHidden();
        await expect(page.locator("#create-preview-panel")).toBeHidden();

        await tabs.getByRole("tab", { name: "설정", exact: true }).click();
        await expect(page.locator("#create-pdf-panel")).toBeHidden();
        await expect(page.locator("#create-settings-panel")).toBeVisible();
        await expectNoHorizontalOverflow(page);
    });

    test("keeps the primary create action visible above mobile content", async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await loginAsTeacher(page, "/create");

        const workspaceTabs = page.getByRole("tablist", { name: "출제 작업 화면" });
        await workspaceTabs.getByRole("tab", { name: /설정/ }).click();
        await page.getByLabel("시험 제목").fill("모바일 배포 액션 시험");
        await page.getByLabel("빠른 정답 입력").fill("1".repeat(20));

        const actionRail = page.locator(".create-primary-actions:visible");
        const distribute = actionRail.getByRole("button", { name: "배포하기" });
        await expect(actionRail).toHaveCount(1);
        await expect(distribute).toBeInViewport();

        await page.getByLabel("빠른 정답 입력").fill("");
        await distribute.click();
        const toast = page.locator(".toast-host > div").first();
        await expect(toast).toBeVisible();
        const [toastBox, toastRailBox] = await Promise.all([toast.boundingBox(), actionRail.boundingBox()]);
        expect(toastBox).not.toBeNull();
        expect(toastRailBox).not.toBeNull();
        expect(toastBox!.y + toastBox!.height).toBeLessThanOrEqual(toastRailBox!.y);

        const [railBox, distributeBox, viewport, railPosition] = await Promise.all([
            actionRail.boundingBox(),
            distribute.boundingBox(),
            page.evaluate(() => ({
                width: document.documentElement.clientWidth,
                height: document.documentElement.clientHeight,
            })),
            actionRail.evaluate(element => getComputedStyle(element).position),
        ]);
        expect(railBox).not.toBeNull();
        expect(distributeBox).not.toBeNull();
        expect(railPosition).toBe("sticky");
        expect(distributeBox!.height).toBeGreaterThanOrEqual(44);
        expect(railBox!.x).toBeGreaterThanOrEqual(0);
        expect(railBox!.x + railBox!.width).toBeLessThanOrEqual(viewport.width);
        expect(railBox!.y + railBox!.height).toBeLessThanOrEqual(viewport.height);

        for (const requiredField of [
            page.getByLabel("시험 제목"),
            page.getByLabel("빠른 정답 입력"),
        ]) {
            await requiredField.scrollIntoViewIfNeeded();
            const [fieldBox, settledRailBox] = await Promise.all([
                requiredField.boundingBox(),
                actionRail.boundingBox(),
            ]);
            expect(fieldBox).not.toBeNull();
            expect(settledRailBox).not.toBeNull();
            expect(
                fieldBox!.y + fieldBox!.height <= settledRailBox!.y
                || fieldBox!.y >= settledRailBox!.y + settledRailBox!.height
            ).toBe(true);
        }

        await expectNoHorizontalOverflow(page);
    });

    test("keeps returned handwriting readable without a collapsed detail pane after downgrade", async ({ page }) => {
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
        const drawingOverlay = handwritingPanel.getByTestId("pdf-draw-overlay");
        await expect(drawingOverlay).toBeVisible({ timeout: 20_000 });
        await expect.poll(() => drawingOverlayPixelCount(drawingOverlay)).toBeGreaterThan(20);
        const sidebarBox = await handwritingPanel.locator("aside").boundingBox();
        const viewerBox = await page.getByRole("heading", { name: "학생 풀이 필기" })
            .locator("xpath=ancestor::section[1]")
            .boundingBox();
        expect(sidebarBox).not.toBeNull();
        expect(viewerBox).not.toBeNull();
        expect(viewerBox!.width).toBeGreaterThanOrEqual(300);
        expect(viewerBox!.width).toBeGreaterThanOrEqual(sidebarBox!.width - 2);
        const stacksHandwritingPanels = await page.evaluate(() => window.matchMedia("(max-width: 760px)").matches);
        if (stacksHandwritingPanels) {
            expect(viewerBox!.y).toBeGreaterThanOrEqual(sidebarBox!.y + sidebarBox!.height);
        } else {
            expect(viewerBox!.x).toBeGreaterThanOrEqual(sidebarBox!.x + sidebarBox!.width);
            expect(Math.abs(viewerBox!.y - sidebarBox!.y)).toBeLessThanOrEqual(2);
        }
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
        test.setTimeout(60_000);
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
        await expect(page).toHaveURL(/view=handwriting/, { timeout: 15_000 });
        await expect(page.getByRole("tab", { name: "답안" })).toHaveAttribute("aria-selected", "false");
        await expect(page.getByRole("tab", { name: "필기" })).toHaveAttribute("aria-selected", "true");
    });
});
