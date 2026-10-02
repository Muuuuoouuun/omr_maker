import { expect, test, type Page } from "@playwright/test";
import { exactNextActionId, loginAsTeacher, resetBrowserState } from "./helpers";

const EXAM_A = "e2e-invite-exam-a";
const EXAM_B = "e2e-invite-exam-b";
const GROUP_A = "e2e-group-a";
const GROUP_B = "e2e-group-b";
const ACTOR_USER_ID = "teacher_0en845w";

async function seedInviteRoster(page: Page) {
    await page.evaluate(({ groupA, groupB }) => {
        window.localStorage.setItem("omr_groups", JSON.stringify([{
            id: groupA,
            name: "E2E A반",
            region: "서울",
            count: 0,
            avgScore: 0,
            color: "#4f46e5",
        }, {
            id: groupB,
            name: "E2E B반",
            region: "부산",
            count: 0,
            avgScore: 0,
            color: "#10b981",
        }]));
        window.localStorage.setItem("omr_students", "[]");
        window.localStorage.setItem("omr_invites", "[]");
    }, { groupA: GROUP_A, groupB: GROUP_B });
}

async function seedInviteDraft(page: Page, examId: string, title: string) {
    await page.evaluate(({ targetExamId, examTitle, actorUserId }) => {
        const now = new Date().toISOString();
        const rawSession = window.sessionStorage.getItem("omr_teacher_session");
        const session = rawSession ? JSON.parse(rawSession) as {
            organizationId?: string;
            teacherId?: string;
        } : null;
        if (session && (session.organizationId !== "default" || session.teacherId !== "admin")) {
            throw new Error("The invite fixture only permits the configured E2E admin");
        }
        const draftKey = `omr_exam_draft:workspace:default:${actorUserId}:new`;
        const draft = {
            title: examTitle,
            questionsCount: 20,
            columns: 2,
            defaultChoices: 5,
            durationMin: 50,
            questions: Array.from({ length: 20 }, (_, index) => ({
                id: index + 1,
                number: index + 1,
                choices: 5,
                answer: 1,
                score: 5,
            })),
            savedAt: now,
        };
        window.localStorage.setItem(draftKey, JSON.stringify(draft));
        window.localStorage.setItem(`${draftKey}:publishTargetId`, targetExamId);
    }, { targetExamId: examId, examTitle: title, actorUserId: ACTOR_USER_ID });
}

async function restoreInviteDraft(page: Page, title: string, navigate = true) {
    if (navigate) await page.goto("/create");
    await page.waitForLoadState("networkidle");
    const restoreDialog = page.getByRole("dialog", { name: "임시 초안 복원" });
    await expect(restoreDialog).toBeVisible();
    await restoreDialog.getByRole("button", { name: "복원" }).click();
    const settingsTab = page.getByRole("tab", { name: "설정" });
    if (await settingsTab.isVisible()) await settingsTab.click();
    await expect(page.getByRole("textbox", { name: "시험 제목" })).toHaveValue(title);
}

async function prepareInviteDraft(page: Page, examId: string, title: string) {
    await seedInviteDraft(page, examId, title);
    await restoreInviteDraft(page, title);
}

async function ensureCanonicalTeacherIdentity(page: Page) {
    await page.evaluate(() => {
        const rawSession = window.sessionStorage.getItem("omr_teacher_session");
        if (!rawSession) throw new Error("teacher session missing");
        const session = JSON.parse(rawSession) as Record<string, unknown>;
        session.teacherId = "admin";
        session.organizationId = "default";
        session.accountSessionGeneration = 1;
        session.sessionAuthority = "legacy_account";
        window.sessionStorage.setItem("omr_teacher_session", JSON.stringify(session));
    });
}

async function openDistribution(page: Page) {
    await expect(page.getByRole("heading", { name: /^(?:새 시험 만들기|시험 편집)$/ })).toBeVisible();
    await ensureCanonicalTeacherIdentity(page);
    await page.getByRole("button", { name: "저장하고 배포하기" }).click();
    const modal = page.getByRole("dialog", { name: "시험 배포하기" });
    await expect(modal).toBeVisible();
    return modal;
}

async function selectGroup(modal: ReturnType<Page["getByRole"]>, groupName: string) {
    await modal.getByText("특정 그룹만", { exact: false }).click();
    await modal.getByText(groupName, { exact: false }).click();
}

async function attachDraftAsPublicExam(page: Page, examId: string, title: string) {
    await prepareInviteDraft(page, examId, title);
    const modal = await openDistribution(page);
    await modal.getByRole("button", { name: "링크 생성하기" }).click();
    await expect(modal.getByRole("button", { name: "링크 복사" })).toBeVisible();
    await modal.getByRole("button", { name: "닫기" }).click();
    await expect(page).toHaveURL(new RegExp(`edit=${examId}`));
}

async function expectInviteDirectory(
    page: Page,
    inviteUrl: string,
    expectedGroup: string | null,
) {
    await page.goto(inviteUrl);
    await expect(page).toHaveURL(/\?role=student.*exam=e2e-invite-exam-/, { timeout: 15_000 });
    await expect(page.getByRole("heading", { name: "학습 시작" })).toBeVisible();
    if (expectedGroup) {
        await expect(page.getByLabel("반 선택")).toBeVisible();
        await expect(page.getByLabel("반 선택").locator("option", { hasText: expectedGroup })).toHaveCount(1);
        await expect(page.getByText("초대된 반을 찾을 수 없습니다", { exact: false })).toHaveCount(0);
    } else {
        await expect(page.getByText("초대된 반을 찾을 수 없습니다", { exact: false })).toBeVisible();
    }
}

test("group invite lifecycle stays honest across reopen, refresh, rotation, and exam scope", async ({ page, context }) => {
    test.setTimeout(60_000);
    const browserErrors: string[] = [];
    let phase = "setup";
    page.on("pageerror", error => {
        browserErrors.push(`${phase} pageerror: ${error.stack || error.message}`);
    });
    page.on("console", message => {
        if (message.type() === "error") {
            browserErrors.push(`${phase} console: ${message.text()}`);
        }
    });
    context.on("page", openedPage => {
        openedPage.on("pageerror", error => {
            browserErrors.push(`${phase} pageerror: ${error.stack || error.message}`);
        });
        openedPage.on("console", message => {
            if (message.type() === "error") {
                browserErrors.push(`${phase} console: ${message.text()}`);
            }
        });
    });
    await resetBrowserState(page, context);
    await page.waitForLoadState("networkidle");
    await seedInviteRoster(page);
    await seedInviteDraft(page, EXAM_A, "초대 생명주기 A 시험");
    await loginAsTeacher(page, "/create");
    await restoreInviteDraft(page, "초대 생명주기 A 시험", false);
    await ensureCanonicalTeacherIdentity(page);
    const rosterActionId = exactNextActionId(
        "src/app/actions/teacherRoster.ts",
        "loadTeacherCanonicalRoster",
        "app/create/page",
    );
    let rosterRewriteCount = 0;
    await page.route("**/*", async route => {
        const request = route.request();
        if (request.method() !== "POST" || request.headers()["next-action"] !== rosterActionId) {
            await route.continue();
            return;
        }
        const response = await route.fetch();
        const body = await response.text();
        const loadedAt = new Date().toISOString();
        const loaded = JSON.stringify({
            status: "loaded",
            snapshot: {
                students: [],
                groups: [{ id: GROUP_A, name: "E2E A반", region: "서울", count: 0, avgScore: 0, color: "#4f46e5" },
                    { id: GROUP_B, name: "E2E B반", region: "부산", count: 0, avgScore: 0, color: "#10b981" }],
                invites: [],
            },
            revision: 1,
            meta: { organizationId: "default", loadedAt, rawCount: 2, parsedCount: 2 },
        });
        const rewritten = body.replaceAll('{"status":"local_only"}', loaded);
        if (rewritten !== body) rosterRewriteCount += 1;
        await route.fulfill({ response, body: rewritten });
    });
    await page.waitForLoadState("networkidle");

    let modal = await openDistribution(page);
    await selectGroup(modal, "E2E A반");
    await expect(modal.getByRole("button", { name: "링크 생성하기" })).toBeEnabled();
    await expect(modal.getByTestId("distribution-invite-active_but_raw_unavailable")).toHaveCount(0);
    await modal.getByRole("button", { name: "링크 생성하기" }).click();
    await expect(modal.getByRole("button", { name: "링크 복사" })).toBeVisible();
    const oldUrl = (await modal.getByTestId("distribution-share-url").textContent())?.trim() || "";
    expect(oldUrl).toContain(`/solve/${EXAM_A}#invite=`);

    await modal.getByRole("button", { name: "닫기" }).click();
    phase = "reopen-a";
    await page.getByRole("button", { name: "저장하고 배포하기" }).click();
    modal = page.getByRole("dialog", { name: "시험 배포하기" });
    await expect(modal.getByRole("button", { name: "링크 복사" })).toBeVisible();
    await expect(modal.getByTestId("distribution-share-url")).toHaveText(oldUrl);

    phase = "refresh-a";
    await page.waitForLoadState("networkidle");
    await page.reload();
    await page.waitForLoadState("networkidle");
    phase = "reattach-a";
    await attachDraftAsPublicExam(page, EXAM_A, "초대 생명주기 A 시험");
    modal = await openDistribution(page);
    await selectGroup(modal, "E2E A반");
    const unavailable = modal.getByTestId("distribution-invite-active_but_raw_unavailable");
    await expect(unavailable).toContainText("활성 링크가 있습니다");
    await expect(unavailable).toContainText("이 기기에는 링크 원문이 없습니다");
    await expect(modal.getByRole("button", { name: "링크 복사" })).toHaveCount(0);
    await expect(modal.locator("#qr-code-canvas")).toHaveCount(0);

    let confirmation = "";
    page.once("dialog", async dialog => {
        confirmation = dialog.message();
        await dialog.accept();
    });
    phase = "reissue-a";
    await modal.getByRole("button", { name: "새 링크 발급하기" }).click();
    await expect(modal.getByRole("button", { name: "링크 복사" })).toBeVisible();
    expect(confirmation).toContain("기존 링크와 QR은 즉시 무효화됩니다");
    const newUrl = (await modal.getByTestId("distribution-share-url").textContent())?.trim() || "";
    expect(newUrl).toContain(`/solve/${EXAM_A}#invite=`);
    expect(newUrl).not.toBe(oldUrl);

    await modal.getByRole("button", { name: "닫기" }).click();
    phase = "attach-b";
    await attachDraftAsPublicExam(page, EXAM_B, "초대 생명주기 B 시험");
    modal = await openDistribution(page);
    await selectGroup(modal, "E2E B반");
    await expect(modal.getByTestId("distribution-share-url")).toHaveCount(0);
    await expect(modal.getByText("활성 링크가 있습니다", { exact: true })).toHaveCount(0);
    await modal.getByRole("button", { name: "닫기" }).click();

    phase = "resolve-old";
    const oldPage = await context.newPage();
    await expectInviteDirectory(oldPage, oldUrl, null);
    await oldPage.close();

    phase = "resolve-new";
    const newPage = await context.newPage();
    await expectInviteDirectory(newPage, newUrl, "E2E A반");
    await newPage.close();

    phase = "resolve-cross";
    const crossExamUrl = new URL(newUrl);
    crossExamUrl.pathname = `/solve/${EXAM_B}`;
    const crossExamPage = await context.newPage();
    await expectInviteDirectory(crossExamPage, crossExamUrl.toString(), null);
    await expect(crossExamPage.getByLabel("반 선택").locator("option", { hasText: "E2E B반" })).toHaveCount(0);
    await crossExamPage.close();
    expect(rosterRewriteCount).toBeGreaterThan(0);
    expect(browserErrors).toEqual([]);
});
