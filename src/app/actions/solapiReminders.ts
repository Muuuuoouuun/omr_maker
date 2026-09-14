"use server";

import { cookies, headers } from "next/headers";
import { createSupabaseAdminClient, getSupabaseServerConfigFromEnv } from "@/lib/supabaseServerAdmin";
import { isSameOriginServerActionRequest } from "@/lib/serverActionSecurity";
import { resolveAuthorizedTeacherSessionCookie, TEACHER_SERVER_SESSION_COOKIE } from "@/lib/teacherServerSession";
import { isTeacherMutationAuthorized } from "@/lib/teacherMutationAuthorization";
import { workspaceContextFromTeacherSession } from "@/lib/workspaceContext";
import { solapiConfig, solapiReadiness } from "@/lib/solapiProvider.server";
import { normalizeReminderPhone, reminderContent, validReminderSettings, type ReminderCandidate, type ReminderDashboard, type ReminderReadiness, type ReminderSettings } from "@/lib/solapiReminders";

type Failure = { status: "error"; error: string };
const failureMessages: Record<string, string> = {
    unauthorized: "교사 계정으로 다시 로그인해주세요.",
    plan_denied: "자동 알림은 Pro 또는 Academy 플랜에서 사용할 수 있습니다.",
    not_found: "시험 또는 학생을 찾을 수 없습니다. 목록을 새로고침해주세요.",
    invalid_request: "연락처와 알림 시간 설정을 확인해주세요.",
    capacity_exceeded: "학생 1,000명까지 알림 연락처를 관리할 수 있습니다.",
};
function failure(status?: string): Failure {
    return { status: "error", error: failureMessages[status || ""] || "알림 서버에 연결할 수 없습니다. 서버 연결 및 알림 데이터베이스 설정을 확인해주세요." };
}

async function context() {
    if (!isSameOriginServerActionRequest(await headers())) return null;
    const session = await resolveAuthorizedTeacherSessionCookie((await cookies()).get(TEACHER_SERVER_SESSION_COOKIE)?.value);
    if (!session || !isTeacherMutationAuthorized(session)) return null;
    const database = getSupabaseServerConfigFromEnv();
    if (!database) throw new Error("database_unavailable");
    const workspace = workspaceContextFromTeacherSession(session);
    return {
        client: createSupabaseAdminClient(database), workspace,
        identity: {
            p_session_authority: workspace.sessionAuthority, p_account_id: workspace.accountId,
            p_session_generation: workspace.accountSessionGeneration, p_organization_id: workspace.organizationId,
            p_actor_user_id: workspace.actorUserId,
        },
    };
}

async function command(value: Record<string, unknown>): Promise<Record<string, unknown>> {
    const gateway = await context();
    if (!gateway) return { status: "unauthorized" };
    const config = solapiConfig();
    if (value.op === "save_settings" && (value.settings as ReminderSettings)?.enabled && config.mode === "live") {
        const ready = solapiReadiness(config);
        const settings = value.settings as ReminderSettings;
        if (config.organizationId !== gateway.workspace.organizationId || !(settings.channel === "kakao" ? ready.kakaoReady : ready.smsReady)) {
            return { status: "configuration_required" };
        }
    }
    const result = await gateway.client.rpc("omr_manage_reminders_v1", { ...gateway.identity, p_command: value }) as { data?: Record<string, unknown>; error: unknown };
    if (result.error || !result.data) return { status: "service_unavailable" };
    const readiness = solapiReadiness(config);
    if (config.organizationId !== gateway.workspace.organizationId) {
        readiness.kakaoReady = false; readiness.smsReady = false;
        if (!readiness.missing.includes("OMR_REMINDER_ORGANIZATION_ID")) readiness.missing.push("OMR_REMINDER_ORGANIZATION_ID");
    }
    return { ...result.data, readiness };
}

export async function loadSolapiReminderDashboard(): Promise<{ status: "loaded"; dashboard: ReminderDashboard; readiness: ReminderReadiness } | Failure> {
    try {
        const result = await command({ op: "load" });
        if (result.status !== "loaded") return failure(String(result.status));
        return { status: "loaded", dashboard: result.dashboard as ReminderDashboard, readiness: result.readiness as ReminderReadiness };
    } catch { return failure(); }
}

export async function saveSolapiReminderSettings(settings: ReminderSettings): Promise<{ status: "saved" } | Failure> {
    if (!validReminderSettings(settings)) return failure("invalid_request");
    try {
        const result = await command({ op: "save_settings", settings });
        if (result.status === "configuration_required") return { status: "error", error: "이 교실의 솔라피 연결을 먼저 완료해주세요. 현재 설정으로는 실제 발송할 수 없습니다." };
        return result.status === "saved" ? { status: "saved" } : failure(String(result.status));
    } catch { return failure(); }
}

export async function saveSolapiReminderContact(input: { studentId: string; phone: string; enabled: boolean }): Promise<{ status: "saved" } | Failure> {
    if (!input || typeof input.studentId !== "string" || !input.studentId || input.studentId.length > 256
        || typeof input.phone !== "string" || input.phone.length > 40 || typeof input.enabled !== "boolean") return failure("invalid_request");
    const phone = normalizeReminderPhone(input.phone);
    if (!phone) return { status: "error", error: "010으로 시작하는 휴대전화 번호를 입력해주세요." };
    try {
        const result = await command({ op: "save_contact", studentId: input.studentId, enabled: input.enabled, phone });
        return result.status === "saved" ? { status: "saved" } : failure(String(result.status));
    } catch { return failure(); }
}

export async function previewSolapiReminders(examId: string): Promise<{
    status: "loaded"; total: number;
    candidates: { studentId: string; studentName: string; phone: string; kind: string; dueAt: string; text: string }[];
} | Failure> {
    if (typeof examId !== "string" || !examId || examId.length > 256) return failure("invalid_request");
    try {
        const result = await command({ op: "preview", examId });
        if (result.status !== "loaded") return failure(String(result.status));
        const config = solapiConfig();
        return {
            status: "loaded", total: Number(result.total),
            candidates: (result.candidates as ReminderCandidate[]).map(candidate => ({
                studentId: candidate.studentId, studentName: candidate.studentName, phone: `010-****-${candidate.phone.slice(-4)}`,
                kind: candidate.kind, dueAt: candidate.dueAt,
                text: reminderContent(candidate, config.origin || "https://example.invalid").text,
            })),
        };
    } catch { return failure(); }
}
