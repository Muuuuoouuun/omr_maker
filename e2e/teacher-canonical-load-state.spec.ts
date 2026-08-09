import { expect, test } from "@playwright/test";
import { exactNextActionId, loginAsTeacher, resetBrowserState } from "./helpers";

test("teacher dashboard keeps a scoped degraded snapshot strictly read only", async ({ page, context }) => {
    test.setTimeout(45_000);
    let failCanonicalActions = false;
    let injectedFailureCount = 0;
    let learnCanonicalReadActions = true;
    let observeMutationOrDetailActionRequests = false;
    let canonicalRefreshInProgress = false;
    let mutationOrDetailActionRequestCount = 0;
    const canonicalReadActionIds = new Set<string>();
    await page.route("**/*", async route => {
        const request = route.request();
        const actionId = request.headers()["next-action"];
        if (request.method() === "POST" && actionId) {
            if (learnCanonicalReadActions) canonicalReadActionIds.add(actionId);
            const isExpectedCanonicalRefresh = canonicalRefreshInProgress && canonicalReadActionIds.has(actionId);
            if (observeMutationOrDetailActionRequests && !isExpectedCanonicalRefresh) {
                mutationOrDetailActionRequestCount += 1;
            }
        }
        if (failCanonicalActions && request.method() === "POST" && actionId) {
            const response = await route.fetch();
            const body = await response.text();
            const failedBody = body.replaceAll('"local_only"', '"service_unavailable"');
            if (failedBody !== body || body.includes('"service_unavailable"')) injectedFailureCount += 1;
            await route.fulfill({ response, body: failedBody });
            return;
        }
        await route.continue();
    });

    await resetBrowserState(page, context);
    await loginAsTeacher(page, "/teacher/dashboard");
    await expect(page.getByRole("heading", { name: "분석 센터" })).toBeVisible();
    failCanonicalActions = true;

    await page.evaluate(() => {
        const rawSession = window.sessionStorage.getItem("omr_teacher_session");
        if (!rawSession) throw new Error("teacher session missing");
        const session = JSON.parse(rawSession) as Record<string, unknown>;
        session.teacherId = "admin";
        session.organizationId = "default";
        session.accountSessionGeneration = 1;
        session.sessionAuthority = "legacy_account";
        window.sessionStorage.setItem("omr_teacher_session", JSON.stringify(session));
        for (const key of Object.keys(window.localStorage)) {
            if (key.startsWith("omr:canonical-surface-cache:v1:teacher_dashboard:")) {
                window.localStorage.removeItem(key);
            }
        }
        window.localStorage.removeItem("omr_attempts");
        for (const key of Object.keys(window.localStorage)) {
            if (key.startsWith("omr_exam_")) window.localStorage.removeItem(key);
        }
        const now = new Date().toISOString();
        window.localStorage.setItem("omr_exam_unverified-local", JSON.stringify({
            id: "unverified-local",
            title: "검증되지 않은 로컬 시험",
            createdAt: now,
            questions: [],
            accessConfig: { type: "public" },
        }));
        window.dispatchEvent(new Event("omr:teacher-session-identity-changed"));
    });

    const dashboardError = page.getByTestId("canonical-error-no-cache");
    await expect(dashboardError).toBeVisible();
    await expect(dashboardError).toContainText("서버 데이터를 불러오지 못했습니다");
    await expect(page.getByText("첫 시험 만들기", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "시험 출제하기" })).toHaveCount(0);
    await expect(page.getByText("검증되지 않은 로컬 시험", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("분석 데이터 상태")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /문항 결과 자동 복구/ })).toHaveCount(0);

    await page.evaluate(() => {
        const rawSession = window.sessionStorage.getItem("omr_teacher_session");
        if (!rawSession) throw new Error("teacher session missing");
        const session = JSON.parse(rawSession) as {
            organizationId?: string;
            teacherId?: string;
            accountSessionGeneration?: number;
        };
        if (!session.organizationId || !session.teacherId || !Number.isSafeInteger(session.accountSessionGeneration)) {
            throw new Error("canonical teacher identity missing");
        }
        const now = new Date().toISOString();
        const key = [
            "omr:canonical-surface-cache:v1:teacher_dashboard",
            encodeURIComponent(session.organizationId),
            encodeURIComponent(session.teacherId),
            String(session.accountSessionGeneration),
        ].join(":");
        window.localStorage.setItem(key, JSON.stringify({
            schemaVersion: 1,
            surface: "teacher_dashboard",
            organizationId: session.organizationId,
            accountId: session.teacherId,
            sessionGeneration: session.accountSessionGeneration,
            staleAt: now,
            data: {
                exams: [{
                    id: "cached-dashboard",
                    title: "저장된 운영 시험",
                    status: "active",
                    createdAt: now,
                    updatedAt: now,
                    questionCount: 0,
                    attemptCount: 0,
                }],
                attempts: [],
            },
        }));
    });
    failCanonicalActions = true;
    learnCanonicalReadActions = false;
    observeMutationOrDetailActionRequests = true;
    canonicalRefreshInProgress = true;
    await dashboardError.getByTestId("canonical-dashboard-retry").click();
    const dashboardDegraded = page.getByTestId("canonical-degraded-cache");
    await expect(dashboardDegraded).toContainText("읽기 전용");
    await expect(dashboardDegraded).toContainText("마지막 저장");
    await expect(dashboardDegraded.getByRole("button", { name: "다시 시도" })).toBeVisible();
    canonicalRefreshInProgress = false;
    await expect(page.getByText("저장된 운영 시험", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "저장된 시험 식별 정보" })).toBeVisible();
    await expect(page.getByText("첫 시험 만들기", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "시험 출제하기" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "시험 분석" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "학생 성취도" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /분석 보기/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /통계 CSV|CSV 다시 시도/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /시험 작업 메뉴/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /문항 결과 자동 복구/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /시험 제작|시험 상세 보기/ })).toHaveCount(0);
    await page.waitForTimeout(350);
    observeMutationOrDetailActionRequests = false;
    expect(mutationOrDetailActionRequestCount).toBe(0);
    expect(injectedFailureCount).toBeGreaterThan(0);
});

test("teacher roster and distribution preserve failure, recovery, and degraded capabilities", async ({ page, context }) => {
    test.setTimeout(45_000);
    let failCanonicalActions = false;
    let delayCanonicalActions = false;
    let recoverRosterAction = false;
    const rosterAction = { id: undefined as string | undefined };
    const rewrittenRosterActionIds = new Set<string>();
    const restrictedRosterActionIds = new Set<string>();
    const capabilityReadActionIds = new Set<string>();
    let observeRestrictedRosterActions = false;
    let restrictedRosterActionRequestCount = 0;
    let capabilityReadActionRequestCount = 0;
    let injectedFailureCount = 0;
    await page.route("**/*", async route => {
        const request = route.request();
        const nextActionId = request.method() === "POST" ? request.headers()["next-action"] : undefined;
        if (observeRestrictedRosterActions && nextActionId && restrictedRosterActionIds.has(nextActionId)) {
            restrictedRosterActionRequestCount += 1;
        }
        if (observeRestrictedRosterActions && nextActionId && capabilityReadActionIds.has(nextActionId)) {
            capabilityReadActionRequestCount += 1;
        }
        if (delayCanonicalActions && request.method() === "POST" && request.headers()["next-action"]) {
            await new Promise(resolve => setTimeout(resolve, 2_000));
        }
        if (failCanonicalActions && request.method() === "POST" && request.headers()["next-action"]) {
            const response = await route.fetch();
            const body = await response.text();
            const failedBody = body.replaceAll('"local_only"', '"service_unavailable"');
            if (failedBody !== body || body.includes('"service_unavailable"')) injectedFailureCount += 1;
            await route.fulfill({ response, body: failedBody });
            return;
        }
        if (recoverRosterAction
            && request.method() === "POST"
            && request.headers()["next-action"] === rosterAction.id) {
            rewrittenRosterActionIds.add(request.headers()["next-action"]);
            const response = await route.fetch();
            const body = await response.text();
            const loadedAt = new Date().toISOString();
            const loadedFields = `"status":"loaded","snapshot":${JSON.stringify({
                students: [{
                    id: "cached-student",
                    name: "저장된 학생",
                    email: "cached@example.com",
                    group: "저장반",
                    avatar: "#4f46e5",
                    avgScore: 80,
                    examsTaken: 1,
                    lastActive: "방금 전",
                    trend: "flat",
                    status: "active",
                }],
                groups: [{
                    id: "cached-group",
                    name: "저장반",
                    count: 1,
                    avgScore: 80,
                    color: "#4f46e5",
                }],
                invites: [],
            })},"revision":1,"meta":${JSON.stringify({
                organizationId: "default",
                loadedAt,
                rawCount: 2,
                parsedCount: 2,
            })}`;
            await route.fulfill({
                response,
                body: body.replaceAll('{"status":"local_only"}', `{${loadedFields}}`),
            });
            return;
        }
        await route.continue();
    });

    await resetBrowserState(page, context);
    await loginAsTeacher(page, "/teacher/dashboard");
    await page.evaluate(() => {
        for (const key of Object.keys(window.localStorage)) {
            if (key.startsWith("omr:canonical-surface-cache:v1:teacher_roster:")) {
                window.localStorage.removeItem(key);
            }
        }
        window.localStorage.removeItem("omr_students");
        window.localStorage.removeItem("omr_groups");
        window.localStorage.removeItem("omr_invites");
    });
    failCanonicalActions = true;
    await page.goto("/teacher/users");

    const rosterError = page.getByTestId("canonical-error-no-cache");
    await expect(rosterError).toBeVisible();
    await expect(page.getByRole("button", { name: /학생 추가/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "CSV 업로드" })).toHaveCount(0);

    await page.evaluate(() => {
        const rawSession = window.sessionStorage.getItem("omr_teacher_session");
        if (!rawSession) throw new Error("teacher session missing");
        const session = JSON.parse(rawSession) as {
            organizationId?: string;
            teacherId?: string;
            accountSessionGeneration?: number;
            sessionAuthority?: string;
        };
        session.teacherId = "admin";
        session.organizationId = "default";
        session.accountSessionGeneration = 1;
        session.sessionAuthority = "legacy_account";
        window.sessionStorage.setItem("omr_teacher_session", JSON.stringify(session));
        const now = new Date().toISOString();
        const key = [
            "omr:canonical-surface-cache:v1:teacher_roster",
            encodeURIComponent(session.organizationId),
            encodeURIComponent(session.teacherId),
            String(session.accountSessionGeneration),
        ].join(":");
        window.localStorage.setItem(key, JSON.stringify({
            schemaVersion: 1,
            surface: "teacher_roster",
            organizationId: session.organizationId,
            accountId: session.teacherId,
            sessionGeneration: session.accountSessionGeneration,
            staleAt: now,
            data: {
                students: [{
                    id: "cached-student",
                    name: "저장된 학생",
                    email: "cached@example.com",
                    groupId: "cached-group",
                    status: "active",
                    avgScore: 80,
                    examsTaken: 1,
                    lastActive: "방금 전",
                }],
                groups: [{
                    id: "cached-group",
                    name: "저장반",
                    status: "active",
                    studentCount: 1,
                    avgScore: 80,
                }],
                invites: [],
            },
        }));
    });
    const usersWorker = "app/teacher/users/page";
    rosterAction.id = exactNextActionId("src/app/actions/teacherRoster.ts", "loadTeacherCanonicalRoster", usersWorker);
    [
        exactNextActionId("src/app/actions/teacherRoster.ts", "saveTeacherCanonicalRoster", usersWorker),
        exactNextActionId("src/app/actions/studentAuth.ts", "issueStudentCredentialBatch", usersWorker),
        exactNextActionId("src/app/actions/teacherAttempts.ts", "listTeacherCanonicalAttemptSummaries", usersWorker),
        exactNextActionId("src/app/actions/teacherAttempts.ts", "listTeacherCanonicalAttempts", usersWorker),
        exactNextActionId("src/app/actions/teacherExam.ts", "listTeacherCanonicalExams", usersWorker),
    ].forEach(id => restrictedRosterActionIds.add(id));
    failCanonicalActions = true;
    restrictedRosterActionRequestCount = 0;
    observeRestrictedRosterActions = true;
    await rosterError.getByTestId("canonical-roster-retry").click();
    const rosterDegraded = page.getByTestId("canonical-degraded-cache");
    await expect(rosterDegraded).toContainText("읽기 전용");
    await expect(page.getByText("저장된 학생", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /학생 추가/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "CSV 업로드" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /작업 메뉴 열기/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /CSV 내보내기/ })).toBeDisabled();
    expect(rosterAction.id).toBeTruthy();
    await page.waitForTimeout(250);
    observeRestrictedRosterActions = false;
    expect(restrictedRosterActionRequestCount).toBe(0);

    failCanonicalActions = false;
    recoverRosterAction = true;
    await rosterDegraded.getByRole("button", { name: "다시 시도" }).click();
    await expect(rosterDegraded).toBeHidden();
    await expect(page.getByText("저장된 학생", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /학생 추가/ }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "CSV 업로드" })).toBeVisible();
    recoverRosterAction = false;
    expect([...rewrittenRosterActionIds]).toEqual([rosterAction.id]);

    await page.goto("/create");
    const createWorker = "app/create/page";
    [
        exactNextActionId("src/app/actions/teacherAssignment.ts", "saveTeacherIndividualAssignment", createWorker),
        exactNextActionId("src/app/actions/teacherAssignment.ts", "clearTeacherIndividualAssignment", createWorker),
        exactNextActionId("src/app/actions/teacherExam.ts", "rotateTeacherExamEntryInvite", createWorker),
        exactNextActionId("src/app/actions/teacherExam.ts", "revokeTeacherExamEntryInvite", createWorker),
    ].forEach(id => restrictedRosterActionIds.add(id));
    [
        exactNextActionId("src/app/actions/teacherAssignment.ts", "loadTeacherIndividualAssignment", createWorker),
        exactNextActionId("src/app/actions/teacherExam.ts", "getTeacherExamEntryInviteMetadata", createWorker),
    ].forEach(id => capabilityReadActionIds.add(id));
    const title = page.getByLabel("시험 제목");
    if (!await title.isVisible()) await page.getByRole("tab", { name: /^설정/ }).click();
    await title.fill("배포 명단 실패 검증 시험");
    await page.getByLabel("빠른 정답 입력").fill("1".repeat(20));
    await page.evaluate(() => {
        const rawSession = window.sessionStorage.getItem("omr_teacher_session");
        if (!rawSession) throw new Error("teacher session missing");
        const session = JSON.parse(rawSession) as Record<string, unknown>;
        session.teacherId = "admin";
        session.organizationId = "default";
        session.accountSessionGeneration = 1;
        session.sessionAuthority = "legacy_account";
        window.sessionStorage.setItem("omr_teacher_session", JSON.stringify(session));
        const now = new Date().toISOString();
        const key = [
            "omr:canonical-surface-cache:v1:teacher_roster",
            encodeURIComponent(String(session.organizationId)),
            encodeURIComponent(String(session.teacherId)),
            String(session.accountSessionGeneration),
        ].join(":");
        window.localStorage.setItem(key, JSON.stringify({
            schemaVersion: 1,
            surface: "teacher_roster",
            organizationId: session.organizationId,
            accountId: session.teacherId,
            sessionGeneration: session.accountSessionGeneration,
            staleAt: now,
            data: {
                students: [{
                    id: "cached-student",
                    name: "저장된 학생",
                    email: "cached@example.com",
                    groupId: "cached-group",
                    status: "active",
                    avgScore: 80,
                    examsTaken: 1,
                    lastActive: "방금 전",
                }],
                groups: [{
                    id: "cached-group",
                    name: "저장반",
                    status: "active",
                    studentCount: 1,
                    avgScore: 80,
                }],
                invites: [],
            },
        }));
    });
    // Save once with a fresh canonical roster so the second open is an
    // existing-exam capability check (assignment + invite metadata both run).
    recoverRosterAction = true;
    await page.locator(".create-primary-actions:visible")
        .getByRole("button", { name: "저장하고 배포하기" })
        .click();
    const warmDistribution = page.getByRole("dialog", { name: "시험 배포하기" });
    await expect(warmDistribution).toBeVisible();
    await expect(warmDistribution.getByRole("button", { name: "링크 생성하기" })).toBeEnabled();
    await warmDistribution.getByRole("button", { name: "링크 생성하기" }).click();
    await expect(warmDistribution.getByRole("button", { name: "링크 복사" })).toBeVisible();
    await warmDistribution.getByRole("button", { name: "닫기" }).click();
    recoverRosterAction = false;

    delayCanonicalActions = true;
    failCanonicalActions = true;
    restrictedRosterActionRequestCount = 0;
    capabilityReadActionRequestCount = 0;
    observeRestrictedRosterActions = true;
    await page.locator(".create-primary-actions:visible")
        .getByRole("button", { name: "저장하고 배포하기" })
        .click();

    const distribution = page.getByRole("dialog", { name: "시험 배포하기" });
    await expect(distribution).toBeVisible();
    await expect(distribution.getByRole("button", { name: "링크 생성하기" })).toBeDisabled();
    await expect(distribution.getByTestId("canonical-distribution-roster-loading")).toBeVisible();
    delayCanonicalActions = false;
    const distributionRosterDegraded = distribution.getByTestId("canonical-degraded-cache");
    await expect(distributionRosterDegraded).toContainText("읽기 전용");
    await expect(distribution.getByRole("button", { name: "링크 생성하기" })).toBeDisabled();
    await page.waitForTimeout(250);
    observeRestrictedRosterActions = false;
    expect(restrictedRosterActionRequestCount).toBe(0);
    expect(capabilityReadActionRequestCount).toBeGreaterThan(0);

    failCanonicalActions = false;
    recoverRosterAction = true;
    await distributionRosterDegraded.getByRole("button", { name: "다시 시도" }).click();
    await expect(distributionRosterDegraded).toBeHidden();
    await expect(distribution.getByRole("button", { name: "링크 생성하기" })).toBeEnabled();
    recoverRosterAction = false;
    expect(injectedFailureCount).toBeGreaterThan(0);
});
