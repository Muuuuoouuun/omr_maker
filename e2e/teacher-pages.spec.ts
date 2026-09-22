import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { registerCanonicalRemoteFixture } from "./fixtures/canonical-remote-fixture";
import { mintTeacherToken } from "../src/lib/teacherAuth";
import { MOCKUP_TEACHER_IDENTITY } from "../src/lib/mockupAccount";
import { createSignedTeacherSessionCookie, TEACHER_SERVER_SESSION_COOKIE } from "../src/lib/teacherServerSession";
import { loginAsShowcaseTeacher } from "./helpers";
import {
    createTeacherSession,
    LEGACY_TEACHER_TOKEN_KEY,
    TEACHER_SESSION_KEY,
    type TeacherSessionIdentity,
} from "../src/lib/teacherSession";
import type { RosterSnapshot } from "../src/lib/rosterPersistence";

test.describe.configure({ timeout: 45_000 });

const TEACHER_IDENTITY: TeacherSessionIdentity = {
    teacherId: "admin",
    email: "admin@example.com",
    displayName: "Demo Admin",
    organizationId: "default",
    organizationName: "E2E Workspace",
    memberRole: "admin",
    sessionAuthority: "bootstrap",
    accountSessionGeneration: 1,
};

const BILLING_TEACHER_IDENTITY: TeacherSessionIdentity = {
    teacherId: "billing-teacher",
    email: "billing-teacher@example.com",
    displayName: "Billing Teacher",
};

const RESULT_HUB_FEEDBACK = "핵심 개념은 잘 이해했습니다. 응용 문항의 풀이 근거를 한 줄 더 적어보세요.";

function cookieOrigin(baseURL?: string): string {
    try {
        return new URL(baseURL || "http://localhost:3003").origin;
    } catch {
        return "http://localhost:3003";
    }
}

// Each test starts with clean storage and a valid teacher session so mocks are deterministic.
async function authenticateTeacher(
    page: Page,
    baseURL?: string,
    identity: TeacherSessionIdentity = TEACHER_IDENTITY,
) {
    const token = mintTeacherToken();
    const session = createTeacherSession(token, Date.now(), identity);
    const signedCookie = createSignedTeacherSessionCookie(token, identity);

    if (!signedCookie) {
        throw new Error("Failed to create teacher session cookie for e2e test");
    }

    await page.context().clearCookies();
    await page.context().addCookies([{
        name: TEACHER_SERVER_SESSION_COOKIE,
        value: signedCookie,
        url: cookieOrigin(baseURL),
        httpOnly: true,
        sameSite: "Lax",
        secure: false,
    }]);

    // Session seeding only needs the document and Storage APIs. Waiting for
    // every development asset to reach `load` can stall WebKit after a long
    // serial matrix even though the document is already interactive.
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate(() => {
        try { window.localStorage.clear(); } catch {}
        try { window.sessionStorage.clear(); } catch {}
    });

    const seedTeacherSession = ({ session, sessionKey, legacyTokenKey }: {
        session: ReturnType<typeof createTeacherSession>;
        sessionKey: string;
        legacyTokenKey: string;
    }) => {
        try {
            window.sessionStorage.setItem(sessionKey, JSON.stringify(session));
            window.sessionStorage.setItem(legacyTokenKey, session.token);
        } catch {}
    };

    await page.evaluate(seedTeacherSession, {
        legacyTokenKey: LEGACY_TEACHER_TOKEN_KEY,
        session,
        sessionKey: TEACHER_SESSION_KEY,
    });
    await page.addInitScript(seedTeacherSession, {
        legacyTokenKey: LEGACY_TEACHER_TOKEN_KEY,
        session,
        sessionKey: TEACHER_SESSION_KEY,
    });
}

async function settleHydratedPage(page: Page) {
    await page.evaluate(() => new Promise<void>(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
}

async function seedStoredRoster(page: Page): Promise<RosterSnapshot> {
    const snapshot = {
        groups: [{
            id: "e2e-class-a",
            name: "E2E A반",
            region: "서울",
            count: 2,
            avgScore: 0,
            color: "#4f46e5",
        }],
        students: [
            {
                id: "e2e-class-a::김학생",
                name: "김학생",
                email: "kim.student@example.com",
                group: "E2E A반",
                region: "서울",
                avatar: "#4f46e5",
                avgScore: 0,
                examsTaken: 0,
                lastActive: "기록 없음",
                trend: "flat" as const,
                status: "active" as const,
            },
            {
                id: "e2e-class-a::이학생",
                name: "이학생",
                email: "lee.student@example.com",
                group: "E2E A반",
                region: "서울",
                avatar: "#10b981",
                avgScore: 0,
                examsTaken: 0,
                lastActive: "기록 없음",
                trend: "flat" as const,
                status: "active" as const,
            },
        ],
        invites: [],
    } satisfies RosterSnapshot;
    await page.addInitScript(({ groups, students }) => {
        window.localStorage.setItem("omr_groups", JSON.stringify(groups));
        window.localStorage.setItem("omr_students", JSON.stringify(students));
    }, snapshot);
    return snapshot;
}

async function seedDistributionCountRegressionRoster(page: Page): Promise<RosterSnapshot> {
    const snapshot = {
        groups: [{
            id: "distribution-count-regression-group",
            name: "배포 집계 검증반",
            region: "서울",
            // This stale cached value previously leaked into the modal even
            // though the matching roster below has two current members.
            count: 0,
            avgScore: 0,
            color: "#4f46e5",
        }],
        students: [
            {
                id: "distribution-count-regression-group::김학생",
                name: "김학생",
                email: "distribution-kim@example.com",
                group: "배포 집계 검증반",
                region: "서울",
                avatar: "#4f46e5",
                avgScore: 0,
                examsTaken: 0,
                lastActive: "기록 없음",
                trend: "flat" as const,
                status: "active" as const,
            },
            {
                id: "distribution-count-regression-group::이학생",
                name: "이학생",
                email: "distribution-lee@example.com",
                group: "배포 집계 검증반",
                region: "서울",
                avatar: "#10b981",
                avgScore: 0,
                examsTaken: 0,
                lastActive: "기록 없음",
                trend: "flat" as const,
                status: "active" as const,
            },
        ],
        invites: [],
    } satisfies RosterSnapshot;
    await page.addInitScript(({ groups, students }) => {
        window.localStorage.setItem("omr_groups", JSON.stringify(groups));
        window.localStorage.setItem("omr_students", JSON.stringify(students));
    }, snapshot);
    return snapshot;
}

async function seedStudentResultHub(page: Page) {
    await page.addInitScript(() => {
        const exam = {
            id: "result-hub-exam",
            title: "학생 결과 허브 시험",
            organizationId: "default",
            createdByUserId: "admin",
            createdAt: "2026-07-22T00:00:00.000Z",
            updatedAt: "2026-07-22T00:00:00.000Z",
            questions: [
                { id: 1, number: 1, answer: 2, choices: 4, score: 50, label: "개념" },
                { id: 2, number: 2, answer: 4, choices: 4, score: 50, label: "응용" },
            ],
            accessConfig: { type: "public" },
        };
        const original = {
            id: "result-hub-original",
            examId: exam.id,
            examTitle: exam.title,
            organizationId: "default",
            createdByUserId: "admin",
            studentName: "결과 허브 학생",
            studentId: "result-hub-student",
            studentProfileId: "result-hub-student",
            groupId: "result-hub-group",
            groupName: "결과 허브반",
            startedAt: "2026-07-22T09:00:00.000Z",
            finishedAt: "2026-07-22T09:30:00.000Z",
            score: 60,
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
                    1: { questionId: 1, questionNumber: 1, page: 1, strokeCount: 1 },
                },
            },
            handwritingArchived: true,
            handwritingPlan: "pro",
            drawingPageCount: 1,
            drawingStrokeCount: 1,
            questionDrawings: [
                { questionId: 1, questionNumber: 1, page: 1, strokeCount: 1 },
            ],
            status: "completed",
        };
        const retake = {
            id: "result-hub-retake",
            examId: exam.id,
            examTitle: exam.title,
            organizationId: "default",
            createdByUserId: "admin",
            studentName: "결과 허브 학생",
            studentId: "result-hub-student",
            studentProfileId: "result-hub-student",
            groupId: "result-hub-group",
            groupName: "결과 허브반",
            startedAt: "2026-07-22T08:00:00.000Z",
            finishedAt: "2026-07-22T08:20:00.000Z",
            score: 80,
            totalScore: 100,
            answers: { 1: 2, 2: 4 },
            status: "completed",
            retake: {
                sourceAttemptId: original.id,
                questionIds: [2],
                mode: "wrong",
                createdAt: "2026-07-22T08:00:00.000Z",
            },
        };

        window.localStorage.setItem(`omr_exam_${exam.id}`, JSON.stringify(exam));
        window.localStorage.setItem("omr_attempts", JSON.stringify([original, retake]));
    });
}

async function seedAwaySeverityAttempts(page: Page) {
    await page.addInitScript(() => {
        const exam = {
            id: "away-severity-exam",
            title: "화면 이탈 표시 시험",
            organizationId: "default",
            createdByUserId: "admin",
            createdAt: "2026-07-28T00:00:00.000Z",
            updatedAt: "2026-07-28T00:00:00.000Z",
            durationMin: 60,
            questions: [
                { id: 1, number: 1, answer: 2, choices: 4, score: 100, label: "개념" },
            ],
            accessConfig: { type: "public" },
        };
        const attempts = [1, 2, 3].map(count => ({
            id: `away-severity-${count}`,
            examId: exam.id,
            examTitle: exam.title,
            organizationId: "default",
            createdByUserId: "admin",
            studentName: `이탈 ${count}회 학생`,
            studentId: `away-severity-student-${count}`,
            startedAt: `2026-07-28T09:0${count}:00.000Z`,
            finishedAt: `2026-07-28T09:1${count}:00.000Z`,
            score: 100,
            totalScore: 100,
            answers: { 1: 2 },
            tabFociLostCount: count,
            focusLossEvents: Array.from({ length: count === 3 ? 2 : count }, (_, index) => ({
                at: `2026-07-28T09:0${count}:0${index}.000Z`,
                questionId: 1,
                questionNumber: 1,
                count: index + 1,
                reason: index % 2 === 0 ? "blur" : "hidden",
            })),
            status: "completed",
        }));
        const requestedStudentCount = Number(
            window.localStorage.getItem("omr_away_severity_student_count") || "1",
        );
        const studentAttempt = attempts.find(attempt => attempt.id === `away-severity-${requestedStudentCount}`)
            || attempts[0];
        const studentSession = {
            studentId: studentAttempt.studentId,
            loginId: studentAttempt.studentId,
            name: studentAttempt.studentName,
            isGuest: false,
            identityType: "temporary",
            createdAt: new Date().toISOString(),
        };

        window.localStorage.setItem(`omr_exam_${exam.id}`, JSON.stringify(exam));
        window.localStorage.setItem("omr_attempts", JSON.stringify(attempts));
        window.localStorage.setItem("omr_student_session_backup", JSON.stringify(studentSession));
        window.sessionStorage.setItem("omr_student_session", JSON.stringify(studentSession));
    });
}

test("keeps cold-load role choices disabled until the client has hydrated", async ({ page }) => {
    let releaseHydration!: () => void;
    const hydrationGate = new Promise<void>(resolve => { releaseHydration = resolve; });
    await page.route("**/_next/static/**/*.js", async route => {
        await hydrationGate;
        await route.continue();
    });

    try {
        await page.goto("/", { waitUntil: "commit" });
        const roleCards = page.locator(".home-role-card");
        await expect(roleCards).toHaveCount(2);
        await expect(roleCards.nth(0)).toBeDisabled();
        await expect(roleCards.nth(1)).toBeDisabled();

        releaseHydration();
        await expect(roleCards.nth(0)).toBeEnabled();
        await expect(roleCards.nth(1)).toBeEnabled();
        await roleCards.nth(0).click();
        await expect(page.locator("[data-home-role=student]")).toBeVisible();
    } finally {
        releaseHydration();
    }
});

test("opens one student result hub and preserves the selected view across attempts", async ({ page, baseURL }) => {
    test.info().annotations.push({ type: "release-proof", description: "teacher_core_retest" });
    await authenticateTeacher(page, baseURL);
    await seedStudentResultHub(page);
    await page.goto("/teacher/exam/result-hub-exam");

    const originalRow = page.getByRole("row").filter({ hasText: "필기 저장됨" });
    const retakeRow = page.getByRole("row").filter({ hasText: "재시험 1문항" });
    await expect(originalRow.getByRole("link", { name: "결과 허브 학생 결과 보기" })).toHaveCount(1);
    await expect(retakeRow.getByRole("link", { name: "결과 허브 학생 결과 보기" })).toHaveCount(1);

    await originalRow.getByRole("link", { name: "결과 허브 학생 결과 보기" }).click();
    await expect(page).toHaveURL(/\/teacher\/attempt\/result-hub-original/);

    const resultTabs = page.getByRole("tablist", { name: "학생 결과 보기" });
    for (const label of ["답안", "필기", "리포트", "분석"]) {
        await expect(resultTabs.getByRole("tab", { name: label })).toBeVisible();
    }
    await expect(resultTabs.getByRole("tab")).toHaveCount(4);
    await expect(resultTabs.getByRole("tab", { name: "답안" })).toHaveAttribute("aria-selected", "true");

    await resultTabs.getByRole("tab", { name: "분석" }).click();
    await expect(page).toHaveURL(/view=analytics/);
    await page.getByRole("link", { name: /재시험 1/ }).click();
    await expect(page).toHaveURL(/result-hub-retake\?view=analytics/);
    await expect(page.getByRole("link", { name: /재시험 1 \+20점/ })).toBeVisible();

    await page.getByRole("tab", { name: "리포트" }).click();
    await expect(page.getByRole("tabpanel", { name: "리포트" })).toBeVisible();
    await page.getByRole("link", { name: /^원시험/ }).click();
    await expect(page).toHaveURL(/result-hub-original\?view=report/);
    await expect(page.getByRole("tabpanel", { name: "리포트" })).toBeVisible();

    await page.goto("/teacher/attempt/result-hub-original?view=handwriting");
    await expect(page.getByRole("tab", { name: "필기" })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "답안" }).click();
    await expect(page.getByRole("tab", { name: "답안" })).toHaveAttribute("aria-selected", "true");
    await page.goBack();
    await expect(page).toHaveURL(/view=handwriting/);
    await expect(page.getByRole("tab", { name: "필기" })).toHaveAttribute("aria-selected", "true");

    await page.goto("/teacher/attempt/result-hub-original?view=invalid");
    await expect(page.getByRole("tab", { name: "답안" })).toHaveAttribute("aria-selected", "true");
});

test("returns plain-text feedback through the teacher result flow and shows it in student review", async ({ page, baseURL }) => {
    test.info().annotations.push({ type: "release-proof", description: "teacher_core_results_feedback" });
    await authenticateTeacher(page, baseURL);
    await seedStudentResultHub(page);
    await page.goto("/teacher/exam/result-hub-exam");

    const originalRow = page.getByRole("row").filter({ hasText: "필기 저장됨" });
    await originalRow.getByRole("link", { name: "결과 허브 학생 결과 보기" }).click();
    await expect(page).toHaveURL(/\/teacher\/attempt\/result-hub-original/);
    await page.getByRole("tab", { name: "필기" }).click();

    const feedbackHeading = page.getByRole("heading", { name: "교사 피드백" });
    const feedbackSection = feedbackHeading.locator("../..");
    await feedbackSection.getByLabel("전체 피드백").fill(RESULT_HUB_FEEDBACK);
    await feedbackSection.getByRole("button", { name: "학생에게 반환" }).click();
    await expect(feedbackSection.getByRole("status")).toHaveText("학생에게 피드백을 반환했습니다.");
    await expect(feedbackSection.getByText("반환됨", { exact: true })).toBeVisible();

    await page.evaluate(() => {
        const session = {
            studentId: "result-hub-student",
            loginId: "result-hub-student",
            name: "결과 허브 학생",
            groupId: "result-hub-group",
            groupName: "결과 허브반",
            isGuest: false,
            identityType: "temporary",
            createdAt: new Date().toISOString(),
        };
        window.localStorage.setItem("omr_student_session_backup", JSON.stringify(session));
        window.sessionStorage.setItem("omr_student_session", JSON.stringify(session));
    });
    await page.goto("/student/review/result-hub-original");
    await expect(page.getByText("교사 피드백", { exact: true })).toBeVisible();
    await expect(page.getByText(RESULT_HUB_FEEDBACK, { exact: true })).toBeVisible();
});

test("connects the editorial exam overview to a dense personal growth report", async ({ page }) => {
    const consoleIssues: Array<{ type: string; text: string; url: string }> = [];
    const pageErrors: string[] = [];
    page.on("console", message => {
        if (message.type() !== "warning" && message.type() !== "error") return;
        consoleIssues.push({
            type: message.type(),
            text: message.text(),
            url: message.location().url,
        });
    });
    page.on("pageerror", error => pageErrors.push(error.stack || error.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAsShowcaseTeacher(page);
    await page.goto("/teacher/dashboard?showcase=1&tab=exam");

    const overviewHeadings = page.locator('[role="tabpanel"][aria-label="시험 통계 요약"] > * h2');
    await expect(page.getByRole("region", { name: "시험 핵심 지표" })).toBeVisible();
    await expect(page.getByRole("table", { name: "취약 문항 근거" })).toBeVisible();
    expect(await overviewHeadings.allTextContents()).toEqual([
        "시험 핵심 지표",
        "시험 핵심 해석",
        "점수 분포",
        "성취 구간",
        "취약 문항",
        "다음 행동",
    ]);

    await page.getByRole("complementary", { name: "교사 대시보드 내비게이션" })
        .getByRole("button", { name: "학생 성취도", exact: true }).click();
    await page.getByRole("link", { name: /결과 분석 열기/ }).first().click();
    await expect(page).toHaveURL(/\/teacher\/attempt\/.*\?view=analytics/);
    await page.getByRole("tab", { name: "리포트", exact: true }).click();

    const growth = page.getByRole("region", { name: "개인 성장", exact: true });
    await expect(growth).toBeVisible();
    const growthTop = await growth.evaluate(element => element.getBoundingClientRect().top + window.scrollY);
    expect(growthTop, "dense desktop report should bring growth into the first viewport").toBeLessThan(900);

    const growthTabs = growth.getByRole("tablist", { name: "개인 성장 보기" });
    await expect(growthTabs.getByRole("tab", { name: "요약" })).toHaveAttribute("aria-selected", "true");
    await growthTabs.getByRole("tab", { name: "추세만" }).click();
    await expect(growthTabs.getByRole("tab", { name: "추세만" })).toHaveAttribute("aria-selected", "true");
    await expect(growth.getByRole("region", { name: "개인 성장 그래프 가로 스크롤 영역" })).toBeVisible();
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

test.describe("Teacher dashboard", () => {
    test.beforeEach(async ({ page, baseURL }) => {
        await authenticateTeacher(page, baseURL);
    });

    test("shows focused onboarding when the real workspace is empty", async ({ page }) => {
        await page.request.get("/teacher/dashboard");
        const remoteFixture = await registerCanonicalRemoteFixture(page);
        const actionIds = remoteFixture.activateEmptyTeacherDashboard();
        await page.goto("/teacher/dashboard");
        await expect.poll(() => [...remoteFixture.requestedActionIds]).toEqual(
            expect.arrayContaining(Object.values(actionIds)),
        );
        await expect.poll(() => [...remoteFixture.rewrittenActionIds].sort()).toEqual(
            Object.values(actionIds).sort(),
        );
        await expect(page.getByRole("main", { name: "분석 센터" })).toBeVisible();
        const onboarding = page.getByRole("region", { name: "첫 시험부터 시작해보세요" });
        await expect(onboarding).toBeVisible();
        await expect(onboarding.getByRole("link", { name: "첫 시험 만들기" })).toBeVisible();
        await expect(page.getByText("빠른 작업", { exact: false })).toHaveCount(0);
    });

    test("dashboard live shortcut navigates to /teacher/live", async ({ page }) => {
        await page.goto("/teacher/dashboard");
        await page.getByRole("complementary", { name: "교사 대시보드 내비게이션" })
            .getByRole("link", { name: "실시간 현황" }).click();
        await expect(page).toHaveURL(/\/teacher\/live$/);
        await expect(page.getByRole("heading", { name: "응시 결과 확인" })).toBeVisible();
    });
});

test.describe("Create page label memory", () => {
    test.beforeEach(async ({ page, baseURL }) => {
        await authenticateTeacher(page, baseURL);
    });

    const revealAnswerImportTrigger = async (page: Page) => {
        const trigger = page.getByRole("button", { name: "정답 인식 마법사 열기" });
        if (!await trigger.isVisible()) {
            await page.getByRole("tab", { name: /^설정/ }).click();
        }
        await expect(trigger).toBeVisible();
        return trigger;
    };

    test("keyboard upload buttons activate problem and answer-key PDF inputs", async ({ page }) => {
        await page.goto("/create");
        const fixturePath = path.join(process.cwd(), "e2e/fixtures/sample-problem.pdf");
        const uploadToolbar = page.getByRole("toolbar", { name: "출제 도구 모음" });
        const pdfMenuTrigger = uploadToolbar.getByRole("button", { name: "PDF 관리" });
        const problemInput = page.locator("#pdf-upload-input");
        const answerInput = page.locator("#answer-key-pdf-upload-input");

        for (const input of [problemInput, answerInput]) {
            await input.evaluate(element => {
                element.addEventListener("click", () => {
                    const current = Number(element.getAttribute("data-keyboard-activations") || "0");
                    element.setAttribute("data-keyboard-activations", String(current + 1));
                });
            });
        }

        await pdfMenuTrigger.focus();
        await expect(pdfMenuTrigger).toBeFocused();
        await page.keyboard.press("Enter");
        const pdfMenu = page.getByRole("menu", { name: "PDF 관리" });
        const problemUpload = pdfMenu.getByRole("menuitem", { name: "문제지 PDF 선택" });
        await expect(problemUpload).toBeFocused();
        await problemUpload.press("Enter");
        await expect(problemInput).toHaveAttribute("data-keyboard-activations", "1");
        await problemInput.setInputFiles(fixturePath);
        await expect(page.getByText("문제지 PDF 파일 수신됨", { exact: true })).toBeVisible();

        await pdfMenuTrigger.focus();
        await pdfMenuTrigger.press("Space");
        const answerUpload = pdfMenu.getByRole("menuitem", { name: "답지 PDF 선택" });
        await expect(problemUpload).toBeFocused();
        await page.keyboard.press("ArrowDown");
        await expect(answerUpload).toBeFocused();
        await answerUpload.press("Space");
        await expect(answerInput).toHaveAttribute("data-keyboard-activations", "1");
        await answerInput.setInputFiles(fixturePath);
        await expect(page.getByText("답지 PDF 파일 수신됨", { exact: true })).toBeVisible();
    });

    test("keyboard upload in the answer import modal opens a file chooser and shows the selected PDF", async ({ page }) => {
        await page.goto("/create");
        const fixturePath = path.join(process.cwd(), "e2e/fixtures/sample-problem.pdf");
        await (await revealAnswerImportTrigger(page)).click();

        const dialog = page.getByRole("dialog", { name: "정답 PDF 불러오기" });
        await expect(dialog).toBeVisible();
        const upload = dialog.getByRole("button", { name: "정답 PDF 업로드" });
        await upload.focus();
        await expect(upload).toBeFocused();

        const [chooser] = await Promise.all([
            page.waitForEvent("filechooser"),
            // Keep the interaction keyboard-only while binding it to the
            // asserted control so a dialog re-render cannot move page focus
            // between the focus check and the key dispatch.
            upload.press("Enter"),
        ]);
        await chooser.setFiles(fixturePath);

        await expect(dialog.getByText("sample-problem.pdf", { exact: true })).toBeVisible();
    });

    test("dialog focus wraps and returns to the answer import trigger", async ({ page }) => {
        await page.goto("/create");
        const trigger = await revealAnswerImportTrigger(page);
        await expect(trigger).toBeEnabled();
        await trigger.focus();
        await trigger.press("Enter");

        const dialog = page.getByRole("dialog", { name: "정답 PDF 불러오기" });
        const firstControl = dialog.getByRole("button", { name: "정답 PDF 모달 닫기" });
        const lastEnabledControl = dialog.getByRole("button", { name: "취소" });
        await expect(dialog).toBeVisible();
        await expect(firstControl).toBeFocused();

        const negativeTabStop = dialog.locator('[data-negative-tab-stop="true"]');
        await dialog.evaluate(element => {
            const excludedButton = document.createElement("button");
            excludedButton.textContent = "포커스 제외";
            excludedButton.tabIndex = -1;
            excludedButton.dataset.negativeTabStop = "true";
            element.append(excludedButton);
        });
        await page.keyboard.press("Shift+Tab");
        await expect(lastEnabledControl).toBeFocused();
        await expect(negativeTabStop).not.toBeFocused();
        await page.keyboard.press("Tab");
        await expect(firstControl).toBeFocused();

        await page.keyboard.press("Escape");
        await expect(dialog).not.toBeVisible();
        await expect(trigger).toBeFocused();
    });

    test("dialog focus contains handled keys while ordinary keys still bubble", async ({ page }) => {
        await page.goto("/create");
        await (await revealAnswerImportTrigger(page)).click();

        const dialog = page.getByRole("dialog", { name: "정답 PDF 불러오기" });
        const firstControl = dialog.getByRole("button", { name: "정답 PDF 모달 닫기" });
        await expect(firstControl).toBeFocused();
        await dialog.evaluate(element => {
            const parent = element.parentElement;
            if (!parent) throw new Error("Dialog parent is required");
            parent.addEventListener("keydown", event => {
                const key = event.key === "Tab"
                    ? "tab"
                    : event.key === "Escape"
                        ? "escape"
                        : event.key === "ArrowDown"
                            ? "arrow"
                            : "other";
                const current = Number(document.body.dataset[`${key}Bubbles`] || "0");
                document.body.dataset[`${key}Bubbles`] = String(current + 1);
            });
        });

        await page.keyboard.press("Shift+Tab");
        await expect.poll(() => page.locator("body").getAttribute("data-tab-bubbles")).toBeNull();

        await page.keyboard.press("ArrowDown");
        await expect(page.locator("body")).toHaveAttribute("data-arrow-bubbles", "1");

        await page.keyboard.press("Escape");
        await expect(dialog).not.toBeVisible();
        await expect.poll(() => page.locator("body").getAttribute("data-escape-bubbles")).toBeNull();
    });

    test("dialog focus wraps and returns to the create settings trigger", async ({ page }) => {
        await page.goto("/create");
        if (!await page.getByLabel("빠른 정답 입력").isVisible()) {
            await page.getByRole("tab", { name: /^설정/ }).click();
        }
        await page.getByLabel("빠른 정답 입력").fill("5");

        const trigger = page.getByRole("button", { name: "4지선다", exact: true });
        await trigger.focus();
        await trigger.press("Enter");

        const dialog = page.getByRole("dialog", { name: "4지선다로 변경" });
        const firstControl = dialog.getByRole("button", { name: "유지" });
        const lastControl = dialog.getByRole("button", { name: "변경" });
        await expect(dialog).toBeVisible();
        await expect(firstControl).toBeFocused();

        await page.keyboard.press("Shift+Tab");
        await expect(lastControl).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(firstControl).toBeFocused();

        await page.keyboard.press("Escape");
        await expect(dialog).not.toBeVisible();
        await expect(trigger).toBeFocused();
    });

    test("remembers label presets and lets teachers hide stale candidates", async ({ page }) => {
        await page.goto("/create");

        const labelCard = page.locator(".create-label-batch-card");
        if (!(await labelCard.isVisible().catch(() => false))) {
            await page.getByRole("tab", { name: /^설정/ }).click();
        }
        await expect(labelCard.getByText("문항 라벨 일괄 적용")).toBeVisible();
        await expect(labelCard.getByText(/Demo Admin 최근/)).toBeVisible();

        const hideGrammar = labelCard.getByRole("button", { name: "문법 후보 숨김" });
        await expect(hideGrammar).toBeVisible();
        await hideGrammar.focus();
        await page.keyboard.press("Enter");
        await expect(hideGrammar).not.toBeVisible();

        await labelCard.getByRole("button", { name: "복구" }).click();
        await expect(labelCard.getByRole("button", { name: "문법 후보 숨김" })).toBeVisible();

        await labelCard.getByPlaceholder("유형/라벨 예: 독해, 어법, 빈칸").fill("현대시");
        await labelCard.getByPlaceholder("단원").fill("문학");
        await labelCard.getByPlaceholder("세부 개념").fill("화자의 태도");
        await labelCard.getByRole("button", { name: "범위 적용" }).click();
        await labelCard.getByRole("button", { name: "기억" }).click();

        const storedMemory = await page.evaluate(() => {
            const key = Object.keys(window.localStorage).find(item => item.startsWith("omr_question_label_settings_v1:"));
            return key ? window.localStorage.getItem(key) : "";
        });
        expect(storedMemory).toContain("현대시");
        expect(storedMemory).toContain("문학");
        expect(storedMemory).toContain("화자의 태도");
    });

    test("keeps presets touch sized and clear of the custom input on narrow screens", async ({ page }) => {
        await page.setViewportSize({ width: 320, height: 800 });
        await page.goto("/create");
        await page.getByRole("tab", { name: "설정", exact: true }).click();

        const input = page.getByLabel("문항 수 직접 입력");
        const presetButtons = page.locator(".create-count-buttons .btn");
        await expect(presetButtons).toHaveCount(6);
        for (let index = 0; index < 6; index += 1) {
            const box = await presetButtons.nth(index).boundingBox();
            expect(box?.height).toBeGreaterThanOrEqual(44);
        }
        const lastPresetBox = await presetButtons.nth(5).boundingBox();
        const inputBox = await input.boundingBox();
        expect(lastPresetBox).not.toBeNull();
        expect(inputBox).not.toBeNull();
        expect(lastPresetBox!.x + lastPresetBox!.width).toBeLessThanOrEqual(inputBox!.x);

        await input.fill("45");
        await input.press("Enter");

        await expect(input).toHaveValue("45");
        await expect(page.getByText("새 시험 · 45문항 · 5지선다")).toBeVisible();
    });

    test("keeps settings view options touch sized without crowding the summary row", async ({ page }) => {
        await page.setViewportSize({ width: 320, height: 800 });
        await page.goto("/create");
        await page.getByRole("tab", { name: "설정", exact: true }).click();

        const toolbar = page.locator(".create-settings-toolbar");
        const toolbarBox = await toolbar.boundingBox();
        expect(toolbarBox).not.toBeNull();
        expect(toolbarBox!.height).toBeGreaterThanOrEqual(44);

        const viewOptions = toolbar.locator(".create-settings-view-options");
        const summary = viewOptions.locator("summary");
        const summaryBox = await summary.boundingBox();
        expect(summaryBox?.height).toBeGreaterThanOrEqual(44);
        await summary.click();

        const optionsMenu = viewOptions.locator(".create-settings-view-options-menu");
        const [optionsBox, viewportWidth] = await Promise.all([
            optionsMenu.boundingBox(),
            page.evaluate(() => document.documentElement.clientWidth),
        ]);
        expect(optionsBox).not.toBeNull();
        expect(optionsBox!.x).toBeGreaterThanOrEqual(0);
        expect(optionsBox!.x + optionsBox!.width).toBeLessThanOrEqual(viewportWidth);

        const iconButtons = viewOptions.locator(".create-settings-tool-button");
        await expect(iconButtons).toHaveCount(4);
        for (let index = 0; index < 4; index += 1) {
            const box = await iconButtons.nth(index).boundingBox();
            expect(box?.width).toBeGreaterThanOrEqual(44);
            expect(box?.height).toBeGreaterThanOrEqual(44);
        }

        const toolbarItems = viewOptions.locator(".create-settings-view-options-menu > *");
        await expect(toolbarItems).toHaveCount(3);
        const boxes = await Promise.all(
            Array.from({ length: 3 }, (_, index) => toolbarItems.nth(index).boundingBox()),
        );
        for (let left = 0; left < boxes.length; left += 1) {
            for (let right = left + 1; right < boxes.length; right += 1) {
                const a = boxes[left]!;
                const b = boxes[right]!;
                const overlaps = a.x < b.x + b.width
                    && a.x + a.width > b.x
                    && a.y < b.y + b.height
                    && a.y + a.height > b.y;
                expect(overlaps).toBe(false);
            }
        }

        const labelCard = page.locator(".create-label-batch-card");
        await labelCard.scrollIntoViewIfNeeded();
        const labelActions = labelCard.locator(".create-label-memory-actions button, .create-label-batch-presets button:visible");
        const labelActionCount = await labelActions.count();
        expect(labelActionCount).toBeGreaterThan(0);
        for (let index = 0; index < labelActionCount; index += 1) {
            const box = await labelActions.nth(index).boundingBox();
            expect(box?.width).toBeGreaterThanOrEqual(44);
            expect(box?.height).toBeGreaterThanOrEqual(44);
        }
    });

    test("renders readiness and progress counts as text without pill backgrounds", async ({ page }) => {
        await page.goto("/create");

        const input = page.getByLabel("문항 수 직접 입력");
        if (!await input.isVisible()) {
            await page.getByRole("tab", { name: /^설정/ }).click();
        }
        await input.fill("45");
        await input.press("Enter");
        await expect(input).toHaveValue("45");

        const textOnlyIndicators = [
            page.locator(".create-publish-chip"),
            page.locator(".create-design-check-pill"),
            page.locator("#create-region-calibration-anchor > div > span"),
            page.locator(".create-preview-status"),
        ];

        for (const indicator of textOnlyIndicators) {
            await expect(indicator).toHaveCount(1);
            const styles = await indicator.evaluate(element => {
                const computed = getComputedStyle(element);
                return {
                    backgroundColor: computed.backgroundColor,
                    borderRadius: computed.borderRadius,
                    borderTopWidth: computed.borderTopWidth,
                    paddingLeft: computed.paddingLeft,
                    paddingRight: computed.paddingRight,
                };
            });
            expect(styles).toEqual({
                backgroundColor: "rgba(0, 0, 0, 0)",
                borderRadius: "0px",
                borderTopWidth: "0px",
                paddingLeft: "0px",
                paddingRight: "0px",
            });
        }

        await expect(page.locator(".create-design-check-pill")).toHaveText("0/45 정답");
        await expect(page.locator("#create-region-calibration-anchor > div > span")).toHaveText("0/45");
        await expect(page.locator(".create-preview-status")).toHaveText("0/45 정답 입력");
    });

    test("derives group distribution counts from the matching roster", async ({ page }) => {
        await page.setViewportSize({ width: 320, height: 800 });
        const roster = await seedDistributionCountRegressionRoster(page);
        await page.request.get("/create");
        const remoteFixture = await registerCanonicalRemoteFixture(page);
        remoteFixture.activateCreate(roster);
        await page.goto("/create");

        const title = page.getByLabel("시험 제목");
        if (!await title.isVisible()) {
            await page.getByRole("tab", { name: /^설정/ }).click();
        }
        await title.fill("배포 명단 집계 회귀 시험");
        await page.getByLabel("빠른 정답 입력").fill("1".repeat(20));

        const createActions = page.locator(".create-primary-actions:visible");
        await createActions.getByRole("button", { name: "저장하고 배포하기" }).click();

        const dialog = page.getByRole("dialog", { name: "시험 배포하기" });
        await expect(dialog).toBeVisible();
        const dialogBox = await dialog.boundingBox();
        expect(dialogBox).not.toBeNull();
        expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
        expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(320);
        expect(dialogBox!.y).toBeGreaterThanOrEqual(0);
        expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(800);
        await expect(dialog.locator(".distribute-dialog-body")).toHaveCSS("overflow-y", "auto");
        await expect(dialog.locator(".distribute-access-options")).toHaveCSS("flex-direction", "column");
        await dialog.getByRole("radio", { name: "특정 그룹만" }).check();

        const groupCheckbox = dialog.getByRole("checkbox", { name: /배포 집계 검증반 · 서울/ });
        await expect(groupCheckbox).toHaveCount(1);
        expect(await groupCheckbox.evaluate(element => element.closest("label")?.textContent || "")).toContain("2명");
        await groupCheckbox.check();
        await expect(dialog.getByLabel("그룹 배포 대상 요약")).toContainText("명단 기준 대상 2명");
        const createLinkButton = dialog.getByRole("button", { name: "링크 생성하기" });
        await createLinkButton.scrollIntoViewIfNeeded();
        await expect(createLinkButton).toBeInViewport();
        const [ctaBox, settledDialogBox] = await Promise.all([createLinkButton.boundingBox(), dialog.boundingBox()]);
        expect(ctaBox).not.toBeNull();
        expect(settledDialogBox).not.toBeNull();
        expect(ctaBox!.y).toBeGreaterThanOrEqual(settledDialogBox!.y);
        expect(ctaBox!.y + ctaBox!.height).toBeLessThanOrEqual(settledDialogBox!.y + settledDialogBox!.height);
        // The regression only exercises the rendered target calculation; it
        // deliberately leaves link creation and persistence untouched.
    });
});

test.describe("Live Results page", () => {
    test.beforeEach(async ({ page, baseURL }) => {
        await authenticateTeacher(page, baseURL, MOCKUP_TEACHER_IDENTITY);
    });

    test("renders concrete live values, student grid, heatmap, and a countdown while controlling refresh", async ({ page }) => {
        test.info().annotations.push({ type: "release-proof", description: "teacher_core_live_monitor" });
        const clockStart = new Date();
        await page.clock.install({ time: clockStart });
        await page.clock.pauseAt(new Date(clockStart.getTime() + 1_000));
        await page.goto("/teacher/live");

        const countdown = page.getByText("REMAINING TIME").locator("..").locator(".numeric-emphasis");
        await expect(countdown).toHaveText("60:00");
        for (const [label, value] of [
            ["제출 완료", "4"],
            ["응시 중", "4"],
            ["미응시", "0"],
            ["제출 평균", "86점"],
        ] as const) {
            const statLabel = page.getByText(label, { exact: true }).first();
            await expect(statLabel).toBeVisible();
            await expect(statLabel.locator("xpath=following-sibling::div[1]")).toHaveText(value);
        }
        const studentGrid = page.getByRole("heading", { name: "학생별 제출 현황" })
            .locator("xpath=ancestor::div[contains(@class, 'bento-card')]");
        await expect(studentGrid).toBeVisible();
        await expect(studentGrid.locator(".card-hover")).toHaveCount(8);
        await expect(studentGrid.getByText("민준", { exact: true })).toBeVisible();

        const heatmap = page.getByRole("heading", { name: "문항별 정답률" })
            .locator("xpath=ancestor::div[contains(@class, 'bento-card')]");
        await expect(heatmap).toBeVisible();
        await expect(heatmap.locator('[title^="Q"]')).toHaveCount(35);
        await expect(heatmap.locator('[title^="Q1:"]')).toBeVisible();
        const pauseButton = page.getByRole("button", { name: "화면 갱신 일시정지" });
        await expect(pauseButton).toHaveAttribute("aria-pressed", "false");
        await pauseButton.click();
        const resumeButton = page.getByRole("button", { name: "화면 갱신 재개" });
        await expect(resumeButton).toHaveAttribute("aria-pressed", "true");
        await page.clock.runFor(1_000);
        await expect(countdown).toHaveText("59:59");
        await resumeButton.click();
        await expect(page.getByRole("button", { name: "화면 갱신 일시정지" })).toHaveAttribute("aria-pressed", "false");
    });

    test("screen refresh pause is explicitly scoped and exposes its pressed state", async ({ page }) => {
        await page.goto("/teacher/live");
        const pauseBtn = page.getByRole("button", { name: "화면 갱신 일시정지" });
        await expect(pauseBtn).toBeVisible();
        await expect(pauseBtn).toHaveAttribute("aria-pressed", "false");
        await expect(pauseBtn).toHaveAttribute("aria-describedby", "live-refresh-control-help");
        await expect(page.locator("#live-refresh-control-help")).toHaveText("교사 화면의 자동 갱신만 멈춥니다. 학생 응시와 시험 시간은 계속됩니다.");
        await pauseBtn.click();
        await expect(page.getByRole("button", { name: "화면 갱신 재개" })).toHaveAttribute("aria-pressed", "true");
    });

    test("away severity stays factual and escalates from neutral to attention", async ({ page, baseURL }) => {
        test.info().annotations.push({ type: "release-proof", description: "ux_accessibility_responsiveness_contrast" });
        await authenticateTeacher(page, baseURL, TEACHER_IDENTITY);
        await seedAwaySeverityAttempts(page);
        await page.goto("/teacher/live");
        await expect.poll(() => page.evaluate(() => (
            JSON.parse(window.localStorage.getItem("omr_exam_away-severity-exam") || "null")?.title
        ))).toBe("화면 이탈 표시 시험");
        await expect.poll(() => page.evaluate(() => (
            JSON.parse(window.localStorage.getItem("omr_attempts") || "[]").length
        ))).toBe(3);

        const liveAway = page.locator("[data-away-severity]");
        await expect(liveAway).toHaveCount(3);
        for (const count of [1, 2]) {
            await expect(liveAway.filter({ hasText: `화면 이탈 ${count}회` })).toHaveAttribute(
                "data-away-severity",
                "neutral",
            );
        }
        await expect(liveAway.filter({ hasText: "화면 이탈 3회" })).toHaveAttribute(
            "data-away-severity",
            "attention",
        );
        const liveTones = await liveAway.evaluateAll(elements => elements.map(element => {
            const styles = getComputedStyle(element);
            return {
                severity: element.getAttribute("data-away-severity"),
                backgroundColor: styles.backgroundColor,
                color: styles.color,
            };
        }));
        expect(liveTones.filter(tone => tone.severity === "neutral")).toEqual([
            {
                severity: "neutral",
                backgroundColor: "rgb(241, 245, 249)",
                color: "rgb(71, 85, 105)",
            },
            {
                severity: "neutral",
                backgroundColor: "rgb(241, 245, 249)",
                color: "rgb(71, 85, 105)",
            },
        ]);
        expect(liveTones.filter(tone => tone.severity === "attention")).toEqual([{
            severity: "attention",
            backgroundColor: "rgb(254, 243, 199)",
            color: "rgb(146, 64, 14)",
        }]);

        for (const count of [1, 2, 3]) {
            await page.goto(`/teacher/attempt/away-severity-${count}`);
            const detailAway = page.getByText(`화면 이탈 ${count}회`, { exact: true });
            await expect(detailAway).toHaveAttribute(
                "data-away-severity",
                count >= 3 ? "attention" : "neutral",
            );
            await expect(page.getByText(/부정행위|cheating/i)).toHaveCount(0);
        }

        await page.goto("/teacher/exam/away-severity-exam");
        const examDetailAway = page.locator("[data-away-severity]:visible");
        await expect(examDetailAway).toHaveCount(3);
        for (const count of [1, 2]) {
            await expect(examDetailAway.filter({ hasText: `화면 이탈 ${count}회` })).toHaveAttribute(
                "data-away-severity",
                "neutral",
            );
        }
        await expect(examDetailAway.filter({ hasText: "화면 이탈 3회" })).toHaveAttribute(
            "data-away-severity",
            "attention",
        );

        for (const count of [1, 2, 3]) {
            await page.evaluate(value => {
                window.localStorage.setItem("omr_away_severity_student_count", String(value));
            }, count);
            await page.goto(`/student/review/away-severity-${count}`);
            const studentAway = page.getByText(`시험 중 화면을 벗어난 기록 ${count}회`, { exact: true });
            await expect(studentAway).toHaveAttribute(
                "data-away-severity",
                count >= 3 ? "attention" : "neutral",
            );
            await expect(page.getByText(/부정행위|cheating/i)).toHaveCount(0);
        }
    });
});

test.describe("Manage Users page", () => {
    test("renders tabs and student table with mock data", async ({ page, baseURL }) => {
        await authenticateTeacher(page, baseURL, MOCKUP_TEACHER_IDENTITY);
        await page.goto("/teacher/users");
        await expect(page.getByRole("heading", { name: "사용자 관리" })).toBeVisible();
        // Wait for hydration (table rows seed from localStorage on mount)
        const rows = page.locator("tbody tr");
        await expect.poll(() => rows.count(), { timeout: 5000 }).toBeGreaterThan(0);
    });

    test("bulk selection banner appears after checking boxes", async ({ page, baseURL }) => {
        await authenticateTeacher(page, baseURL);
        const roster = await seedStoredRoster(page);
        await page.request.get("/teacher/users");
        const remoteFixture = await registerCanonicalRemoteFixture(page);
        const { loadRoster } = remoteFixture.activateRoster(roster);
        await page.goto("/teacher/users");
        await expect.poll(() => [...remoteFixture.requestedActionIds]).toContain(loadRoster);
        await expect.poll(() => [...remoteFixture.rewrittenActionIds]).toContain(loadRoster);
        const firstBox = page.locator('tbody input[type="checkbox"]').first();
        await firstBox.check();
        await expect(page.getByText(/\d+명 선택됨/)).toBeVisible();
    });

    test("Escape closes the mobile student action menu and restores its trigger focus", async ({ page, baseURL }) => {
        await page.setViewportSize({ width: 320, height: 568 });
        await authenticateTeacher(page, baseURL);
        const roster = await seedStoredRoster(page);
        await page.request.get("/teacher/users");
        const remoteFixture = await registerCanonicalRemoteFixture(page);
        remoteFixture.activateRoster(roster);
        await page.goto("/teacher/users");

        const trigger = page.locator(
            '.teacher-users-mobile-menu-trigger[aria-label="김학생 작업 메뉴 열기"]',
        );
        await expect(trigger).toBeVisible();
        await trigger.click();

        const menu = page.getByRole("menu", { name: "김학생 작업" });
        const editMenuItem = menu.getByRole("menuitem", { name: "편집" });
        await expect(menu).toBeVisible();
        await editMenuItem.focus();
        await expect(editMenuItem).toBeFocused();

        await page.keyboard.press("Escape");

        await expect(menu).not.toBeVisible();
        await expect(trigger).toBeFocused();
    });

    test("demo roster keeps bulk selection locked", async ({ page, baseURL }) => {
        await authenticateTeacher(page, baseURL, MOCKUP_TEACHER_IDENTITY);
        await page.goto("/teacher/users");
        const firstBox = page.locator('tbody input[type="checkbox"]').first();
        await expect(firstBox).toBeDisabled();
    });

    test("switching to groups tab shows group cards", async ({ page, baseURL }) => {
        await authenticateTeacher(page, baseURL);
        await page.request.get("/teacher/users");
        const remoteFixture = await registerCanonicalRemoteFixture(page);
        const { loadRoster } = remoteFixture.activateRoster({ students: [], groups: [], invites: [] });
        await page.goto("/teacher/users");
        await expect.poll(() => remoteFixture.rewrittenActionIds.has(loadRoster)).toBe(true);
        await settleHydratedPage(page);
        const groupTab = page.getByRole("button", { name: /반 · 그룹/ });
        await groupTab.click();
        await expect(page).toHaveURL(/tab=groups/);
        await expect(groupTab).toHaveAttribute("aria-pressed", "true");
        await expect(page.getByRole("button", { name: "새 반 만들기" }).first()).toBeVisible();
    });

    test("teacher can create, edit, and delete an empty group", async ({ page, baseURL }) => {
        await authenticateTeacher(page, baseURL);
        await page.request.get("/teacher/users?tab=groups");
        const remoteFixture = await registerCanonicalRemoteFixture(page);
        const { loadRoster, saveRoster } = remoteFixture.activateRoster({ students: [], groups: [], invites: [] });
        await page.goto("/teacher/users?tab=groups");
        await expect.poll(() => remoteFixture.rewrittenActionIds.has(loadRoster)).toBe(true);
        await settleHydratedPage(page);
        await expect(page.getByRole("button", { name: /반 · 그룹/ })).toHaveAttribute("aria-pressed", "true");

        await page.getByRole("button", { name: "새 반 만들기" }).first().click();
        const createDialog = page.getByRole("dialog", { name: "새 반 만들기" });
        await expect(createDialog).toBeVisible();
        await page.getByLabel("반 이름").fill("E2E 신규반");
        await page.getByLabel("반 지역").fill("온라인");
        await createDialog.getByRole("button", { name: "만들기", exact: true }).click();
        await expect.poll(() => remoteFixture.rewrittenActionCounts.get(saveRoster) || 0).toBe(1);
        await expect.poll(() => page.evaluate(() => localStorage.getItem("omr_roster_revision"))).toBe("2");

        await expect(page.getByRole("heading", { name: "E2E 신규반" })).toBeVisible();
        await expect(page.getByText("0명 등록 · 온라인")).toBeVisible();

        await page.getByRole("button", { name: "E2E 신규반 편집" }).click();
        const editDialog = page.getByRole("dialog", { name: "반 편집" });
        await expect(editDialog).toBeVisible();
        await page.getByLabel("반 이름").fill("E2E 편집반");
        await page.getByLabel("반 지역").fill("서울");
        await editDialog.getByRole("button", { name: "저장", exact: true }).click();
        await expect.poll(() => remoteFixture.rewrittenActionCounts.get(saveRoster) || 0).toBe(2);
        await expect.poll(() => page.evaluate(() => localStorage.getItem("omr_roster_revision"))).toBe("3");

        await expect(page.getByRole("heading", { name: "E2E 편집반" })).toBeVisible();
        await expect(page.getByText("0명 등록 · 서울")).toBeVisible();

        await page.getByRole("button", { name: "E2E 편집반 삭제" }).click();
        const deleteDialog = page.getByRole("dialog", { name: "반 삭제" });
        await expect(deleteDialog).toBeVisible();
        await deleteDialog.getByRole("button", { name: "반 삭제" }).click();
        await expect.poll(() => remoteFixture.rewrittenActionCounts.get(saveRoster) || 0).toBe(3);
        await expect.poll(() => page.evaluate(() => localStorage.getItem("omr_roster_revision"))).toBe("4");
        await expect(page.getByRole("heading", { name: "E2E 편집반" })).not.toBeVisible();
    });

    test("student credential issuance is one-time and fails closed without a database", async ({ page, baseURL }) => {
        await authenticateTeacher(page, baseURL);
        const roster = await seedStoredRoster(page);
        await page.request.get("/teacher/users");
        const remoteFixture = await registerCanonicalRemoteFixture(page);
        remoteFixture.activateRoster(roster);
        await page.goto("/teacher/users");

        const studentRow = page.locator('tbody tr:has-text("kim.student@example.com")');
        await expect(studentRow).toHaveCount(1);
        await studentRow.click();
        await expect(page.getByText("학생 상세")).toBeVisible();
        await expect(page.getByText("학생 계정 안내")).toBeVisible();
        await expect(page.getByTestId("student-login-id-value")).toHaveText("e2e-class-a::김학생");
        await expect(page.getByTestId("student-login-email-value")).toHaveText("kim.student@example.com");
        await expect(page.getByText("미발급", { exact: true })).toBeVisible();
        const studentGridColumnCount = await page.locator(".teacher-users-students-grid.has-detail").evaluate(element =>
            window.getComputedStyle(element).gridTemplateColumns.split(/\s+/).filter(Boolean).length
        );
        if ((page.viewportSize()?.width || 0) <= 1024) {
            expect(studentGridColumnCount).toBe(1);
        } else {
            expect(studentGridColumnCount).toBeGreaterThan(1);
        }
        const tableScrollMetrics = await page.locator(".teacher-users-table-scroll").evaluate(element => ({
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
        }));
        expect(tableScrollMetrics.scrollWidth).toBeGreaterThanOrEqual(tableScrollMetrics.clientWidth);
        const hasAccountGuideBodyOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
        expect(hasAccountGuideBodyOverflow).toBe(false);
        await page.getByTestId("open-student-credential-batch").click();
        const dialog = page.getByRole("dialog", { name: "학생 시작 코드 일괄 발급" });
        await expect(dialog).toContainText("기존 로그인 세션도 즉시 종료됩니다");
        await dialog.getByRole("button", { name: "1명 발급" }).click();
        // The first invocation may compile the Server Action in the serial dev
        // server. Keep the assertion exact while allowing that cold path to
        // settle under the full Chromium qualification load.
        await expect(dialog).toContainText("발급을 시작하지 못했습니다", { timeout: 15_000 });
        expect(await page.evaluate(() => window.localStorage.getItem("omr_student_codes"))).toBeNull();
        await expect(page.getByTestId("student-login-guide-panel")).not.toContainText(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
    });
});

test.describe("Settings page", () => {
    test.beforeEach(async ({ page, baseURL }) => {
        await authenticateTeacher(page, baseURL);
    });

    test("sidebar + profile section renders", async ({ page }) => {
        await page.goto("/teacher/settings");
        await expect(page.getByRole("heading", { name: "설정" })).toBeVisible();
        for (const label of ["알림", "시험 기본값", "채점", "테마"]) {
            await expect(page.getByRole("button", { name: label, exact: true })).toBeVisible();
        }
        await page.getByText("고급 · 운영", { exact: true }).click();
        for (const label of ["프로필", "API 키", "데이터 · DB", "보안"]) {
            await expect(page.getByRole("button", { name: label, exact: true })).toBeVisible();
        }
        await page.getByRole("button", { name: "프로필", exact: true }).click();
        await expect(page.getByText("프로필 상태")).toBeVisible();
        await page.getByText("계정은 서버에서 안전하게 관리 중", { exact: true }).click();
        await expect(page.getByText("로그인 계정과 권한")).toBeVisible();
    });

    test("switching section updates panel", async ({ page }) => {
        await page.goto("/teacher/settings");
        await page.getByRole("button", { name: "알림", exact: true }).click();
        await expect(page.getByText("카카오 후보 계산과 실제 발송 연동 상태를 구분해 보여줍니다.")).toBeVisible();
        await expect(page.getByText("카카오 실제 발송")).toBeVisible();
    });

    test("security tab shows deployment login diagnostics", async ({ page }) => {
        await page.goto("/teacher/settings");
        await page.getByText("고급 · 운영", { exact: true }).click();
        await page.getByRole("button", { name: "보안", exact: true }).click();
        await expect(page.getByText("배포 로그인 진단")).toBeVisible();
        await expect(page.getByText("교사 계정 수명주기")).toBeVisible();
        await expect(page.getByText("브라우저 데이터 경계")).toBeVisible();
        await expect(page.getByText("Supabase 서버 게이트웨이")).toBeVisible();
        await expect(page.getByRole("button", { name: "배포 로그인 진단 새로고침" })).toBeVisible();
    });

    test("backup card shows export/import/reset buttons", async ({ page }) => {
        await page.goto("/teacher/settings");
        await page.locator("details.settings-backup-disclosure > summary").click();
        await expect(page.getByRole("button", { name: /내보내기/ })).toBeVisible();
        await expect(page.getByRole("button", { name: /가져오기/ })).toBeVisible();
        await expect(page.getByRole("button", { name: /전체 초기화/ })).toBeVisible();
    });
});

test.describe("Billing page", () => {
    test.beforeEach(async ({ page, baseURL }) => {
        await authenticateTeacher(page, baseURL, BILLING_TEACHER_IDENTITY);
    });

    test("shows current plan hero + usage + plan grid without inventing invoice history", async ({ page }) => {
        await page.goto("/teacher/billing");
        await expect(page.getByRole("heading", { name: "결제 및 플랜" })).toBeVisible();
        await page.locator("details.billing-operations-details > summary").click();
        await expect(page.getByText("개발 플랜 시뮬레이션", { exact: true })).toBeVisible();
        await expect(page.getByText("개발 미리보기", { exact: true })).toBeVisible();
        await expect(page.getByText("실결제 연동 전", { exact: true })).toBeVisible();
        await expect(
            page.locator(".billing-current-plan-card").getByRole("heading", { name: "Free", exact: true }),
        ).toBeVisible();
        await expect(page.getByRole("heading", { name: "이달 사용량" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "플랜 비교" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "로컬 플랜 변경 기록" })).toHaveCount(0);
    });

    test("monthly/yearly toggle changes prices", async ({ page }) => {
        await page.goto("/teacher/billing");
        const yearly = page.getByRole("button", { name: /연간/ });
        await yearly.click();
        // Pro plan yearly = 19000 * 12 * 0.8 = 182400
        await expect(page.getByText("₩182,400")).toBeVisible();
    });
});

test.describe("Global Search", () => {
    test.beforeEach(async ({ page, baseURL }) => {
        await authenticateTeacher(page, baseURL);
    });

    // Search lives inside TeacherHeader, which is rendered on the 4 subpages
    // (live/users/settings/billing) — not on /teacher/dashboard.
    // Wait for the header search trigger to appear as a proxy for TeacherHeader
    // (and therefore GlobalSearch) being fully hydrated before pressing Cmd+K.
    test("Cmd+K opens modal and Escape closes", async ({ page }) => {
        await page.goto("/teacher/live");
        const searchButton = page.getByRole("button", { name: "빠른 검색" });
        await searchButton.click();
        await expect(page.getByPlaceholder(/빠른 검색/)).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.getByPlaceholder(/빠른 검색/)).not.toBeVisible();

        await page.keyboard.press("Meta+K");
        await expect(page.getByPlaceholder(/빠른 검색/)).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.getByPlaceholder(/빠른 검색/)).not.toBeVisible();
    });

    test("typing filters results and Enter navigates", async ({ page }) => {
        await page.goto("/teacher/live");
        await page.getByRole("button", { name: "빠른 검색" }).click();
        await page.getByPlaceholder(/빠른 검색/).fill("결제");
        await expect(page.getByText("결제 및 플랜").first()).toBeVisible();
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(/\/teacher\/billing/);
    });
});
