import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { TeacherSession } from "@/lib/teacherSession";
import { isTeacherSessionActive } from "@/lib/teacherSession";
import { getSupabaseServerConfigFromEnv } from "@/lib/supabaseServerAdmin";
import { workspaceContextFromTeacherSession } from "@/lib/workspaceContext";
import type { PlanKey } from "@/types/omr";
import { normalizePlan, PLAN_BY_KEY, type PlanLimitMetric } from "@/utils/plans";

type Env = Record<string, string | undefined>;

export type ServerPlanSource = "supabase" | "dev-simulation" | "unavailable";

export interface ServerPlanAccess {
    authenticated: boolean;
    authoritative: boolean;
    organizationId?: string;
    actorUserId?: string;
    plan: PlanKey;
    source: ServerPlanSource;
    error?: string;
}

export interface ServerPlanUsage {
    exams: number;
    students: number;
    aiRecognition: number;
}

export interface ServerPlanQuotaResult {
    allowed: boolean;
    metric: PlanLimitMetric;
    plan: PlanKey;
    used: number;
    attempted: number;
    limit: number;
    remaining: number;
    idempotent?: boolean;
}

export interface ServerPlanStore {
    readonly source: Exclude<ServerPlanSource, "unavailable">;
    readPlan(organizationId: string): Promise<PlanKey | null>;
    readUsage(organizationId: string, metric: PlanLimitMetric, period: BillingPeriod): Promise<number>;
    reserveUsage(input: {
        organizationId: string;
        metric: Exclude<PlanLimitMetric, "students">;
        period: BillingPeriod;
        resourceKey: string;
        attempted: number;
        observedUsed: number;
        limit: number;
    }): Promise<{ allowed: boolean; used: number; idempotent?: boolean }>;
    releaseUsage(input: {
        organizationId: string;
        metric: Exclude<PlanLimitMetric, "students">;
        period: BillingPeriod;
        resourceKey: string;
    }): Promise<{ released: boolean; used: number }>;
    syncStudentUsage(input: {
        organizationId: string;
        resourceKeys: string[];
        observedUsed: number;
        limit: number;
    }): Promise<{ allowed: boolean; used: number }>;
}

export interface BillingPeriod {
    /** YYYY-MM-01 in the product billing timezone (Asia/Seoul). */
    key: string;
    /** Inclusive UTC instant for querying timestamptz rows. */
    startsAt: string;
    /** Exclusive UTC instant for querying timestamptz rows. */
    endsAt: string;
}

const SEOUL_OFFSET_MS = 9 * 60 * 60 * 1000;
const STUDENT_USAGE_PERIOD: BillingPeriod = {
    key: "1970-01-01",
    startsAt: "1970-01-01T00:00:00.000Z",
    endsAt: "9999-12-31T23:59:59.999Z",
};

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "서버 플랜을 확인하지 못했습니다.";
}

function enabled(value: unknown): boolean {
    return ["1", "true", "yes", "on"].includes(clean(value).toLowerCase());
}

export function seoulBillingPeriod(now = new Date()): BillingPeriod {
    const shifted = new Date(now.getTime() + SEOUL_OFFSET_MS);
    const year = shifted.getUTCFullYear();
    const month = shifted.getUTCMonth();
    const startUtcMs = Date.UTC(year, month, 1) - SEOUL_OFFSET_MS;
    const endUtcMs = Date.UTC(year, month + 1, 1) - SEOUL_OFFSET_MS;
    return {
        key: `${year}-${String(month + 1).padStart(2, "0")}-01`,
        startsAt: new Date(startUtcMs).toISOString(),
        endsAt: new Date(endUtcMs).toISOString(),
    };
}

export function planLimit(plan: PlanKey, metric: PlanLimitMetric): number {
    return PLAN_BY_KEY[plan].limits[metric];
}

export function evaluateServerPlanQuota(
    plan: PlanKey,
    metric: PlanLimitMetric,
    used: number,
    attempted = 1,
): ServerPlanQuotaResult {
    const safeUsed = Number.isFinite(used) ? Math.max(0, Math.floor(used)) : 0;
    const safeAttempted = Number.isFinite(attempted) ? Math.max(0, Math.floor(attempted)) : 0;
    const limit = planLimit(plan, metric);
    const allowed = !Number.isFinite(limit) || safeUsed + safeAttempted <= limit;
    return {
        allowed,
        metric,
        plan,
        used: safeUsed,
        attempted: safeAttempted,
        limit,
        remaining: Number.isFinite(limit) ? Math.max(0, limit - safeUsed) : Infinity,
    };
}

interface SupabaseRpcResult {
    data: unknown;
    error: { message?: string } | null;
}

type RpcClient = SupabaseClient & {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<SupabaseRpcResult>;
};

function firstRpcRow(value: unknown): Record<string, unknown> | null {
    if (Array.isArray(value)) {
        const row = value[0];
        return row && typeof row === "object" ? row as Record<string, unknown> : null;
    }
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function countValue(value: number | null): number {
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function createSupabaseServerPlanStore(client: SupabaseClient): ServerPlanStore {
    const rpcClient = client as RpcClient;
    return {
        source: "supabase",
        async readPlan(organizationId) {
            const { data, error } = await client.from("omr_organizations")
                .select("plan")
                .eq("id", organizationId)
                .maybeSingle();
            if (error) throw new Error(error.message || "조직 플랜 조회에 실패했습니다.");
            if (!data) return null;
            return normalizePlan((data as { plan?: unknown }).plan);
        },
        async readUsage(organizationId, metric, period) {
            if (metric === "exams") {
                const { count, error } = await client.from("omr_exams")
                    .select("id", { count: "exact", head: true })
                    .eq("organization_id", organizationId)
                    .gte("created_at", period.startsAt)
                    .lt("created_at", period.endsAt);
                if (error) throw new Error(error.message || "시험 사용량 조회에 실패했습니다.");
                return countValue(count);
            }
            if (metric === "students") {
                const { count, error } = await client.from("omr_student_profiles")
                    .select("id", { count: "exact", head: true })
                    .eq("organization_id", organizationId)
                    .in("status", ["invited", "active", "inactive"]);
                if (error) throw new Error(error.message || "학생 사용량 조회에 실패했습니다.");
                return countValue(count);
            }
            const { data, error } = await client.from("omr_plan_usage")
                .select("used")
                .eq("organization_id", organizationId)
                .eq("metric", metric)
                .eq("period_start", period.key)
                .maybeSingle();
            if (error) throw new Error(error.message || "AI 사용량 조회에 실패했습니다.");
            return countValue(data ? Number((data as { used?: unknown }).used) : 0);
        },
        async reserveUsage(input) {
            const { data, error } = await rpcClient.rpc("omr_reserve_plan_usage", {
                p_organization_id: input.organizationId,
                p_metric: input.metric,
                p_period_start: input.period.key,
                p_resource_key: input.resourceKey,
                p_amount: input.attempted,
                p_observed_used: input.observedUsed,
                p_limit: input.limit,
            });
            if (error) throw new Error(error.message || "사용량 예약에 실패했습니다.");
            const row = firstRpcRow(data);
            if (!row || typeof row.allowed !== "boolean") throw new Error("사용량 예약 응답이 올바르지 않습니다.");
            return {
                allowed: row.allowed,
                used: countValue(Number(row.used)),
                idempotent: row.idempotent === true,
            };
        },
        async releaseUsage(input) {
            const { data, error } = await rpcClient.rpc("omr_release_plan_usage", {
                p_organization_id: input.organizationId,
                p_metric: input.metric,
                p_period_start: input.period.key,
                p_resource_key: input.resourceKey,
            });
            if (error) throw new Error(error.message || "사용량 예약 해제에 실패했습니다.");
            const row = firstRpcRow(data);
            if (!row || typeof row.released !== "boolean") throw new Error("사용량 예약 해제 응답이 올바르지 않습니다.");
            return { released: row.released, used: countValue(Number(row.used)) };
        },
        async syncStudentUsage(input) {
            const { data, error } = await rpcClient.rpc("omr_sync_student_plan_usage", {
                p_organization_id: input.organizationId,
                p_resource_keys: input.resourceKeys,
                p_observed_used: input.observedUsed,
                p_limit: input.limit,
            });
            if (error) throw new Error(error.message || "학생 사용량 동기화에 실패했습니다.");
            const row = firstRpcRow(data);
            if (!row || typeof row.allowed !== "boolean") throw new Error("학생 사용량 응답이 올바르지 않습니다.");
            return { allowed: row.allowed, used: countValue(Number(row.used)) };
        },
    };
}

interface DevUsageState {
    used: number;
    reservations: Set<string>;
}

const devUsage = new Map<string, DevUsageState>();

function devUsageKey(organizationId: string, metric: PlanLimitMetric, period: string): string {
    return `${organizationId}:${metric}:${period}`;
}

function devPlan(env: Env): PlanKey {
    return normalizePlan(env.OMR_DEV_PLAN || env.TEACHER_PLAN) || "free";
}

export function createDevServerPlanStore(env: Env = process.env): ServerPlanStore {
    return {
        source: "dev-simulation",
        async readPlan() {
            return devPlan(env);
        },
        async readUsage(organizationId, metric, period) {
            const key = devUsageKey(organizationId, metric, metric === "students" ? STUDENT_USAGE_PERIOD.key : period.key);
            return devUsage.get(key)?.used || 0;
        },
        async reserveUsage(input) {
            const key = devUsageKey(input.organizationId, input.metric, input.period.key);
            const state = devUsage.get(key) || { used: 0, reservations: new Set<string>() };
            state.used = Math.max(state.used, input.observedUsed);
            if (state.reservations.has(input.resourceKey)) {
                devUsage.set(key, state);
                return { allowed: true, used: state.used, idempotent: true };
            }
            if (Number.isFinite(input.limit) && state.used + input.attempted > input.limit) {
                devUsage.set(key, state);
                return { allowed: false, used: state.used };
            }
            state.used += input.attempted;
            state.reservations.add(input.resourceKey);
            devUsage.set(key, state);
            return { allowed: true, used: state.used };
        },
        async releaseUsage(input) {
            const key = devUsageKey(input.organizationId, input.metric, input.period.key);
            const state = devUsage.get(key) || { used: 0, reservations: new Set<string>() };
            if (!state.reservations.delete(input.resourceKey)) return { released: false, used: state.used };
            state.used = Math.max(0, state.used - 1);
            devUsage.set(key, state);
            return { released: true, used: state.used };
        },
        async syncStudentUsage(input) {
            const key = devUsageKey(input.organizationId, "students", STUDENT_USAGE_PERIOD.key);
            const requested = new Set(input.resourceKeys);
            const used = Math.max(input.observedUsed, requested.size);
            if (Number.isFinite(input.limit) && used > input.limit) return { allowed: false, used };
            devUsage.set(key, { used: requested.size, reservations: requested });
            return { allowed: true, used: requested.size };
        },
    };
}

export function createServerPlanStoreFromEnv(env: Env = process.env): ServerPlanStore | null {
    const config = getSupabaseServerConfigFromEnv(env);
    if (config) {
        return createSupabaseServerPlanStore(createClient(config.url, config.serviceRoleKey, {
            auth: { persistSession: false, autoRefreshToken: false },
        }));
    }
    // Simulation is deliberately opt-in and can never be activated in production.
    if (env.NODE_ENV !== "production" && enabled(env.OMR_PLAN_DEV_SIMULATION)) {
        return createDevServerPlanStore(env);
    }
    return null;
}

export async function resolveServerPlanAccess(
    session: TeacherSession | null | undefined,
    options: { env?: Env; store?: ServerPlanStore | null; now?: Date } = {},
): Promise<ServerPlanAccess> {
    const now = options.now || new Date();
    if (!isTeacherSessionActive(session, now.getTime())) {
        return {
            authenticated: false,
            authoritative: false,
            plan: "free",
            source: "unavailable",
            error: "교사 로그인이 필요합니다.",
        };
    }

    const context = workspaceContextFromTeacherSession(session, now.getTime());
    const store = options.store === undefined
        ? createServerPlanStoreFromEnv(options.env || process.env)
        : options.store;
    if (!store) {
        return {
            authenticated: true,
            authoritative: false,
            organizationId: context.organizationId,
            actorUserId: context.actorUserId,
            plan: "free",
            source: "unavailable",
            error: "서버 플랜 저장소가 구성되지 않았습니다.",
        };
    }

    try {
        return {
            authenticated: true,
            authoritative: true,
            organizationId: context.organizationId,
            actorUserId: context.actorUserId,
            plan: await store.readPlan(context.organizationId) || "free",
            source: store.source,
        };
    } catch (error) {
        return {
            authenticated: true,
            authoritative: false,
            organizationId: context.organizationId,
            actorUserId: context.actorUserId,
            plan: "free",
            source: "unavailable",
            error: errorMessage(error),
        };
    }
}

export async function readServerPlanUsage(
    access: ServerPlanAccess,
    store: ServerPlanStore,
    now = new Date(),
): Promise<ServerPlanUsage> {
    if (!access.authoritative || !access.organizationId) throw new Error(access.error || "서버 플랜을 확인할 수 없습니다.");
    const period = seoulBillingPeriod(now);
    const [exams, students, aiRecognition] = await Promise.all([
        store.readUsage(access.organizationId, "exams", period),
        store.readUsage(access.organizationId, "students", STUDENT_USAGE_PERIOD),
        store.readUsage(access.organizationId, "aiRecognition", period),
    ]);
    return { exams, students, aiRecognition };
}

export function serverPlanUnavailableMessage(access: ServerPlanAccess): string {
    if (!access.authenticated) return "교사 로그인 후 다시 시도해주세요.";
    return access.error || "서버 플랜을 확인할 수 없어 안전을 위해 요청을 중단했습니다.";
}
