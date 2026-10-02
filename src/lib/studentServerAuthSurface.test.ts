import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
    return readFileSync(join(process.cwd(), path), "utf8");
}

describe("student server authentication surface", () => {
    it("mints and consumes an HttpOnly signed student session", () => {
        const sessionAction = source("src/app/actions/studentSession.ts");
        const examAction = source("src/app/actions/studentExam.ts");

        expect(sessionAction).toContain("createSignedStudentSessionCookie");
        expect(sessionAction).toContain("resolveAuthorizedStudentSessionCookie");
        expect(sessionAction).not.toContain("parseSignedStudentSessionCookie");
        expect(sessionAction).toContain("httpOnly: true");
        expect(sessionAction).toContain("sameSite: \"lax\"");
        expect(examAction).toContain("resolveAuthorizedStudentSessionCookie");
        expect(examAction).not.toContain("parseSignedStudentSessionCookie");
        expect(examAction).toContain("resolveCtx()");
    });

    it("connects login, teacher issuance, and logout to server actions", () => {
        const rootPage = source("src/app/page.tsx");
        expect(rootPage).toContain("await issueStudentSession");
        expect(rootPage).toContain("loadLocalStudentCodes");
        expect(rootPage).not.toContain("readStudentCodes");
        expect(rootPage.indexOf("loadLocalStudentCodes(localStorage, process.env.NODE_ENV)"))
            .toBeLessThan(rootPage.indexOf("seedLocalTestStudentAccounts(localStorage)"));
        const users = source("src/app/teacher/users/page.tsx");
        expect(users).toContain("issueStudentCredentialBatch");
        expect(users).toContain("StudentCredentialBatchDialog");
        expect(users).not.toContain("syncStudentAccessCodes");
        expect(users).toContain("STUDENT_CREDENTIAL_STATUS_STORAGE_KEY");
        expect(users).toContain("localStorage.removeItem(STUDENT_CODES_STORAGE_KEY)");
        expect(users).toContain("issuedStudentCredentialIdsRef.current");
        expect(users).not.toContain("issueStudentStartCredential");
        expect(users).not.toContain("setSessionStudentCodes");
        expect(users).not.toContain("studentCodeRegistryRef.current");
        expect(source("src/app/student/dashboard/page.tsx")).toContain("clearStudentServerSession()");
    });

    it("uses only the organization-bound PBKDF2 credential row for student authentication", () => {
        const sessionAction = source("src/app/actions/studentSession.ts");
        const authAction = source("src/app/actions/studentAuth.ts");
        const batchGateway = source("src/lib/studentCredentialBatchGateway.server.ts");

        expect(authAction).toContain("resolveAuthorizedTeacherSessionCookie");
        expect(authAction).not.toContain("export async function loginStudentWithStartCode");
        expect(authAction).not.toContain("verifyStudentCredentials");
        expect(sessionAction).toContain("verifyStudentCredentials");
        expect(sessionAction).toContain("organizationId: workspaceId");
        expect(sessionAction).toContain("studentProfileId: profile.id");
        expect(sessionAction).not.toContain("metadataWithStudentAccessCode");
        expect(sessionAction).not.toContain("readStudentAccessCodeRecord");
        expect(sessionAction).not.toContain("verifyStudentAccessCode");
        expect(batchGateway).toContain("omr_issue_student_start_code_batch_v1");
        expect(authAction).not.toContain("omr_rotate_student_start_credential_v1");
        expect(authAction).toContain("issueStudentCredentialBatchWithGateway");
        expect(authAction).toContain("canTeacherRoleWrite");
        expect(authAction.indexOf("canTeacherRoleWrite"))
            .toBeLessThan(authAction.indexOf("const client = adminClient()"));
    });

    it("keeps server-issued codes inside the one-time batch dialog memory boundary", () => {
        const users = source("src/app/teacher/users/page.tsx");
        const dialog = source("src/components/StudentCredentialBatchDialog.tsx");

        expect(users).toContain("issueStudentCredentialBatch={issueStudentCredentialBatch}");
        expect(users).not.toContain("issueStudentStartCredential");
        expect(users).not.toContain("serverResult.startCode");
        expect(dialog).toContain("secureIdempotencyKey");
        expect(dialog).toContain('result.status === "outcome_unknown"');
        expect(dialog).toContain("result.credentials");
        expect(dialog).toContain("createStudentCredentialDownloadController");
        expect(dialog).not.toMatch(/localStorage|sessionStorage|clipboard|console\./);
    });

    it("derives the durable session id from the signed ticket for response-loss retries", () => {
        const action = source("src/app/actions/studentAttemptSession.ts");
        expect(action).toContain("ids: durableAttemptSessionIds(claims.ticketId)");
        expect(action).not.toContain("sessionId: `session_${randomUUID()}`");
    });

    it("keeps the server exam action primary and limits fallback to device-local data", () => {
        const client = source("src/lib/studentExamClient.ts");
        const solvePage = source("src/app/solve/[id]/page.tsx");

        expect(client).toContain('status === "degraded_local" || status === "not_found"');
        expect(client).toContain("readLocalExam: (examId: string) => Exam | null");
        expect(client).toContain("must never fetch the");
        expect(client).toContain("full exam (with answers) from Supabase");
        expect(solvePage).toContain("server: (examId, pin) => loadExamForSolving(");
        expect(solvePage).toContain("readLocalExam");
    });

    it("allows offline local exams in development but never downgrades a production gateway failure", () => {
        const action = source("src/app/actions/studentExam.ts");
        const solvePage = source("src/app/solve/[id]/page.tsx");

        expect(action).toContain('process.env.NODE_ENV === "production" ? "error" : "degraded_local"');
        expect(action.indexOf("const config = getSupabaseServerConfigFromEnv()"))
            .toBeLessThan(action.indexOf("const cookieStore = await cookies()"));
        expect(solvePage).toContain("session.studentId && (session.workspaceId || linkInviteToken)");
        expect(solvePage).toContain("readExamEntryInviteHandoff");
    });

    it("never signs a client-supplied student identity when production database config is missing", () => {
        const action = source("src/app/actions/studentSession.ts");
        const missingClient = action.slice(
            action.indexOf("if (!client) {", action.indexOf("export async function issueStudentSession")),
            action.indexOf("const inviteInput =", action.indexOf("export async function issueStudentSession")),
        );
        expect(missingClient).toContain('if (process.env.NODE_ENV === "production")');
        expect(missingClient).toContain('return { ok: false, status: "error" }');
        expect(missingClient.indexOf('process.env.NODE_ENV === "production"'))
            .toBeLessThan(missingClient.indexOf("clean(input.studentId)"));
    });

    it("signs a private problem PDF only after authorizing the owned review attempt", () => {
        const action = source("src/app/actions/studentExam.ts");
        const reviewStart = action.indexOf("export async function loadExamForReview");
        const reviewEnd = action.indexOf("export async function askAttemptQuestion", reviewStart);
        const reviewAction = action.slice(reviewStart, reviewEnd);

        expect(reviewAction).toContain("createStudentProblemPdfSignedUrlWithGateway");
        expect(reviewAction).toContain("isRemoteAssetStoredDataRef(problemRef)");
        expect(reviewAction).toContain("pdfData: signed.signedUrl");
        expect(reviewAction.indexOf("const match = await ownAttempt"))
            .toBeLessThan(reviewAction.indexOf("const signed = await createStudentProblemPdfSignedUrlWithGateway"));
    });

    it("signs a private problem PDF only after solve access is allowed", () => {
        const action = source("src/app/actions/studentExam.ts");
        const solveStart = action.indexOf("export async function loadExamForSolving");
        const solveEnd = action.indexOf("export async function submitAttempt", solveStart);
        const solveAction = action.slice(solveStart, solveEnd);

        expect(solveAction).toContain("createStudentProblemPdfSignedUrlWithGateway");
        expect(solveAction).toContain("pdfData: signed.signedUrl");
        expect(solveAction.indexOf('if (access !== "allowed") return { status: access }'))
            .toBeLessThan(solveAction.indexOf("createStudentProblemPdfSignedUrlWithGateway"));
    });

    it("rejects cross-origin submissions before resolving a database gateway", () => {
        const action = source("src/app/actions/studentExam.ts");
        const submitStart = action.indexOf("export async function submitAttempt");
        const submitEnd = action.indexOf("export async function listMyAssignments", submitStart);
        const submitAction = action.slice(submitStart, submitEnd);

        expect(action).toContain('import { cookies, headers } from "next/headers"');
        expect(action).toContain("isSameOriginServerActionRequest");
        expect(submitAction).toContain("const headerStore = await headers()");
        expect(submitAction).toContain('if (!headerStore.get("origin") || !isSameOriginServerActionRequest(headerStore)) return { status: "error" }');
        expect(submitAction.indexOf("isSameOriginServerActionRequest"))
            .toBeLessThan(submitAction.indexOf("resolveCtx()"));
    });

    it("fails the unsigned direct submit path closed for targeted exams before any attempt write", () => {
        const action = source("src/app/actions/studentExam.ts");
        const submitStart = action.indexOf("export async function submitAttempt");
        const submitEnd = action.indexOf("export async function listMyAssignments", submitStart);
        const submitAction = action.slice(submitStart, submitEnd);
        const targetedGuard = submitAction.indexOf('exam.accessConfig?.type === "targeted"');
        expect(targetedGuard).toBeGreaterThanOrEqual(0);
        expect(submitAction.slice(targetedGuard, targetedGuard + 250)).toContain('return { status: "denied" }');
        expect(targetedGuard).toBeLessThan(submitAction.indexOf("evaluateDurableGatedAccess"));
        expect(targetedGuard).toBeLessThan(submitAction.indexOf("saveSessionAttemptAtomically"));
    });
});
