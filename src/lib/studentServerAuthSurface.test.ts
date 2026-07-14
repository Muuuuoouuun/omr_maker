import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
    return readFileSync(join(process.cwd(), path), "utf8");
}

describe("student server authentication surface", () => {
    it("mints and consumes an HttpOnly signed student session", () => {
        const authAction = source("src/app/actions/studentAuth.ts");
        const attemptAction = source("src/app/actions/studentAttempt.ts");

        expect(authAction).toContain("verifyStudentCredentials");
        expect(authAction).toContain("httpOnly: true");
        expect(authAction).toContain("sameSite: \"lax\"");
        expect(attemptAction).toContain("parseSignedStudentSessionCookie");
        expect(attemptAction).toContain("openStudentExamWithGateway(client, input, process.env, Date.now(), studentSession)");
    });

    it("connects login, teacher issuance, and logout to server actions", () => {
        expect(source("src/app/page.tsx")).toContain("await loginStudentWithStartCode");
        expect(source("src/app/teacher/users/page.tsx")).toContain("await issueStudentStartCodeCredential");
        expect(source("src/app/student/dashboard/page.tsx")).toContain("await logoutStudentServerSession");
    });

    it("keeps credential hashes in a service-role-only table", () => {
        const migration = source("supabase/migrations/202607140004_student_server_sessions.sql");
        expect(migration).toContain("omr_student_start_credentials");
        expect(migration).toContain("force row level security");
        expect(migration).toContain("revoke all on public.omr_student_start_credentials from anon, authenticated");
    });

    it("allows local fallback only for explicitly unconfigured development mode", () => {
        const attemptAction = source("src/app/actions/studentAttempt.ts");
        const solvePage = source("src/app/solve/[id]/page.tsx");
        expect(attemptAction).toContain('process.env.NODE_ENV === "production" ? "service_unavailable" : "local_only"');
        expect(solvePage).toContain('remotePreview.status === "local_only"');
        expect(solvePage).toContain("운영 시험은 서버 연결 없이 로컬 채점으로 전환하지 않습니다");
    });
});
