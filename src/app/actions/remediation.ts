"use server";

import { cookies, headers } from "next/headers";
import { isSameOriginServerActionRequest } from "@/lib/serverActionSecurity";
import { resolveAuthorizedTeacherSessionCookie, TEACHER_SERVER_SESSION_COOKIE } from "@/lib/teacherServerSession";
import { createSupabaseAdminClient, getSupabaseServerConfigFromEnv } from "@/lib/supabaseServerAdmin";
import { workspaceContextFromTeacherSession } from "@/lib/workspaceContext";
import { parseRemediationDashboard, validRemediationCommand, type RemediationCommand, type RemediationDashboard } from "@/lib/remediation";
import { parseStudentRemediation, type StudentRemediationCase } from "@/lib/remediation";
import { resolveAuthorizedStudentSessionCookie, STUDENT_SERVER_SESSION_COOKIE, type StudentSessionValidationClient } from "@/lib/studentServerSession";
import type { RemediationRetakeResult } from "@/lib/remediationRetake";
import { resolveRemediationRetakeWithGateway } from "@/lib/remediationRetake.server";
import type { StudentExamGatewayClient } from "@/lib/studentExamServerGateway";

type Failure = { status: "error"; error: string; code: string };
const messages: Record<string, string> = {
    unauthorized: "담당 반과 계정 권한을 확인해주세요.", plan_denied: "새 보강 배정과 확인 처리는 Pro 이상에서 사용할 수 있습니다.",
    invalid_request: "대상 학생, 기한과 확인 내용을 확인해주세요.", conflict: "다른 작업이나 새 제출로 상태가 바뀌었습니다. 새로고침 후 다시 확인해주세요.",
    not_ready: "아직 수정하지 않은 오답이 있습니다. 재시험 결과를 확인해주세요.", handoff: "반 이동 또는 재원 상태가 바뀌었습니다. 학생과 담당 반을 먼저 확인해주세요.",
};
const fail = (code = "service_unavailable"): Failure => ({ status: "error", code: Object.hasOwn(messages, code) ? code : "service_unavailable", error: messages[code] || "보강 정보를 불러오지 못했습니다. 서버 연결과 보강 관리 설정을 확인해주세요." });

export async function manageRemediation(input: RemediationCommand): Promise<{ status: "loaded"; dashboard: RemediationDashboard } | { status: "saved" } | Failure> {
    if (!validRemediationCommand(input)) return fail("invalid_request");
    try {
        if (!isSameOriginServerActionRequest(await headers())) return fail("unauthorized");
        const session = await resolveAuthorizedTeacherSessionCookie((await cookies()).get(TEACHER_SERVER_SESSION_COOKIE)?.value);
        if (!session || !session.memberRole || !["owner", "admin", "teacher", "assistant"].includes(session.memberRole)) return fail("unauthorized");
        if (input.op !== "load" && session.memberRole === "assistant") return fail("unauthorized");
        const config = getSupabaseServerConfigFromEnv();
        if (!config) return fail();
        const w = workspaceContextFromTeacherSession(session);
        const result = await createSupabaseAdminClient(config).rpc("omr_manage_remediation_v1", {
            p_session_authority: w.sessionAuthority, p_account_id: w.accountId,
            p_session_generation: w.accountSessionGeneration, p_organization_id: w.organizationId,
            p_actor_user_id: w.actorUserId, p_command: input,
        }) as { data: Record<string, unknown> | null; error: unknown };
        if (result.error || !result.data) return fail();
        if (input.op === "load" && result.data.status === "loaded") {
            const dashboard = parseRemediationDashboard(result.data.dashboard);
            return dashboard ? { status: "loaded", dashboard } : fail();
        }
        return input.op !== "load" && result.data.status === "saved" ? { status: "saved" } : fail(String(result.data.status));
    } catch { return fail(); }
}

export async function loadStudentRemediation(): Promise<{ status: "loaded"; cases: StudentRemediationCase[] } | Failure> {
    try {
        if (!isSameOriginServerActionRequest(await headers())) return fail("unauthorized");
        const config = getSupabaseServerConfigFromEnv();
        if (!config) return fail();
        const admin = createSupabaseAdminClient(config) as unknown as StudentSessionValidationClient;
        const validation = await resolveAuthorizedStudentSessionCookie((await cookies()).get(STUDENT_SERVER_SESSION_COOKIE)?.value, admin);
        if (validation.status !== "active") return fail(validation.status === "service_unavailable" ? undefined : "unauthorized");
        const identity = validation.identity;
        if (identity.identityType !== "registered" || !identity.organizationId || !identity.studentId) return fail("unauthorized");
        const result = await admin.rpc("omr_student_remediation_v1", { p_org: identity.organizationId, p_student: identity.studentId });
        const cases = result.error ? null : parseStudentRemediation(result.data);
        return cases ? { status: "loaded", cases } : fail();
    } catch { return fail(); }
}

export async function resolveStudentRemediationRetake(sourceAttemptId: string): Promise<RemediationRetakeResult> {
    if (typeof sourceAttemptId !== "string" || !sourceAttemptId || sourceAttemptId.length > 256
        || sourceAttemptId.trim() !== sourceAttemptId) return { status: "blocked", code: "unavailable" };
    try {
        if (!isSameOriginServerActionRequest(await headers())) return { status: "blocked", code: "unauthorized" };
        const config = getSupabaseServerConfigFromEnv();
        if (!config) return { status: "blocked", code: "service_unavailable" };
        const admin = createSupabaseAdminClient(config) as unknown as StudentSessionValidationClient & StudentExamGatewayClient;
        const validation = await resolveAuthorizedStudentSessionCookie((await cookies()).get(STUDENT_SERVER_SESSION_COOKIE)?.value, admin);
        if (validation.status !== "active") return { status: "blocked", code: validation.status === "service_unavailable" ? "service_unavailable" : "unauthorized" };
        return await resolveRemediationRetakeWithGateway(admin, validation.identity, sourceAttemptId);
    } catch { return { status: "blocked", code: "service_unavailable" }; }
}
