import { readFile, unlink } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { parseCsvRows } from "../src/lib/csv";
import { mintTeacherToken } from "../src/lib/teacherAuth";
import { createSignedTeacherSessionCookie, TEACHER_SERVER_SESSION_COOKIE } from "../src/lib/teacherServerSession";
import { createTeacherSession, LEGACY_TEACHER_TOKEN_KEY, TEACHER_SESSION_KEY } from "../src/lib/teacherSession";
import { STUDENT_SERVER_SESSION_COOKIE } from "../src/lib/studentServerSession";

process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";

test.describe.configure({ mode: "serial", retries: 0 });
test.use({ trace: "off", screenshot: "off", video: "off" });

const hostedMode = process.env.OMR_STUDENT_CREDENTIAL_HOSTED_MODE === "1";
const START_CODE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/;

async function authenticateLocalTeacher(page: Page, baseURL: string | undefined) {
    const identity = {
        teacherId: "admin", email: "admin@example.com", displayName: "E2E Admin",
        organizationId: "default", organizationName: "E2E Workspace", memberRole: "admin" as const,
    };
    const token = mintTeacherToken();
    const session = createTeacherSession(token, Date.now(), identity);
    const signedCookie = createSignedTeacherSessionCookie(token, identity);
    if (!signedCookie) throw new Error("local teacher session fixture unavailable");
    const origin = new URL(baseURL || "http://localhost:3003").origin;
    await page.context().addCookies([{
        name: TEACHER_SERVER_SESSION_COOKIE, value: signedCookie, url: origin,
        httpOnly: true, sameSite: "Lax", secure: false,
    }]);
    await page.addInitScript(({ teacherSession, sessionKey, legacyKey }) => {
        sessionStorage.setItem(sessionKey, JSON.stringify(teacherSession));
        sessionStorage.setItem(legacyKey, teacherSession.token);
    }, { teacherSession: session, sessionKey: TEACHER_SESSION_KEY, legacyKey: LEGACY_TEACHER_TOKEN_KEY });
}

function requireHostedEnvironment(baseURL: string | undefined) {
    const required = {
        baseURL,
        approvedOrigin: process.env.OMR_STUDENT_CREDENTIAL_APPROVED_ORIGIN,
        productionOrigin: process.env.OMR_PRODUCTION_ORIGIN,
        mutation: process.env.OMR_STUDENT_CREDENTIAL_ALLOW_MUTATION,
        nonProduction: process.env.OMR_STUDENT_CREDENTIAL_NON_PRODUCTION,
        fixtureId: process.env.OMR_STUDENT_CREDENTIAL_FIXTURE_ID,
        studentIds: process.env.OMR_STUDENT_CREDENTIAL_STUDENT_IDS,
        studentNames: process.env.OMR_STUDENT_CREDENTIAL_STUDENT_NAMES,
        expectedEscapedName: process.env.OMR_STUDENT_CREDENTIAL_EXPECTED_ESCAPED_NAME,
        groupId: process.env.OMR_STUDENT_CREDENTIAL_GROUP_ID,
        inviteUrl: process.env.OMR_STUDENT_CREDENTIAL_INVITE_URL,
        teacherLogin: process.env.OMR_STUDENT_CREDENTIAL_TEACHER_LOGIN,
        teacherPassword: process.env.OMR_STUDENT_CREDENTIAL_TEACHER_PASSWORD,
        cleanupUrl: process.env.OMR_STUDENT_CREDENTIAL_FIXTURE_CLEANUP_URL,
        cleanupToken: process.env.OMR_STUDENT_CREDENTIAL_FIXTURE_CLEANUP_TOKEN,
    };
    const missing = Object.entries(required).filter(([, value]) => !value).map(([name]) => name);
    let approvedOrigin: string | null = null;
    try {
        const approved = new URL(required.approvedOrigin!);
        const production = new URL(required.productionOrigin!);
        const app = new URL(baseURL || "");
        const invite = new URL(required.inviteUrl!);
        const cleanup = new URL(required.cleanupUrl!);
        const safeUrl = (url: URL) => url.protocol === "https:" && !url.username && !url.password;
        const exactOriginUrl = (url: URL) => url.pathname === "/" && !url.search && !url.hash;
        const hostname = approved.hostname.toLowerCase();
        const nonLoopback = hostname !== "localhost"
            && !hostname.endsWith(".localhost")
            && !hostname.startsWith("127.")
            && hostname !== "0.0.0.0"
            && hostname !== "::1"
            && hostname !== "[::1]";
        if (safeUrl(approved) && safeUrl(production) && safeUrl(app) && safeUrl(invite) && safeUrl(cleanup)
            && exactOriginUrl(approved) && exactOriginUrl(production) && exactOriginUrl(app)
            && !cleanup.search && !cleanup.hash
            && nonLoopback
            && app.origin === approved.origin && invite.origin === approved.origin && cleanup.origin === approved.origin
            && production.origin !== approved.origin) {
            approvedOrigin = approved.origin;
        }
    } catch {
        approvedOrigin = null;
    }
    if (missing.length > 0 || required.mutation !== "1" || required.nonProduction !== "1" || !approvedOrigin) {
        throw new Error("unverified: hosted credential journey requires an external non-production disposable fixture and explicit mutation opt-in");
    }
    const studentIds = required.studentIds!.split(",").map(value => value.trim()).filter(Boolean);
    const studentNames = required.studentNames!.split(",").map(value => value.trim()).filter(Boolean);
    if (studentIds.length !== 2 || studentNames.length !== 2
        || new Set(studentIds).size !== 2 || new Set(studentNames).size !== 2) {
        throw new Error("unverified: hosted credential fixture must identify exactly two distinct students");
    }
    if (!/^[=+\-@]/u.test(studentNames[0]) || required.expectedEscapedName !== `'${studentNames[0]}`) {
        throw new Error("unverified: hosted fixture must prove spreadsheet neutralization with an exact dangerous-prefix name");
    }
    return { ...required, studentIds, studentNames } as const;
}

async function loginHostedTeacher(page: Page, login: string, password: string) {
    await page.goto("/?role=teacher&next=%2Fteacher%2Fusers");
    await page.getByPlaceholder("admin 또는 teacher@example.com").fill(login);
    await submitWithSecret(
        page.getByPlaceholder("비밀번호 입력"),
        password,
        page.getByRole("button", { name: "대시보드 입장" }),
    );
    await expect(page).toHaveURL(/\/teacher\/users(?:[?#].*)?$/, { timeout: 15_000 });
}

async function secretFill(locator: ReturnType<Page["locator"]>, secret: string) {
    await locator.evaluate((element: HTMLInputElement, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(element, value);
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
    }, secret);
}

async function submitWithSecret(
    input: ReturnType<Page["locator"]>,
    secret: string,
    submit: ReturnType<Page["locator"]>,
) {
    try {
        await secretFill(input, secret);
        await submit.click();
    } finally {
        await secretFill(input, "").catch(() => undefined);
    }
}

async function selectStudents(page: Page, studentNames: readonly string[]) {
    for (const studentName of studentNames) {
        await page.getByRole("checkbox", { name: `${studentName} 선택`, exact: true }).check();
    }
}

async function issueAndReadCsv(
    page: Page,
    count: number,
    cleanupPaths: Set<string>,
    proveDownloadRetry = false,
): Promise<{ path: string; rows: string[][] }> {
    let actionPosts = 0;
    page.on("request", request => {
        if (request.method() === "POST" && new URL(request.url()).pathname === "/teacher/users") actionPosts += 1;
    });
    await page.getByRole("button", { name: "선택 학생 코드 발급" }).click();
    const dialog = page.getByRole("dialog", { name: "학생 시작 코드 일괄 발급" });
    await expect(dialog).toContainText("기존 로그인 세션도 즉시 종료됩니다");
    await dialog.getByRole("button", { name: `${count}명 발급` }).click();
    const downloadButton = dialog.getByRole("button", { name: "CSV 다운로드" });
    await expect(downloadButton).toBeVisible();
    if (proveDownloadRetry) {
        const postsAfterIssue = actionPosts;
        await page.evaluate(() => {
            const originalClick = HTMLAnchorElement.prototype.click;
            HTMLAnchorElement.prototype.click = function clickOnce() {
                HTMLAnchorElement.prototype.click = originalClick;
                throw new Error("injected local download dispatch failure");
            };
        });
        await downloadButton.click();
        await expect(dialog).toContainText("다운로드만 다시 시도");
        if (actionPosts !== postsAfterIssue) throw new Error("download retry unexpectedly reissued credentials");
    }
    const downloadPromise = page.waitForEvent("download");
    await downloadButton.click();
    const download = await downloadPromise;
    const path = await download.path();
    if (!path) throw new Error("unverified: hosted browser did not expose a disposable download path");
    cleanupPaths.add(path);
    const bytes = await readFile(path);
    expect(bytes[0]).toBe(0xef);
    expect(bytes[1]).toBe(0xbb);
    expect(bytes[2]).toBe(0xbf);
    const csv = bytes.toString("utf8");
    expect(csv.startsWith("\uFEFFstudent_id,name,group,start_code\r\n")).toBe(true);
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv).not.toMatch(/(^|[^\r])\n/u);
    const rows = parseCsvRows(csv.slice(1));
    expect(rows).toHaveLength(count + 1);
    expect(rows[0]).toEqual(["student_id", "name", "group", "start_code"]);
    if (rows.slice(1).some(row => !START_CODE.test(row[3] || ""))) {
        throw new Error("hosted credential CSV contained a malformed code (values redacted)");
    }
    return { path, rows };
}

async function assertSecretsAbsent(page: Page, codes: readonly string[], browserMessages: readonly string[]) {
    const leaked = await page.evaluate(secretCodes => {
        const storageText = (storage: Storage) => Object.keys(storage)
            .map(key => `${key}:${storage.getItem(key) || ""}`)
            .join("\n");
        const surfaces = [
            document.body.innerText,
            window.location.href,
            storageText(window.localStorage),
            storageText(window.sessionStorage),
        ];
        return secretCodes.some(code => surfaces.some(surface => surface.includes(code)));
    }, codes);
    const consoleLeak = codes.some(code => browserMessages.some(message => message.includes(code)));
    if (leaked || consoleLeak) throw new Error("credential leakage detected on a browser surface (values redacted)");
}

async function fillStudentLogin(
    page: Page,
    fixture: { inviteUrl: string; name: string; studentId: string; groupId: string; code: string },
) {
    await page.goto(fixture.inviteUrl);
    await page.getByPlaceholder("이름을 입력하세요").fill(fixture.name);
    await page.getByLabel("학생번호 또는 이메일").fill(fixture.studentId);
    const groupSelect = page.getByLabel("반 선택");
    if (await groupSelect.isVisible().catch(() => false)) await groupSelect.selectOption(fixture.groupId);
    else await page.getByLabel("반 코드").fill(fixture.groupId);
    await submitWithSecret(
        page.getByLabel("시작 코드"),
        fixture.code,
        page.getByRole("button", { name: "시험 시작하기" }),
    );
}

if (!hostedMode) {
    test("local UI is unverified for hosted issuance and fails closed without exposing a credential", async ({ page, baseURL }) => {
        const legacySecret = "OLD2CD";
        const browserMessages: string[] = [];
        page.on("console", message => browserMessages.push(message.text()));
        await page.addInitScript(({ secret }) => {
            localStorage.setItem("omr_student_codes", JSON.stringify({ "student-local-1": secret }));
            localStorage.setItem("omr_students", JSON.stringify([
                { id: "student-local-1", name: "로컬 학생 1", email: "local1@example.com", group: "테스트반", region: "서울", avatar: "#4f46e5", avgScore: 0, examsTaken: 0, lastActive: "기록 없음", trend: "flat", status: "active" },
                { id: "student-local-2", name: "로컬 학생 2", email: "local2@example.com", group: "테스트반", region: "서울", avatar: "#ec4899", avgScore: 0, examsTaken: 0, lastActive: "기록 없음", trend: "flat", status: "active" },
            ]));
            localStorage.setItem("omr_groups", JSON.stringify([
                { id: "local-group", name: "테스트반", region: "서울", count: 2, avgScore: 0, color: "#4f46e5" },
            ]));
            localStorage.setItem("omr_invites", "[]");
        }, { secret: legacySecret });

        await authenticateLocalTeacher(page, baseURL);
        await page.goto("/teacher/users");
        await expect(page).toHaveURL(/\/teacher\/users(?:[?#].*)?$/);
        const storedStudentCount = await page.evaluate(() => {
            const rows = JSON.parse(localStorage.getItem("omr_students") || "[]") as unknown;
            return Array.isArray(rows) ? rows.length : -1;
        });
        expect(storedStudentCount).toBe(2);
        await expect(page.getByText("로컬 학생 1", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
        const boxes = page.locator('tbody input[type="checkbox"]');
        await expect(boxes).toHaveCount(2);
        await boxes.nth(0).check();
        await boxes.nth(1).check();
        await page.getByRole("button", { name: "선택 학생 코드 발급" }).click();
        const dialog = page.getByRole("dialog", { name: "학생 시작 코드 일괄 발급" });
        await expect(dialog).toContainText("기존 로그인 세션도 즉시 종료됩니다");
        let actionPosts = 0;
        const actionBodies: string[] = [];
        page.on("request", request => {
            if (request.method() === "POST" && new URL(request.url()).pathname === "/teacher/users") {
                actionPosts += 1;
                actionBodies.push(request.postData() || "");
            }
        });
        await dialog.getByRole("button", { name: "2명 발급" }).evaluate((button: HTMLButtonElement) => {
            button.click();
            button.click();
        });
        await expect(dialog).toContainText("발급을 시작하지 못했습니다");
        expect(actionPosts).toBe(1);
        await expect(dialog.getByRole("button", { name: "새 코드 발급" })).toHaveCount(0);
        await expect(dialog.getByRole("button", { name: "닫기" })).toBeDisabled();
        await page.keyboard.press("Escape");
        await expect(dialog).toBeVisible();
        await dialog.getByRole("button", { name: "같은 요청 상태 다시 확인" }).click();
        await expect(dialog).toContainText("발급을 시작하지 못했습니다");
        expect(actionPosts).toBe(2);
        if (!actionBodies[0] || actionBodies[0] !== actionBodies[1]) {
            throw new Error("status recovery did not reuse the exact caller-held request (payload redacted)");
        }
        expect(await page.evaluate(() => localStorage.getItem("omr_student_codes"))).toBeNull();
        expect(await page.evaluate(() => sessionStorage.getItem("omr_student_codes"))).toBeNull();
        if ((await page.locator("body").innerText()).includes(legacySecret)) {
            throw new Error("legacy credential leaked into the DOM (value redacted)");
        }
        expect(page.url()).not.toContain("batch_");
        if (browserMessages.some(message => message.includes(legacySecret))) {
            throw new Error("legacy credential leaked into console output (value redacted)");
        }
    });
} else {
    test("hosted provision, CSV login, rotation, and old credential rejection", async ({ page, baseURL, request }) => {
        const fixture = requireHostedEnvironment(baseURL);
        const browserMessages: string[] = [];
        page.on("console", message => browserMessages.push(message.text()));
        let firstDownloadPath: string | null = null;
        let rotatedDownloadPath: string | null = null;
        const cleanupPaths = new Set<string>();
        try {
            await loginHostedTeacher(page, fixture.teacherLogin!, fixture.teacherPassword!);
            await selectStudents(page, fixture.studentNames);
            const first = await issueAndReadCsv(page, 2, cleanupPaths, true);
            firstDownloadPath = first.path;
            expect(first.rows.slice(1).map(row => row[0])).toEqual(fixture.studentIds);
            if (first.rows[1][1] !== fixture.expectedEscapedName) {
                throw new Error("hosted CSV spreadsheet neutralization mismatch (value redacted)");
            }
            const firstStudent = first.rows[1];
            const oldCode = firstStudent[3];
            await assertSecretsAbsent(page, [oldCode], browserMessages);
            await page.reload();
            await assertSecretsAbsent(page, [oldCode], browserMessages);

            await fillStudentLogin(page, {
                inviteUrl: fixture.inviteUrl!,
                name: fixture.studentNames[0],
                studentId: fixture.studentIds[0],
                groupId: fixture.groupId!,
                code: oldCode,
            });
            await expect(page).toHaveURL(/\/student\/dashboard(?:[?#].*)?$/, { timeout: 15_000 });
            const oldCookie = (await page.context().cookies()).find(cookie => (
                cookie.httpOnly && cookie.name === STUDENT_SERVER_SESSION_COOKIE
            ));
            expect(oldCookie).toBeDefined();

            await page.goto("/teacher/users");
            await selectStudents(page, [fixture.studentNames[0]]);
            const rotated = await issueAndReadCsv(page, 1, cleanupPaths);
            rotatedDownloadPath = rotated.path;
            const newCode = rotated.rows[1][3];
            if (newCode === oldCode) throw new Error("credential rotation did not change the code (values redacted)");
            await assertSecretsAbsent(page, [oldCode, newCode], browserMessages);
            await page.reload();
            await assertSecretsAbsent(page, [oldCode, newCode], browserMessages);

            await page.context().addCookies([oldCookie!]);
            await page.goto("/student/dashboard");
            await expect(page).not.toHaveURL(/\/student\/dashboard(?:[?#].*)?$/, { timeout: 15_000 });
            await fillStudentLogin(page, {
                inviteUrl: fixture.inviteUrl!, name: fixture.studentNames[0], studentId: fixture.studentIds[0],
                groupId: fixture.groupId!, code: oldCode,
            });
            await expect(page.getByRole("alert")).toHaveText("이름, 반, 학생번호(또는 이메일), 시작 코드를 다시 확인해주세요.");
            await expect(page).not.toHaveURL(/\/student\/dashboard(?:[?#].*)?$/);
            await submitWithSecret(
                page.getByLabel("시작 코드"),
                newCode,
                page.getByRole("button", { name: "시험 시작하기" }),
            );
            await expect(page).toHaveURL(/\/student\/dashboard(?:[?#].*)?$/, { timeout: 15_000 });
            await assertSecretsAbsent(page, [oldCode, newCode], browserMessages);
            await page.reload();
            await assertSecretsAbsent(page, [oldCode, newCode], browserMessages);
        } finally {
            if (firstDownloadPath) await unlink(firstDownloadPath).catch(() => undefined);
            if (rotatedDownloadPath) await unlink(rotatedDownloadPath).catch(() => undefined);
            for (const path of cleanupPaths) await unlink(path).catch(() => undefined);
            const cleanup = await request.post(fixture.cleanupUrl!, {
                headers: { authorization: `Bearer ${fixture.cleanupToken}` },
                data: { fixtureId: fixture.fixtureId },
            });
            if (!cleanup.ok()) throw new Error("unverified: hosted disposable credential fixture cleanup failed");
        }
    });
}
