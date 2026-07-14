"use server";

import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { parseSignedTeacherSessionCookie, TEACHER_SERVER_SESSION_COOKIE } from "@/lib/teacherServerSession";
import {
    createServerPlanStoreFromEnv,
    evaluateServerPlanQuota,
    planLimit,
    readServerPlanUsage,
    resolveServerPlanAccess,
    seoulBillingPeriod,
    serverPlanUnavailableMessage,
    type ServerPlanAccess,
    type ServerPlanQuotaResult,
    type ServerPlanUsage,
} from "@/lib/serverPlan";
import { hasPlanEntitlement, type PlanEntitlementKey, type PlanLimitMetric } from "@/utils/plans";

export interface ServerPlanSnapshot extends ServerPlanAccess {
    limits: Record<PlanLimitMetric, number>;
    usage?: ServerPlanUsage;
}

export interface PremiumMutationGuardResult {
    ok: boolean;
    access: ServerPlanAccess;
    quota?: ServerPlanQuotaResult;
    reservationKey?: string;
    error?: string;
}

async function signedTeacherSession() {
    return parseSignedTeacherSessionCookie(
        (await cookies()).get(TEACHER_SERVER_SESSION_COOKIE)?.value,
    );
}

async function accessAndStore() {
    const store = createServerPlanStoreFromEnv();
    const access = await resolveServerPlanAccess(await signedTeacherSession(), { store });
    return { access, store };
}

function limitsFor(access: ServerPlanAccess): Record<PlanLimitMetric, number> {
    return {
        exams: planLimit(access.plan, "exams"),
        students: planLimit(access.plan, "students"),
        aiRecognition: planLimit(access.plan, "aiRecognition"),
    };
}

/** Authoritative server snapshot for client display. localStorage is never consulted. */
export async function getServerPlanSnapshot(): Promise<ServerPlanSnapshot> {
    const { access, store } = await accessAndStore();
    const snapshot: ServerPlanSnapshot = { ...access, limits: limitsFor(access) };
    if (!access.authoritative || !store) return snapshot;
    try {
        return { ...snapshot, usage: await readServerPlanUsage(access, store) };
    } catch (error) {
        return {
            ...snapshot,
            authoritative: false,
            source: "unavailable",
            error: error instanceof Error ? error.message : "서버 사용량을 확인하지 못했습니다.",
        };
    }
}

async function reserveMetric(
    metric: "exams" | "aiRecognition",
    resourceKey: string,
    attempted = 1,
): Promise<PremiumMutationGuardResult> {
    const { access, store } = await accessAndStore();
    if (!access.authoritative || !access.organizationId || !store) {
        return { ok: false, access, error: serverPlanUnavailableMessage(access) };
    }
    const limit = planLimit(access.plan, metric);
    if (!Number.isFinite(limit)) {
        return { ok: true, access, quota: evaluateServerPlanQuota(access.plan, metric, 0, attempted) };
    }
    try {
        const period = seoulBillingPeriod();
        const observedUsed = await store.readUsage(access.organizationId, metric, period);
        const reserved = await store.reserveUsage({
            organizationId: access.organizationId,
            metric,
            period,
            resourceKey,
            attempted,
            observedUsed,
            limit,
        });
        const quota = {
            ...evaluateServerPlanQuota(access.plan, metric, reserved.used, 0),
            attempted,
            idempotent: reserved.idempotent,
        };
        return reserved.allowed
            ? { ok: true, access, quota: { ...quota, allowed: true }, reservationKey: resourceKey }
            : { ok: false, access, quota: { ...quota, allowed: false }, error: "플랜 사용량 한도에 도달했습니다." };
    } catch (error) {
        return {
            ok: false,
            access: { ...access, authoritative: false, source: "unavailable" },
            error: error instanceof Error ? error.message : "서버 사용량을 확인하지 못했습니다.",
        };
    }
}

async function releaseMetric(
    metric: "exams" | "aiRecognition",
    resourceKey: string,
): Promise<{ ok: boolean; released: boolean; error?: string }> {
    const { access, store } = await accessAndStore();
    if (!access.authoritative || !access.organizationId || !store) {
        return { ok: false, released: false, error: serverPlanUnavailableMessage(access) };
    }
    if (!resourceKey.trim()) return { ok: false, released: false, error: "사용량 예약 키가 없습니다." };
    if (!Number.isFinite(planLimit(access.plan, metric))) return { ok: true, released: false };
    try {
        const result = await store.releaseUsage({
            organizationId: access.organizationId,
            metric,
            period: seoulBillingPeriod(),
            resourceKey,
        });
        return { ok: true, released: result.released };
    } catch (error) {
        return {
            ok: false,
            released: false,
            error: error instanceof Error ? error.message : "사용량 예약을 해제하지 못했습니다.",
        };
    }
}

/** Final server-side guard for a new exam. The exam id makes retries idempotent. */
export async function authorizeExamCreation(examId: string): Promise<PremiumMutationGuardResult> {
    const cleanId = typeof examId === "string" ? examId.trim() : "";
    if (!cleanId || cleanId.length > 200) {
        const access = await resolveServerPlanAccess(await signedTeacherSession(), { store: null });
        return { ok: false, access, error: "시험 식별자가 올바르지 않습니다." };
    }
    return reserveMetric("exams", `exam:${cleanId}`, 1);
}

export async function releaseExamCreationAuthorization(examId: string) {
    const cleanId = typeof examId === "string" ? examId.trim() : "";
    return releaseMetric("exams", cleanId ? `exam:${cleanId}` : "");
}

/**
 * Final server-side guard for roster size. The caller sends stable student ids,
 * never a trusted count; the server deduplicates and atomically syncs reservations.
 */
export async function authorizeRosterStudentSet(studentIds: string[]): Promise<PremiumMutationGuardResult> {
    const { access, store } = await accessAndStore();
    if (!access.authoritative || !access.organizationId || !store) {
        return { ok: false, access, error: serverPlanUnavailableMessage(access) };
    }
    if (!Array.isArray(studentIds) || studentIds.length > 20_000) {
        return { ok: false, access, error: "학생 명단 요청이 올바르지 않습니다." };
    }
    const resourceKeys = [...new Set(studentIds
        .filter((id): id is string => typeof id === "string")
        .map(id => id.trim())
        .filter(Boolean))];
    const limit = planLimit(access.plan, "students");
    if (!Number.isFinite(limit)) {
        return { ok: true, access, quota: evaluateServerPlanQuota(access.plan, "students", resourceKeys.length, 0) };
    }
    if (resourceKeys.length > limit) {
        return {
            ok: false,
            access,
            quota: { ...evaluateServerPlanQuota(access.plan, "students", resourceKeys.length, 0), allowed: false },
            error: `현재 플랜은 학생 ${limit}명까지 등록할 수 있습니다.`,
        };
    }
    try {
        const observedUsed = await store.readUsage(access.organizationId, "students", seoulBillingPeriod());
        const synced = await store.syncStudentUsage({
            organizationId: access.organizationId,
            resourceKeys,
            observedUsed,
            limit,
        });
        const quota = {
            ...evaluateServerPlanQuota(access.plan, "students", synced.used, 0),
            allowed: synced.allowed,
        };
        return synced.allowed
            ? { ok: true, access, quota }
            : { ok: false, access, quota, error: `현재 플랜은 학생 ${limit}명까지 등록할 수 있습니다.` };
    } catch (error) {
        return {
            ok: false,
            access: { ...access, authoritative: false, source: "unavailable" },
            error: error instanceof Error ? error.message : "학생 사용량을 확인하지 못했습니다.",
        };
    }
}

export async function authorizePlanEntitlement(entitlement: PlanEntitlementKey): Promise<PremiumMutationGuardResult> {
    const { access } = await accessAndStore();
    if (!access.authoritative) {
        return { ok: false, access, error: serverPlanUnavailableMessage(access) };
    }
    if (!hasPlanEntitlement(access.plan, entitlement)) {
        return { ok: false, access, error: "현재 서버 플랜에서 사용할 수 없는 기능입니다." };
    }
    return { ok: true, access };
}

export async function authorizeAdvancedQuestionDesign(): Promise<PremiumMutationGuardResult> {
    return authorizePlanEntitlement("advancedQuestionDesign");
}

/** Shared platform AI key quota. Personal API keys must not call this path. */
export async function authorizeSharedAiRecognition(requestId: string = randomUUID()): Promise<PremiumMutationGuardResult> {
    return reserveMetric("aiRecognition", `ai:${requestId}`, 1);
}

export async function releaseSharedAiRecognition(requestId: string) {
    const cleanId = typeof requestId === "string" ? requestId.trim() : "";
    return releaseMetric("aiRecognition", cleanId ? `ai:${cleanId}` : "");
}
