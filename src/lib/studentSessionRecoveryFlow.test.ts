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
        expect(dashboard).not.toContain('href="/?role=student"');
        expect(dashboard).not.toContain("workspace: currentUser.workspaceId");
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

    it("replaces the impossible production bare login form with invite recovery guidance", () => {
        const home = source("src/app/page.tsx");
        const student = home.slice(
            home.indexOf("{/* Student form */}"),
            home.indexOf('{requiresServerStudentVerification ? (', home.indexOf("{/* Student form */}")),
        );

        expect(home).toContain("productionStudentRecoveryRequired");
        expect(student).toContain("productionStudentRecoveryRequired ? (");
        expect(student).toContain('className="student-login-recovery-guidance"');
        expect(student).toContain("학생 계정 로그인에는 선생님이 보낸 최신 초대 링크가 필요합니다.");
        expect(student).toContain(': (\n                <form');
    });

    it("uses only a server-verified scoped guest or opaque invite for account connection", () => {
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
        expect(dashboard).toContain("canLoginWithCurrentScope");
        expect(dashboard).toContain("학생 초대 링크가 필요합니다");
        expect(home).toContain('studentDirectoryStatus === "signed_guest"');
        expect(home).toContain("await refreshStudentSession()");
    });
});
