"use server";

import { cookies, headers } from "next/headers";
import { createSupabaseAdminClient, getSupabaseServerConfigFromEnv } from "@/lib/supabaseServerAdmin";
import {
    saveKakaoCandidateReviewWithGateway,
    saveKakaoSimulationDispatchWithGateway,
    type KakaoReminderGatewayClient,
    type KakaoReminderMutationResult,
} from "@/lib/kakaoReminderGateway.server";
import { isSameOriginServerActionRequest } from "@/lib/serverActionSecurity";
import { resolveAuthorizedTeacherSessionCookie, TEACHER_SERVER_SESSION_COOKIE } from "@/lib/teacherServerSession";
import { isTeacherMutationAuthorized } from "@/lib/teacherMutationAuthorization";
import { workspaceContextFromTeacherSession } from "@/lib/workspaceContext";

type FailureStatus = Exclude<KakaoReminderMutationResult["status"], "saved"> | "local_only";
type Result = { status: "saved" } | { status: FailureStatus; error?: string };
type Context = {
    client: KakaoReminderGatewayClient;
    workspace: ReturnType<typeof workspaceContextFromTeacherSession>;
} | { status: "local_only" | "unauthorized" | "service_unavailable" };

function stableFailure(status: FailureStatus): Result {
    if (status === "local_only" || status === "unauthorized") return { status };
    if (status === "plan_denied") {
        return { status, error: "현재 서버 플랜에서 카카오 리마인더를 사용할 수 없습니다." };
    }
    if (status === "legacy_reconciliation_required") {
        return { status, error: "기존 카카오 리마인더 기록의 운영자 조정이 필요합니다." };
    }
    if (status === "invalid_request") {
        return { status, error: "카카오 리마인더 저장 요청이 올바르지 않습니다." };
    }
    if (status === "scope_conflict") {
        return { status, error: "카카오 리마인더 식별자 범위가 기존 기록과 충돌합니다." };
    }
    if (status === "not_found") {
        return { status, error: "카카오 리마인더 검토 기록을 찾을 수 없습니다." };
    }
    if (status === "invalid_transition") {
        return { status, error: "카카오 리마인더 상태 전이를 적용할 수 없습니다." };
    }
    return { status: "service_unavailable", error: "카카오 리마인더 서버 저장을 사용할 수 없습니다." };
}

async function context(): Promise<Context> {
    const config = getSupabaseServerConfigFromEnv();
    if (!config) return { status: process.env.NODE_ENV === "production" ? "service_unavailable" as const : "local_only" as const };
    const headerStore = await headers();
    if (!isSameOriginServerActionRequest(headerStore)) return { status: "unauthorized" as const };
    const session = await resolveAuthorizedTeacherSessionCookie((await cookies()).get(TEACHER_SERVER_SESSION_COOKIE)?.value);
    if (!session) return { status: "unauthorized" as const };
    if (!isTeacherMutationAuthorized(session)) return { status: "unauthorized" as const };
    return {
        client: createSupabaseAdminClient(config) as unknown as KakaoReminderGatewayClient,
        workspace: workspaceContextFromTeacherSession(session),
    };
}

export async function saveTeacherKakaoReview(row: Record<string, unknown>): Promise<Result> {
    try {
        const gateway = await context();
        if ("status" in gateway) return gateway;
        const result = await saveKakaoCandidateReviewWithGateway(gateway.client, row, gateway.workspace);
        return result.status === "saved" ? result : stableFailure(result.status);
    } catch {
        return stableFailure("service_unavailable");
    }
}

export async function saveTeacherKakaoDispatch(row: Record<string, unknown>): Promise<Result> {
    try {
        const gateway = await context();
        if ("status" in gateway) return gateway;
        const result = await saveKakaoSimulationDispatchWithGateway(gateway.client, row, gateway.workspace);
        return result.status === "saved" ? result : stableFailure(result.status);
    } catch {
        return stableFailure("service_unavailable");
    }
}
