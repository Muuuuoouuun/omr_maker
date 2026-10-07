import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSignedStudentSessionCookie } from "@/lib/studentServerSession";

const cookieState = vi.hoisted(() => ({ value: "" }));
const cookieSet = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({
    headers: async () => new Headers({ origin: "http://localhost:3003", host: "localhost:3003" }),
    cookies: async () => ({
        get: (name: string) => name === "omr_student_server_session" && cookieState.value
            ? { value: cookieState.value }
            : undefined,
        set: cookieSet,
        delete: vi.fn(),
    }),
}));

vi.mock("@/lib/serverActionSecurity", () => ({ isSameOriginServerActionRequest: () => true }));

import { refreshStudentSession } from "@/app/actions/studentSession";

function source(path: string): string {
    return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("student session recovery flow", () => {
    beforeEach(() => {
        cookieState.value = "";
        cookieSet.mockClear();
    });

    it("restores a safe student view model from the signed HttpOnly cookie", async () => {
        cookieState.value = createSignedStudentSessionCookie({
            kind: "student",
            studentId: "student-1",
            organizationId: "org-secret",
            name: "학생 1",
            groupId: "class-1",
            groupName: "A반",
            regionId: "seoul",
            regionName: "서울",
            identityType: "temporary",
        }) || "";

        await expect(refreshStudentSession()).resolves.toMatchObject({
            ok: true,
            status: "ok",
            session: {
                studentId: "student-1",
                name: "학생 1",
                groupId: "class-1",
                groupName: "A반",
                regionId: "seoul",
                regionName: "서울",
                isGuest: false,
                identityType: "temporary",
            },
        });
        const restored = await refreshStudentSession();
        expect(JSON.stringify(restored)).not.toContain("org-secret");
    });

    it("restores a scoped guest without exposing its organization", async () => {
        cookieState.value = createSignedStudentSessionCookie({
            kind: "guest",
            guestId: "guest-1",
            organizationId: "org-secret",
            name: "게스트 학생",
            groupId: "class-1",
            groupName: "A반",
            identityType: "guest",
        }) || "";

        const restored = await refreshStudentSession();
        expect(restored).toMatchObject({
            ok: true,
            status: "ok",
            canLoginWithCurrentScope: true,
            session: {
                studentId: "guest:guest-1",
                name: "게스트 학생",
                groupId: "class-1",
                groupName: "A반",
                isGuest: true,
                identityType: "guest",
                guestId: "guest-1",
            },
        });
        expect(JSON.stringify(restored)).not.toContain("org-secret");
    });

    it("marks the dashboard missing only after the server confirms there is no cookie", () => {
        const dashboard = source("src/app/student/dashboard/page.tsx");
        const load = dashboard.slice(
            dashboard.indexOf("const loadStudentData = async () =>"),
            dashboard.indexOf("// 2. Load Data"),
        );

        expect(dashboard).toContain("refreshStudentSession");
        expect(load).toContain("await refreshStudentSession()");
        expect(load).toContain('restored.status === "unauthenticated"');
        expect(load).toContain("saveSession(currentUser)");
        expect(load.indexOf("await refreshStudentSession()"))
            .toBeLessThan(load.indexOf('setSessionState("missing")'));
        expect(dashboard).toContain('href="/?role=student"');
        expect(dashboard).not.toContain("workspace: currentUser.workspaceId");
    });

    it("tells a student whose remembered session ended that it expired, and returns them after login", () => {
        const dashboard = source("src/app/student/dashboard/page.tsx");
        const load = dashboard.slice(
            dashboard.indexOf("const loadStudentData = async () =>"),
            dashboard.indexOf("// 2. Load Data"),
        );
        const rejected = dashboard.slice(
            dashboard.indexOf("const endRejectedSession = "),
            dashboard.indexOf("const loadStudentData = async () =>"),
        );

        // Only a session this device already had can be "expired".
        expect(load.indexOf("const localSessionExisted = !!currentUser;"))
            .toBeLessThan(load.indexOf("await refreshStudentSession()"));
        expect(dashboard.match(/endRejectedSession\(currentUser, localSessionExisted\)/g)).toHaveLength(2);
        expect(rejected).toContain('setSessionState(localSessionExisted ? "expired" : "missing")');
        // The opt-in hint is synced before the stale local identity is cleared.
        expect(rejected.indexOf("refreshStudentReturnHint(session)")).toBeGreaterThan(-1);
        expect(rejected.indexOf("refreshStudentReturnHint(session)")).toBeLessThan(rejected.indexOf("clearSession()"));

        expect(dashboard).toContain("로그인 시간이 끝났어요");
        expect(dashboard).toContain("보안을 위해 12시간이 지나면 다시 확인해요. 학생 로그인 ID와 시작 코드로 이어서 할 수 있어요.");
        expect(dashboard).toContain("보안을 위해 12시간이 지나면 다시 확인해요. 시작 코드만 다시 입력하면 이어서 할 수 있어요.");
        expect(dashboard).toContain('buildStudentLoginHref(expiredReturnPath, { reason: "expired" })');
        expect(dashboard).toContain("학생 로그인 ID와 시작 코드로 다시 로그인할 수 있어요. 선생님이 보낸 초대 링크도 계속 사용할 수 있습니다.");
        expect(dashboard).toContain("{sessionExpired && productionRuntime && (");
        expect(dashboard).toContain("{sessionExpired && !productionRuntime && (");
        expect(dashboard).toContain('buildStudentLoginHref("/student/dashboard")');

        const recheck = dashboard.slice(
            dashboard.indexOf("const handleExpiredRecheck = async () =>"),
            dashboard.indexOf("const handleLogout = async () =>"),
        );
        expect(recheck).toContain("await refreshStudentSession()");
        expect(recheck).toContain("saveSession(restored.session)");

        const logout = dashboard.slice(dashboard.indexOf("const handleLogout = async () =>"));
        expect(logout.indexOf("clearStudentReturnHint()")).toBeGreaterThan(-1);
        expect(logout.indexOf("clearStudentReturnHint()")).toBeLessThan(logout.indexOf("clearSession()"));
    });

    it("checks the server session before continuing a recent student from home", () => {
        const home = source("src/app/page.tsx");
        const resume = home.slice(
            home.indexOf("const handleContinueRecentStudent = async () =>"),
            home.indexOf("const handleNotThisStudent = () =>"),
        );

        expect(resume.indexOf("await refreshStudentSession()")).toBeGreaterThan(-1);
        expect(resume.indexOf("await refreshStudentSession()")).toBeLessThan(resume.indexOf("router.push(studentRedirectPath())"));
        expect(resume).toContain('setRole("student")');
        expect(resume).toContain("applyReturnHint(hint, !!storedHint)");
        expect(home).toContain("다시 오셨네요. 시작 코드를 입력하면 이어서 할 수 있어요.");
        expect(home).toContain("다른 학생이에요");
        expect(home).toContain('query.get("reason") === "expired" ? "student" : query.get("role")');
    });

    it("hides guest entry for an opaque group invite and explains the restriction", () => {
        const home = source("src/app/page.tsx");
        const alternate = home.slice(
            home.indexOf('{requiresServerStudentVerification ? ('),
            home.indexOf("</details>", home.indexOf('{requiresServerStudentVerification ? (')) + 10,
        );

        expect(home).toContain("그룹 초대 시험은 등록된 학생만 참여할 수 있습니다.");
        expect(home).toContain("초대된 반을 찾을 수 없습니다. 선생님에게 최신 초대 링크를 요청해주세요.");
        expect(home).toContain("선생님이 보낸 최신 초대 링크");
        expect(alternate).toContain('className="student-invite-guest-restriction"');
        expect(alternate).toContain(': (\n                  <details className="student-alternate-entry">');
    });

    it("offers teacher-issued credential login without an exam invite", () => {
        const home = source("src/app/page.tsx");
        expect(home).toContain("directStudentLogin");
        expect(home).toContain("<StudentDirectLoginForm");
        expect(home).not.toContain("student-login-recovery-guidance");
        expect(home).toContain('identityType: "registered"');
    });

    it("keeps invitation scope server verified and uses direct login for bare guest connections", () => {
        const action = source("src/app/actions/studentSession.ts");
        const login = action.slice(
            action.indexOf("export async function issueStudentSession"),
            action.indexOf("export async function retryGuestServerClaims"),
        );
        const dashboard = source("src/app/student/dashboard/page.tsx");
        const home = source("src/app/page.tsx");

        expect(login).toContain("existingGuestSession?.organizationId");
        expect(login).toContain("existingGuestSession?.groupId");
        expect(login).not.toContain("organizationId: input.workspaceId");
        expect(dashboard).toContain('router.push("/?role=student&connectGuest=1")');
        expect(home).not.toContain('studentDirectoryStatus === "signed_guest"');
        expect(home).toContain("<StudentDirectLoginForm");
        expect(home).toContain("await refreshStudentSession()");
    });
});
